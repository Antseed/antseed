import { describe, expect, it } from 'vitest';
import { transformResponse } from '../src/response-transform.js';
import { createStreamingAdapter } from '../src/stream-transform.js';
import type { ServiceApiProtocol } from '../src/types.js';
import { parseSseBuffer } from '../src/utils.js';

// Some chat sellers leak the model's think markup into `content`: a lone closing tag (`</mm:think>`, as one
// MiniMax-M3 seller sends it, alone or before the answer's text) or a whole `<think>…</think>` block.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Json = Record<string, any>;

const frame = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-t', model: 'example-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const TOOL_CALL = frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] });

/** The chat frames of an answer whose content arrives as these deltas. */
const contentFrames = (deltas: string[], toolCallFirst = false, finish = toolCallFirst ? 'tool_calls' : 'stop'): string[] => [
  frame({ role: 'assistant' }),
  ...(toolCallFirst ? [TOOL_CALL] : []),
  ...deltas.map((content) => frame({ content })),
  frame({}, finish),
];

/** The chat frames of an answer whose content starts with these deltas, then calls a tool with `args`. */
const contentThenToolFrames = (deltas: string[], args = '{"cmd":"ls"}', finish = 'tool_calls'): string[] => [
  frame({ role: 'assistant' }),
  ...deltas.map((content) => frame({ content })),
  frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: args } }] }),
  frame({}, finish),
];

function translateStream(to: ServiceApiProtocol, frames: string[]): Array<{ event: string | null; data: Json }> {
  const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to, fallbackModel: 'example-model', includeReasoning: true })!;
  let sse = '';
  for (const f of frames) for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode(f), done: false })) sse += decoder.decode(out.data);
  for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode('data: [DONE]\n\n'), done: true })) sse += decoder.decode(out.data);
  return parseSseBuffer(sse).events
    .filter((e) => e.data !== '[DONE]')
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) as Json }));
}

/** What a Responses client sees: the streamed text, the streamed reasoning, and the final output's item types. */
function responsesStream(frames: string[]): { text: string; reasoning: string; items: string[]; final: Json } {
  const events = translateStream('openai-responses', frames);
  const final = events.find((e) => e.event === 'response.completed' || e.event === 'response.incomplete')!.data.response as Json;
  return {
    text: events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join(''),
    reasoning: events.filter((e) => e.event === 'response.reasoning_text.delta').map((e) => e.data.delta).join(''),
    items: (final.output as Json[]).map((item) => item.type),
    final,
  };
}

/** The text a Messages client sees, and the block types it was given. */
function messagesStream(frames: string[]): { text: string; blocks: string[] } {
  const events = translateStream('anthropic-messages', frames);
  return {
    text: events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta').map((e) => e.data.delta.text).join(''),
    blocks: events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block.type),
  };
}

/** Every way to cut `text` into two deltas, and one character per delta. */
function everySplit(text: string): string[][] {
  const splits: string[][] = [];
  for (let at = 1; at < text.length; at++) splits.push([text.slice(0, at), text.slice(at)]);
  splits.push([...text]);
  return splits;
}

const chatBody = (content: string, reasoning?: string, withToolCall = false): Json => ({
  id: 'chatcmpl-t',
  object: 'chat.completion',
  model: 'example-model',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(withToolCall ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } : {}),
    },
    finish_reason: withToolCall ? 'tool_calls' : 'stop',
  }],
  usage: { prompt_tokens: 5, completion_tokens: 5 },
});

function translateBuffered(to: ServiceApiProtocol, body: Json, streamRequested = false): Uint8Array {
  return transformResponse(
    { requestId: 'r', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)) },
    { from: 'openai-chat-completions', to, streamRequested, fallbackModel: 'example-model', includeReasoning: true },
  )!.body;
}

const buffered = (to: ServiceApiProtocol, body: Json): Json => JSON.parse(decoder.decode(translateBuffered(to, body))) as Json;

// Each shape the leak takes, and what the client should get from it.
const SHAPES: Array<{ name: string; content: string; text: string; reasoning: string }> = [
  { name: 'a lone closing tag', content: '</mm:think>', text: '', reasoning: '' },
  { name: 'a closing tag before the text', content: '</mm:think>Now let me rerun the tests.', text: 'Now let me rerun the tests.', reasoning: '' },
  { name: 'a closing tag, a blank line, then the text', content: '</mm:think>\n\nDone.', text: 'Done.', reasoning: '' },
  { name: 'a lone plain closing tag', content: '</think>', text: '', reasoning: '' },
  { name: 'a whole mm:think block', content: '<mm:think>Check the tests first.</mm:think>Running them.', text: 'Running them.', reasoning: 'Check the tests first.' },
  { name: 'a whole think block after a newline', content: '\n<think>Plan it.\nThen do it.</think>\n\nHere is the plan.', text: 'Here is the plan.', reasoning: 'Plan it.\nThen do it.' },
];

describe('think markup leaked at the start of a chat answer', () => {
  describe.each(SHAPES)('$name', ({ content, text, reasoning }) => {
    it('is stripped from a streamed Responses answer however the deltas cut it, and its reasoning streams as reasoning', () => {
      for (const deltas of [[content], ...everySplit(content)]) {
        const seen = responsesStream(contentFrames(deltas));
        expect({ deltas, text: seen.text, reasoning: seen.reasoning }).toEqual({ deltas, text, reasoning });
        expect(seen.final.output_text).toBe(text);
        expect(seen.items).toEqual([...(reasoning ? ['reasoning'] : []), ...(text ? ['message'] : [])]);
      }
    });

    it('is stripped from a streamed Messages answer however the deltas cut it', () => {
      for (const deltas of [[content], ...everySplit(content)]) {
        const seen = messagesStream(contentFrames(deltas));
        expect({ deltas, text: seen.text }).toEqual({ deltas, text });
        expect(seen.blocks).toEqual(text ? ['text'] : []);
      }
    });

    it('is stripped from a buffered Responses and Messages answer, streamed to the client or not', () => {
      const responses = buffered('openai-responses', chatBody(content));
      expect(responses.output_text).toBe(text);
      expect(responses.output.map((item: Json) => item.type)).toEqual([...(reasoning ? ['reasoning'] : []), ...(text ? ['message'] : [])]);
      if (reasoning) expect(responses.output[0].content).toEqual([{ type: 'reasoning_text', text: reasoning }]);

      const messages = buffered('anthropic-messages', chatBody(content));
      expect(messages.content).toEqual(text ? [{ type: 'text', text }] : []);

      const sse = decoder.decode(translateBuffered('openai-responses', chatBody(content), true));
      expect(sse).not.toContain('think>');
    });
  });

  it('is stripped when the text starts after a tool call, as it did in the captured streams', () => {
    const seen = responsesStream(contentFrames(['</mm:think>'], true));
    expect(seen.text).toBe('');
    expect(seen.items).toEqual(['function_call']);
    expect(seen.final.output[0]).toMatchObject({ name: 'exec_command', arguments: '{"cmd":"ls"}' });
    expect(seen.final.end_turn).toBe(false);

    const answer = buffered('openai-responses', chatBody('</mm:think>', undefined, true));
    expect(answer.output.map((item: Json) => item.type)).toEqual(['function_call']);
  });

  it('adds a block\'s reasoning after the reasoning the seller sent beside it', () => {
    const answer = buffered('openai-responses', chatBody('<think>Second.</think>Answer.', 'First. '));
    expect(answer.output[0].content).toEqual([{ type: 'reasoning_text', text: 'First. Second.' }]);
    expect(answer.output_text).toBe('Answer.');
  });

  it('is reasoning when it never closes because the answer was cut inside it, streamed and buffered', () => {
    for (const deltas of [['<think>Still ', 'thinking</th'], ...everySplit('<think>Still thinking</th')]) {
      const seen = responsesStream(contentFrames(deltas, false, 'length'));
      expect({ deltas, text: seen.text, reasoning: seen.reasoning }).toEqual({ deltas, text: '', reasoning: 'Still thinking</th' });
      expect(seen.final.status).toBe('incomplete');
    }
    const answer = buffered('openai-responses', { ...chatBody('<think>Still thinking</th'), choices: [{ ...chatBody('').choices[0], message: { role: 'assistant', content: '<think>Still thinking</th' }, finish_reason: 'length' }] });
    expect(answer.output_text).toBe('');
    expect(answer.output[0].content).toEqual([{ type: 'reasoning_text', text: 'Still thinking</th' }]);
  });

  it('is reasoning when a tool call follows a block that never closed, streamed and buffered', () => {
    const seen = responsesStream(contentThenToolFrames(['<think>Plan ', 'it.']));
    expect(seen).toMatchObject({ text: '', reasoning: 'Plan it.', items: ['reasoning', 'function_call'] });
    const answer = buffered('openai-responses', chatBody('<think>Plan it.', undefined, true));
    expect(answer.output.map((item: Json) => item.type)).toEqual(['reasoning', 'function_call']);
    expect(answer.output[0].content).toEqual([{ type: 'reasoning_text', text: 'Plan it.' }]);
  });
});

describe('text held at the start of an answer when a tool call begins', () => {
  // Whitespace or the start of a tag could still become think markup; a tool call settles it as text.
  const HELD = ['\n\n', ' ', '<', '</mm:', '\n</thi'];

  it.each(HELD)('streams %j to a Messages client before the tool call, each block at its own index', (held) => {
    const events = translateStream('anthropic-messages', contentThenToolFrames([held]));
    const starts = events.filter((e) => e.event === 'content_block_start').map((e) => [e.data.index, e.data.content_block.type]);
    expect(starts).toEqual([[0, 'text'], [1, 'tool_use']]);
    const deltas = events.filter((e) => e.event === 'content_block_delta').map((e) => [e.data.index, e.data.delta.type]);
    expect(deltas).toEqual([[0, 'text_delta'], [1, 'input_json_delta']]);
    expect(messagesStream(contentThenToolFrames([held])).text).toBe(held);
  });

  it.each(HELD)('streams %j to a Responses client before the tool call, in the order the buffered answer has', (held) => {
    const events = translateStream('openai-responses', contentThenToolFrames([held]));
    const added = events.filter((e) => e.event === 'response.output_item.added').map((e) => [e.data.output_index, e.data.item.type]);
    expect(added).toEqual([[0, 'message'], [1, 'function_call']]);
    const final = events.find((e) => e.event === 'response.completed')!.data.response;
    const bufferedAnswer = buffered('openai-responses', chatBody(held, undefined, true));
    expect(final.output.map((item: Json) => item.type)).toEqual(bufferedAnswer.output.map((item: Json) => item.type));
    expect(final.output_text).toBe(held);
  });

  it('marks only the cut tool call incomplete when the cap falls inside its arguments', () => {
    const events = translateStream('openai-responses', contentThenToolFrames(['\n\n'], '{"cmd":', 'length'));
    const final = events.find((e) => e.event === 'response.incomplete')!.data.response;
    expect(final.output.map((item: Json) => [item.type, item.status])).toEqual([['message', 'completed'], ['function_call', 'incomplete']]);
  });

  it('still strips a lone closing tag that comes after the tool call', () => {
    const seen = responsesStream([
      frame({ role: 'assistant' }), frame({ content: '\n' }), TOOL_CALL, frame({ content: '</mm:think>' }), frame({}, 'tool_calls'),
    ]);
    expect(seen.text).toBe('\n');
  });
});

describe('think markup that is part of the answer', () => {
  const KEPT = [
    'The `</think>` tag closes a reasoning block.',
    'Models wrap reasoning in <think>…</think> tags.',
    '```xml\n<think>example</think>\n```',
    '`<think>` starts a block.',
    'Let me check.</mm:think>',
    '<thinking>is not a think tag</thinking>',
    '<think',
    '</mm:thin',
    '<thinkpad> is a laptop.',
    '<think> is the tag DeepSeek models wrap reasoning in.',
    '<mm:think>',
    '  \n',
    'Plain answer.',
  ];

  it.each(KEPT)('is kept unchanged, streamed however the deltas cut it, and sent once: %j', (content) => {
    for (const deltas of [[content], ...everySplit(content)]) {
      const seen = responsesStream(contentFrames(deltas));
      expect({ deltas, text: seen.text, reasoning: seen.reasoning, items: seen.items }).toEqual({ deltas, text: content, reasoning: '', items: ['message'] });
      expect({ deltas, text: messagesStream(contentFrames(deltas)).text }).toEqual({ deltas, text: content });
    }
  });

  it.each(KEPT)('is kept unchanged in a buffered answer, and sent once: %j', (content) => {
    const answer = buffered('openai-responses', chatBody(content));
    expect(answer.output_text).toBe(content);
    expect(answer.output.map((item: Json) => item.type)).toEqual(['message']);
    expect(buffered('anthropic-messages', chatBody(content)).content).toEqual([{ type: 'text', text: content }]);
  });

  it('is stripped only once, at the start: a second closing tag stays', () => {
    expect(responsesStream(contentFrames(['</mm:think>Before </mm:think> after.'])).text).toBe('Before </mm:think> after.');
    expect(buffered('openai-responses', chatBody('</mm:think>Before </mm:think> after.')).output_text).toBe('Before </mm:think> after.');
  });
});

describe('think markup on a passthrough answer', () => {
  it('is left byte for byte', () => {
    const response = {
      requestId: 'r',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify(chatBody('</mm:think>Hi.'))),
    };
    expect(transformResponse(response, { from: 'openai-chat-completions', to: 'openai-chat-completions' })).toBe(response);
    expect(createStreamingAdapter({ from: 'openai-chat-completions', to: 'openai-chat-completions' })).toBeNull();
  });
});

describe('think markup split across the text blocks of a buffered Messages answer', () => {
  const messagesAnswer = (texts: string[], withToolCall = false): Json => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'example-model',
    content: [
      ...texts.map((text) => ({ type: 'text', text })),
      ...(withToolCall ? [{ type: 'tool_use', id: 'toolu_1', name: 'exec_command', input: { cmd: 'ls' } }] : []),
    ],
    stop_reason: withToolCall ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5 },
  });
  const translate = (body: Json, streamRequested: boolean): Uint8Array => transformResponse(
    { requestId: 'r', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)) },
    { from: 'anthropic-messages', to: 'openai-responses', streamRequested, fallbackModel: 'example-model', includeReasoning: true },
  )!.body;

  it('is stripped as one text, as the stream strips it, sent as JSON or as a stream', () => {
    const answer = JSON.parse(decoder.decode(translate(messagesAnswer(['<think>Plan', ' it.</think>', 'Answer.']), false))) as Json;
    expect(answer.output_text).toBe('Answer.');
    expect(answer.output_text).not.toContain('think>');

    const sse = decoder.decode(translate(messagesAnswer(['<think>Plan', ' it.</think>', 'Answer.']), true));
    expect(sse).not.toContain('think>');
    expect(sse).toContain('Answer.');
  });

  it('keeps a lone closing tag in a later block when the first block is real text', () => {
    const answer = JSON.parse(decoder.decode(translate(messagesAnswer(['Hello. ', '</think>']), false))) as Json;
    expect(answer.output_text).toBe('Hello. </think>');
  });

  it('strips a closing tag that follows leading whitespace in another block, as the stream does', () => {
    const answer = JSON.parse(decoder.decode(translate(messagesAnswer(['\n', '</mm:think>'], true), false))) as Json;
    expect(answer.output.map((item: Json) => item.type)).toEqual(['function_call']);
  });
});
