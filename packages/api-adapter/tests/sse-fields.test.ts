import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreamingAdapter } from '../src/stream-transform.js';
import { parseSseBlock, parseSseBuffer, splitSseBlocks, type ParsedSseEvent } from '../src/utils.js';

type TextProtocol = 'openai-chat-completions' | 'anthropic-messages' | 'openai-responses';
type Frame = { event?: string; data: unknown };
type JsonObject = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One way an upstream may legally write the same frames. */
interface WireForm {
  space?: '' | ' ';
  eol?: '\n' | '\r\n' | '\r';
  /** Comments, and the fields a translation has no use for, before each frame. */
  noise?: boolean;
  /** Pretty-printed JSON, so one frame's data spans several `data` lines. */
  multiLineData?: boolean;
  bom?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PROTOCOLS: TextProtocol[] = ['openai-chat-completions', 'anthropic-messages', 'openai-responses'];
const PAIRS = PROTOCOLS.flatMap((from) => PROTOCOLS.filter((to) => to !== from).map((to) => [from, to] as const));

// The check mark is three bytes in UTF-8, so a network split can land inside it.
const ANSWER = 'Hello there ✓';
const INPUT_TOKENS = 1200;
const OUTPUT_TOKENS = 300;
const FINISH: Record<TextProtocol, string> = {
  'openai-chat-completions': 'stop',
  'anthropic-messages': 'end_turn',
  'openai-responses': 'completed',
};

const chatFrame = (choices: unknown[], usage?: Record<string, number>): Frame => ({
  data: { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'm', choices, ...(usage ? { usage } : {}) },
});

const SOURCE_STREAMS: Record<TextProtocol, (text: string) => Frame[]> = {
  'openai-chat-completions': (text) => [
    chatFrame([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    chatFrame([{ index: 0, delta: { content: text }, finish_reason: null }]),
    chatFrame([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    chatFrame([], { prompt_tokens: INPUT_TOKENS, completion_tokens: OUTPUT_TOKENS, total_tokens: INPUT_TOKENS + OUTPUT_TOKENS }),
    { data: '[DONE]' },
  ],
  'anthropic-messages': (text) => [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null,
          usage: { input_tokens: INPUT_TOKENS, output_tokens: 0 },
        },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: OUTPUT_TOKENS } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ],
  'openai-responses': (text) => [
    { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1', model: 'm', status: 'in_progress', output: [] } } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text } },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_1', model: 'm', status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS, total_tokens: INPUT_TOKENS + OUTPUT_TOKENS },
        },
      },
    },
  ],
};

function wire(frames: Frame[], { space = ' ', eol = '\n', noise = false, multiLineData = false, bom = false }: WireForm = {}): Uint8Array {
  const body = frames.map((frame) => {
    const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data, null, multiLineData ? 2 : undefined);
    return [
      ...(noise ? [': keep-alive', ':', 'id: 7', 'retry: 3000', 'unknown: field', 'bare-name'] : []),
      ...(frame.event ? [`event:${space}${frame.event}`] : []),
      ...data.split('\n').map((line) => `data:${space}${line}`),
      '',
      '',
    ].join(eol);
  }).join('');
  return encoder.encode(`${bom ? '\uFEFF' : ''}${body}`);
}

/** Feeds the chunks through a stream adapter the way a relay does, ending with an empty done chunk. */
function translate(from: TextProtocol, to: TextProtocol, chunks: Uint8Array[]): string {
  const adapter = createStreamingAdapter({ from, to, fallbackModel: 'm' });
  expect(adapter).not.toBeNull();
  const written: string[] = [];
  const feed = (data: Uint8Array, done: boolean): void => {
    for (const out of adapter!.adaptChunk({ requestId: 'r', data, done })) written.push(decoder.decode(out.data));
  };
  for (const chunk of chunks) feed(chunk, false);
  feed(new Uint8Array(0), true);
  return written.join('');
}

/** What a client of `to` reads from the frames a renderer wrote: `event: x\ndata: y\n\n`, one data line each. */
function answerOf(to: TextProtocol, written: string): { text: string; finish: unknown; inputTokens: unknown; outputTokens: unknown } {
  const events = written
    .split('\n\n')
    .filter((block) => block.length > 0)
    .map((block) => block.split('\n').at(-1)!.slice('data: '.length))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as JsonObject);

  if (to === 'openai-chat-completions') {
    const choices = events.map((event) => event.choices?.[0]);
    const usage = events.find((event) => event.usage)?.usage;
    return {
      text: choices.map((choice) => choice?.delta?.content ?? '').join(''),
      finish: choices.find((choice) => choice?.finish_reason)?.finish_reason ?? null,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
    };
  }
  if (to === 'anthropic-messages') {
    const closing = events.find((event) => event.type === 'message_delta');
    return {
      text: events.filter((event) => event.type === 'content_block_delta').map((event) => event.delta.text).join(''),
      finish: closing?.delta.stop_reason ?? null,
      inputTokens: closing?.usage.input_tokens,
      outputTokens: closing?.usage.output_tokens,
    };
  }
  const completed = events.find((event) => event.type === 'response.completed')?.response;
  return {
    text: events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''),
    finish: completed?.status ?? null,
    inputTokens: completed?.usage.input_tokens,
    outputTokens: completed?.usage.output_tokens,
  };
}

const expectedAnswer = (to: TextProtocol, text = ANSWER) => ({
  text,
  finish: FINISH[to],
  inputTokens: INPUT_TOKENS,
  outputTokens: OUTPUT_TOKENS,
});

const WIRE_FORMS: Array<[string, WireForm]> = [
  ['no space after the colon', { space: '' }],
  ['CRLF line endings', { eol: '\r\n' }],
  ['CR line endings', { eol: '\r' }],
  ['no space and CRLF line endings', { space: '', eol: '\r\n' }],
  ['no space and CR line endings', { space: '', eol: '\r' }],
  ['comments, id, retry and other fields', { noise: true }],
  ['data over several lines', { multiLineData: true }],
  ['a byte order mark', { bom: true }],
  ['all of them at once', { space: '', eol: '\r\n', noise: true, multiLineData: true, bom: true }],
];

describe('translated streams read SSE as the standard defines it', () => {
  // Renderers stamp their frames with the time, and these tests compare whole outputs.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(PAIRS)('from %s to %s', (from, to) => {
    const frames = SOURCE_STREAMS[from](ANSWER);

    it('delivers the answer from a stream with a space after each colon', () => {
      expect(answerOf(to, translate(from, to, [wire(frames)]))).toEqual(expectedAnswer(to));
    });

    it('delivers the answer from a stream with no space after the colon', () => {
      expect(answerOf(to, translate(from, to, [wire(frames, { space: '' })]))).toEqual(expectedAnswer(to));
    });

    it('delivers the answer one frame per chunk with no space after the colon', () => {
      const chunks = frames.map((frame) => wire([frame], { space: '' }));
      expect(answerOf(to, translate(from, to, chunks))).toEqual(expectedAnswer(to));
    });

    it.each(WIRE_FORMS)('translates a stream with %s like the plain form', (_name, form) => {
      expect(translate(from, to, [wire(frames, form)])).toBe(translate(from, to, [wire(frames)]));
    });
  });

  it.each(['anthropic-messages', 'openai-responses'] as const)('reads the event field with no space from %s', (from) => {
    const to = 'openai-chat-completions';
    // With no `type` in the data, the event field is all that names each frame.
    const frames = SOURCE_STREAMS[from](ANSWER).map(({ event, data }) => {
      const { type: _type, ...rest } = data as JsonObject;
      return { event, data: rest };
    });
    expect(answerOf(to, translate(from, to, [wire(frames, { space: '' })]))).toEqual(expectedAnswer(to));
  });

  describe.each(PROTOCOLS)('from %s, however the network splits it', (from) => {
    const to: TextProtocol = from === 'openai-chat-completions' ? 'anthropic-messages' : 'openai-chat-completions';
    const frames = SOURCE_STREAMS[from](ANSWER);

    it.each([['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const)('reads a %s stream the same at any split', (_name, eol) => {
      const expected = translate(from, to, [wire(frames)]);
      const bytes = wire(frames, { space: '', eol });
      for (let at = 1; at < bytes.length; at += 1) {
        expect(translate(from, to, [bytes.subarray(0, at), bytes.subarray(at)]), `split at byte ${at}`).toBe(expected);
      }
      expect(translate(from, to, Array.from(bytes, (byte) => Uint8Array.of(byte))), 'one byte per chunk').toBe(expected);
    });
  });

  describe.each(PAIRS)('frames written from %s to %s', (from, to) => {
    // Line breaks and field-like text in the answer must stay inside one JSON line.
    const text = 'two\nlines\r\nand a\rreturn\n\ndata: not a field\n\nevent: nor this';

    it('stay standard: one data line per frame, LF line ends, nothing left open', () => {
      const written = translate(from, to, [wire(SOURCE_STREAMS[from](text))]);
      expect(written).not.toContain('\r');
      expect(written.endsWith('\n\n')).toBe(true);
      for (const block of written.slice(0, -2).split('\n\n')) {
        expect(block).toMatch(/^(event: [\w.]+\n)?data: [^\n]+$/);
      }
      expect(answerOf(to, written)).toEqual(expectedAnswer(to, text));
    });

    it('name each frame as the target standard does', () => {
      const written = translate(from, to, [wire(SOURCE_STREAMS[from](text))]);
      for (const block of written.slice(0, -2).split('\n\n')) {
        const [first, second] = block.split('\n');
        if (to === 'openai-chat-completions' || first === 'data: [DONE]') {
          expect(first).toMatch(/^data: /);
          expect(second).toBeUndefined();
        } else {
          expect(first).toBe(`event: ${(JSON.parse(second!.slice('data: '.length)) as JsonObject).type}`);
        }
      }
    });
  });

  describe.each(PAIRS)('from %s to %s, as the stream arrives', (from, to) => {
    it.each([['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const)('delivers text once its frame is complete, with %s line ends', (_name, eol) => {
      const adapter = createStreamingAdapter({ from, to, fallbackModel: 'm' })!;
      const feed = (data: Uint8Array): string => adapter.adaptChunk({ requestId: 'r', data, done: false })
        .map((out) => decoder.decode(out.data))
        .join('');
      const frames = SOURCE_STREAMS[from](ANSWER);
      const textAt = frames.findIndex((frame) => JSON.stringify(frame.data).includes(ANSWER));
      const textFrame = wire([frames[textAt]!], { space: '', eol });
      const blankLine = textFrame.length - eol.length;

      let written = frames.slice(0, textAt).map((frame) => feed(wire([frame], { space: '', eol }))).join('');
      written += feed(textFrame.subarray(0, blankLine));
      expect(answerOf(to, written).text).toBe('');
      written += feed(textFrame.subarray(blankLine));
      expect(answerOf(to, written).text).toBe(ANSWER);
    });

    it.each([['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const)('does not deliver a frame left unfinished when the stream ends, with %s line ends', (_name, eol) => {
      const frames = SOURCE_STREAMS[from](ANSWER);
      const textAt = frames.findIndex((frame) => JSON.stringify(frame.data).includes(ANSWER));
      const textFrame = wire([frames[textAt]!], { space: '', eol });
      const chunks = [...frames.slice(0, textAt).map((frame) => wire([frame], { space: '', eol })), textFrame.subarray(0, textFrame.length - eol.length)];
      expect(answerOf(to, translate(from, to, chunks)).text).toBe('');
    });
  });
});

describe('splitSseBlocks', () => {
  it('returns the complete blocks with LF line ends and keeps the rest', () => {
    expect(splitSseBlocks('a:1\r\nb:2\r\n\r\nc:3\r\rd:4')).toEqual({ blocks: ['a:1\nb:2', 'c:3'], remainder: 'd:4' });
  });

  it('keeps a CR at the very end as a CR', () => {
    expect(splitSseBlocks('a:1\r')).toEqual({ blocks: [], remainder: 'a:1\r' });
    expect(splitSseBlocks('a:1\r\r')).toEqual({ blocks: ['a:1'], remainder: '\r' });
  });
});

describe('parseSseBlock', () => {
  it('reads the fields of one block', () => {
    expect(parseSseBlock('event:e\ndata:x')).toEqual({ event: 'e', data: 'x' });
  });

  it('finds no event in a block with no data', () => {
    expect(parseSseBlock(': keep-alive')).toBeNull();
    expect(parseSseBlock('event:e')).toBeNull();
  });
});

describe('parseSseBuffer', () => {
  const frame = (data: string, event: string | null = null): ParsedSseEvent => ({ event, data });

  /** Reads the chunks one after another, carrying the remainder as the stream readers do. */
  const fed = (...chunks: string[]): ParsedSseEvent[] => {
    const events: ParsedSseEvent[] = [];
    let buffer = '';
    for (const chunk of chunks) {
      const parsed = parseSseBuffer(buffer + chunk);
      events.push(...parsed.events);
      buffer = parsed.remainder;
    }
    return events;
  };

  it.each<[string, string, ParsedSseEvent[]]>([
    ['a data field with no space', 'data:x\n\n', [frame('x')]],
    ['a data field with one space', 'data: x\n\n', [frame('x')]],
    ['only one leading space as the separator', 'data:  x\n\n', [frame(' x')]],
    ['an event field with no space', 'event:e\ndata:x\n\n', [frame('x', 'e')]],
    ['an event field with one space', 'event: e\ndata: x\n\n', [frame('x', 'e')]],
    ['only the first colon as the end of the name', 'data:a:b: c\n\n', [frame('a:b: c')]],
    ['an empty data field', 'data:\n\n', [frame('')]],
    ['a data line with no colon as an empty value', 'data\n\n', [frame('')]],
    ['several data lines joined with LF', 'data:a\ndata: b\n\n', [frame('a\nb')]],
    ['an empty line inside multi-line data', 'data:a\ndata\ndata:b\n\n', [frame('a\n\nb')]],
    ['the last event field', 'event:a\nevent:b\ndata:x\n\n', [frame('x', 'b')]],
    ['an empty event field as no name', 'event:\ndata:x\n\n', [frame('x')]],
    ['an event line with no colon as no name', 'event\ndata:x\n\n', [frame('x')]],
    ['an event name only for its own frame', 'event:a\n\ndata:x\n\n', [frame('x')]],
    ['comments as nothing', ': one\n:two\ndata:x\n\n', [frame('x')]],
    ['id and retry as nothing', 'id: 7\nretry: 3000\ndata:x\n\n', [frame('x')]],
    ['a frame with no data as no event', 'event:e\nid:7\n: c\n\n', []],
    ['only the exact data field name', 'dataset:x\nData:x\n data:x\n\n', []],
    ['only the exact event field name', 'events:y\nEvent:y\n event:y\ndata:x\n\n', [frame('x')]],
    ['extra blank lines as nothing', '\n\ndata:a\n\n\n\ndata:b\n\n', [frame('a'), frame('b')]],
  ])('reads %s', (_name, input, events) => {
    expect(parseSseBuffer(input)).toEqual({ events, remainder: '' });
  });

  it.each([
    ['LF', 'event:e\ndata:a\ndata:b\n\ndata:c\n\n'],
    ['CRLF', 'event:e\r\ndata:a\r\ndata:b\r\n\r\ndata:c\r\n\r\n'],
    ['CR', 'event:e\rdata:a\rdata:b\r\rdata:c\r\r'],
    ['a mix', 'event:e\ndata:a\r\ndata:b\r\n\rdata:c\r\n\n'],
  ])('ends lines at %s', (_name, input) => {
    expect(parseSseBuffer(input).events).toEqual([frame('a\nb', 'e'), frame('c')]);
  });

  it('keeps an unfinished frame for the next chunk', () => {
    expect(parseSseBuffer('data:a\n')).toEqual({ events: [], remainder: 'data:a\n' });
    expect(parseSseBuffer('data:a\n\ndata:b')).toEqual({ events: [frame('a')], remainder: 'data:b' });
  });

  it('reads a line split inside its name, after the colon, or after the space', () => {
    expect(fed('da', 'ta', ':', ' ', 'a', '\n', '\n')).toEqual([frame('a')]);
  });

  it('does not read a CRLF split across chunks as two line ends', () => {
    expect(fed('data:a\r', '\ndata:b\r\n\r\n')).toEqual([frame('a\nb')]);
  });

  it('holds a split CRLF through an empty chunk', () => {
    expect(fed('data:a\r', '', '\ndata:b\r\n\r\n')).toEqual([frame('a\nb')]);
  });

  it('delivers a frame as soon as a CR ends its blank line', () => {
    expect(fed('data:a\r\r')).toEqual([frame('a')]);
  });

  it('skips the LF of a blank CRLF line split from its CR', () => {
    expect(fed('data:a\r\n\r', '\ndata:b\r\n\r\n')).toEqual([frame('a'), frame('b')]);
  });
});
