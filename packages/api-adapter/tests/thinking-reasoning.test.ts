import { describe, expect, it } from 'vitest';
import {
  createStreamingAdapter,
  transformRequest,
  transformResponse,
  type ServiceApiProtocol,
} from '../src/index.js';
import { parseSseBuffer } from '../src/utils.js';

const MESSAGES = 'anthropic-messages';
const CHAT = 'openai-chat-completions';
const RESPONSES = 'openai-responses';

const PATHS: Record<string, string> = {
  [MESSAGES]: '/v1/messages',
  [CHAT]: '/v1/chat/completions',
  [RESPONSES]: '/v1/responses',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Json = Record<string, any>;

/** The body a seller speaking `to` receives for a Messages client request carrying `fields`. */
function sellerBody(to: ServiceApiProtocol, fields: Json, stream = false): Json {
  const result = transformRequest({
    requestId: 'req-thinking',
    method: 'POST',
    path: PATHS[MESSAGES]!,
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify({
      model: 'example-model',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Why is the sky blue?' }],
      stream,
      ...fields,
    })),
  }, { from: MESSAGES, to });
  expect(result).not.toBeNull();
  return JSON.parse(decoder.decode(result!.request.body)) as Json;
}

/** A non-streamed seller reply in `from`, as the client of `to` receives it. */
function translateBody(from: ServiceApiProtocol, to: ServiceApiProtocol, body: Json, streamRequested = false): Json | string {
  const result = transformResponse({
    requestId: 'req-thinking',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify(body)),
  }, { from, to, streamRequested, fallbackModel: 'example-model' });
  expect(result).not.toBeNull();
  const text = decoder.decode(result!.body);
  return streamRequested ? text : JSON.parse(text) as Json;
}

/** A seller's stream, one frame per chunk, as the client of `to` receives it. */
function translateStream(from: ServiceApiProtocol, to: ServiceApiProtocol, frames: string[]): Json[] {
  const adapter = createStreamingAdapter({ from, to, fallbackModel: 'example-model' })!;
  expect(adapter).not.toBeNull();
  let sse = '';
  for (const frame of frames) {
    for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode(frame), done: false })) sse += decoder.decode(out.data);
  }
  for (const out of adapter.adaptChunk({ requestId: 'r', data: new Uint8Array(0), done: true })) sse += decoder.decode(out.data);
  return sseEvents(sse);
}

function sseEvents(sse: string): Json[] {
  return parseSseBuffer(sse.endsWith('\n\n') ? sse : `${sse}\n\n`).events
    .filter((event) => event.data && event.data !== '[DONE]')
    .map((event) => JSON.parse(event.data) as Json);
}

const chatFrame = (delta: Json, finishReason: string | null = null, extra: Json = {}): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'example-model', choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`;

const CHAT_DONE = 'data: [DONE]\n\n';

const anthropicFrame = (data: Json): string => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

/** Compact view of a Messages stream: the block structure a client builds its message from. */
function blockLog(events: Json[]): string[] {
  const log: string[] = [];
  for (const event of events) {
    if (event.type === 'content_block_start') log.push(`start ${event.index} ${event.content_block.type}`);
    else if (event.type === 'content_block_delta') {
      const delta = event.delta;
      const body = delta.type === 'thinking_delta' ? delta.thinking
        : delta.type === 'text_delta' ? delta.text
          : delta.partial_json;
      log.push(`${delta.type} ${event.index} ${body}`);
    } else if (event.type === 'content_block_stop') log.push(`stop ${event.index}`);
  }
  return log;
}

describe('thinking in a Messages request, for a Chat Completions or Responses seller', () => {
  const SELLERS = [
    { to: CHAT, value: (level: string): unknown => level, key: 'reasoning_effort' },
    { to: RESPONSES, value: (level: string): unknown => ({ effort: level }), key: 'reasoning' },
  ] as const;

  for (const { to, value, key } of SELLERS) {
    it(`asks a ${to} seller for medium effort when thinking is enabled, whatever the budget`, () => {
      for (const budget of [500, 2000, 32000]) {
        for (const stream of [false, true]) {
          const body = sellerBody(to, { thinking: { type: 'enabled', budget_tokens: budget } }, stream);
          expect(body[key]).toEqual(value('medium'));
        }
      }
    });

    it(`asks a ${to} seller for medium effort when thinking is adaptive`, () => {
      expect(sellerBody(to, { thinking: { type: 'adaptive' } })[key]).toEqual(value('medium'));
    });

    it(`sends a ${to} seller no effort when thinking is disabled or absent`, () => {
      expect(key in sellerBody(to, { thinking: { type: 'disabled' } })).toBe(false);
      expect(key in sellerBody(to, {})).toBe(false);
    });

    it(`keeps an explicit output_config.effort over the medium default for a ${to} seller`, () => {
      const body = sellerBody(to, { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
      expect(body[key]).toEqual(value('low'));
    });

    it(`sends a ${to} seller no effort for disabled thinking even beside an output_config.effort`, () => {
      expect(key in sellerBody(to, { thinking: { type: 'disabled' }, output_config: { effort: 'high' } })).toBe(false);
    });
  }

  it('never derives a level from the thinking budget', () => {
    for (const budget of [1024, 2000, 8000, 16000, 64000]) {
      expect(sellerBody(CHAT, { thinking: { type: 'enabled', budget_tokens: budget } }).reasoning_effort).toBe('medium');
    }
  });

  it('lets a client name high to get thoughts from models that return none below it', () => {
    expect(sellerBody(CHAT, { thinking: { type: 'enabled', budget_tokens: 2000 }, output_config: { effort: 'high' } }).reasoning_effort).toBe('high');
  });

  it('drops thinking blocks of earlier assistant turns, whose signatures a seller could not check', () => {
    const body = sellerBody(CHAT, {
      messages: [
        { role: 'user', content: 'Q1' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'earlier thoughts', signature: 'sig' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'A1' },
          ],
        },
        { role: 'user', content: 'Q2' },
      ],
      thinking: { type: 'enabled', budget_tokens: 2000 },
    });
    expect(body.messages).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]);
  });
});

describe('Chat Completions reasoning, translated to a Messages response', () => {
  const reply = (message: Json): Json => ({
    id: 'chatcmpl-1',
    model: 'example-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Because of Rayleigh scattering.', ...message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
  });

  it.each(['reasoning_content', 'reasoning'])('puts %s in a thinking block before the text', (field) => {
    const body = translateBody(CHAT, MESSAGES, reply({ [field]: 'Light scatters.' })) as Json;
    expect(body.content).toEqual([
      { type: 'thinking', thinking: 'Light scatters.' },
      { type: 'text', text: 'Because of Rayleigh scattering.' },
    ]);
  });

  it('invents no signature', () => {
    const body = translateBody(CHAT, MESSAGES, reply({ reasoning_content: 'Light scatters.' })) as Json;
    expect(body.content[0]).not.toHaveProperty('signature');
  });

  it.each([{ reasoning_content: '' }, { reasoning_content: null }, { reasoning_content: '  \n' }, {}])(
    'makes no thinking block of empty reasoning %j',
    (message) => {
      const body = translateBody(CHAT, MESSAGES, reply(message)) as Json;
      expect(body.content).toEqual([{ type: 'text', text: 'Because of Rayleigh scattering.' }]);
    },
  );

  it('keeps the thinking block ahead of tool calls', () => {
    const body = translateBody(CHAT, MESSAGES, {
      ...reply({ reasoning_content: 'Need the tool.', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] }),
    }) as Json;
    expect(body.content.map((block: Json) => block.type)).toEqual(['thinking', 'tool_use']);
  });

  it('leaves usage untouched', () => {
    const plain = translateBody(CHAT, MESSAGES, reply({})) as Json;
    const withReasoning = translateBody(CHAT, MESSAGES, reply({ reasoning_content: 'Light scatters.' })) as Json;
    expect(withReasoning.usage).toEqual(plain.usage);
  });

  it('streams the thinking block first when the client asked for a stream of a whole reply', () => {
    const sse = translateBody(CHAT, MESSAGES, reply({ reasoning_content: 'Light scatters.' }), true) as string;
    expect(blockLog(sseEvents(sse))).toEqual([
      'start 0 thinking',
      'thinking_delta 0 Light scatters.',
      'stop 0',
      'start 1 text',
      'text_delta 1 Because of Rayleigh scattering.',
      'stop 1',
    ]);
  });
});

describe('Chat Completions reasoning stream, translated to a Messages stream', () => {
  it.each(['reasoning_content', 'reasoning'])('streams %s as thinking_delta before the text, with the text one index on', (field) => {
    const events = translateStream(CHAT, MESSAGES, [
      chatFrame({ role: 'assistant', content: '' }),
      chatFrame({ [field]: 'Light ' }),
      chatFrame({ [field]: 'scatters.' }),
      chatFrame({ content: 'Because ' }),
      chatFrame({ content: 'of Rayleigh.' }),
      chatFrame({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 } }),
      CHAT_DONE,
    ]);
    expect(blockLog(events)).toEqual([
      'start 0 thinking',
      'thinking_delta 0 Light ',
      'thinking_delta 0 scatters.',
      'stop 0',
      'start 1 text',
      'text_delta 1 Because ',
      'text_delta 1 of Rayleigh.',
      'stop 1',
    ]);
    expect(events[0]!.type).toBe('message_start');
    expect(events.at(-1)!.type).toBe('message_stop');
  });

  it('opens the thinking block only for a non-empty thought', () => {
    const events = translateStream(CHAT, MESSAGES, [
      chatFrame({ role: 'assistant', content: '', reasoning_content: '' }),
      chatFrame({ reasoning_content: '' }),
      chatFrame({ content: 'Hi' }),
      chatFrame({}, 'stop'),
      CHAT_DONE,
    ]);
    expect(blockLog(events)).toEqual(['start 0 text', 'text_delta 0 Hi', 'stop 0']);
  });

  it('numbers a tool call after the thinking block, and after thinking and text', () => {
    const toolFrame = chatFrame({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] });
    const thinkingThenTool = translateStream(CHAT, MESSAGES, [
      chatFrame({ reasoning_content: 'Need a tool.' }),
      toolFrame,
      chatFrame({}, 'tool_calls'),
      CHAT_DONE,
    ]);
    expect(blockLog(thinkingThenTool)).toEqual([
      'start 0 thinking',
      'thinking_delta 0 Need a tool.',
      'stop 0',
      'start 1 tool_use',
      'input_json_delta 1 {"q":1}',
      'stop 1',
    ]);

    const thinkingTextTool = translateStream(CHAT, MESSAGES, [
      chatFrame({ reasoning_content: 'Hmm.' }),
      chatFrame({ content: 'Checking.' }),
      toolFrame,
      chatFrame({}, 'tool_calls'),
      CHAT_DONE,
    ]);
    expect(blockLog(thinkingTextTool)).toEqual([
      'start 0 thinking',
      'thinking_delta 0 Hmm.',
      'stop 0',
      'start 1 text',
      'text_delta 1 Checking.',
      'stop 1',
      'start 2 tool_use',
      'input_json_delta 2 {"q":1}',
      'stop 2',
    ]);
  });

  it('closes a thinking block that no text follows', () => {
    const events = translateStream(CHAT, MESSAGES, [chatFrame({ reasoning_content: 'Only thoughts.' }), chatFrame({}, 'length'), CHAT_DONE]);
    expect(blockLog(events)).toEqual(['start 0 thinking', 'thinking_delta 0 Only thoughts.', 'stop 0']);
  });

  it('does not reopen or renumber blocks for thoughts that arrive after the text began', () => {
    const events = translateStream(CHAT, MESSAGES, [
      chatFrame({ content: 'Answer.' }),
      chatFrame({ reasoning_content: 'late thought' }),
      chatFrame({ content: ' More.' }),
      chatFrame({}, 'stop'),
      CHAT_DONE,
    ]);
    expect(blockLog(events)).toEqual(['start 0 text', 'text_delta 0 Answer.', 'text_delta 0  More.', 'stop 0']);
  });

  it('reads a thought split over two network chunks', () => {
    const frame = chatFrame({ reasoning_content: 'Light scatters.' });
    const events = translateStream(CHAT, MESSAGES, [frame.slice(0, 40), frame.slice(40), chatFrame({ content: 'Hi' }), chatFrame({}, 'stop'), CHAT_DONE]);
    expect(blockLog(events).slice(0, 2)).toEqual(['start 0 thinking', 'thinking_delta 0 Light scatters.']);
  });

  it('streams a reply with no reasoning exactly as before', () => {
    const events = translateStream(CHAT, MESSAGES, [chatFrame({ content: 'Hi' }), chatFrame({}, 'stop'), CHAT_DONE]);
    expect(blockLog(events)).toEqual(['start 0 text', 'text_delta 0 Hi', 'stop 0']);
    expect(JSON.stringify(events)).not.toContain('thinking');
  });
});

describe('a Messages response with thinking, translated to Chat Completions', () => {
  const message = (content: Json[]): Json => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'example-model',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 30 },
  });

  it('gives a thinking block as reasoning_content', () => {
    const body = translateBody(MESSAGES, CHAT, message([
      { type: 'thinking', thinking: 'Light scatters.', signature: 'sig' },
      { type: 'text', text: 'Because of Rayleigh scattering.' },
    ])) as Json;
    expect(body.choices[0].message.reasoning_content).toBe('Light scatters.');
    expect(body.choices[0].message.content).toBe('Because of Rayleigh scattering.');
  });

  it('adds no reasoning_content for redacted, empty or absent thinking', () => {
    for (const blocks of [
      [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'Hi' }],
      [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hi' }],
      [{ type: 'text', text: 'Hi' }],
    ]) {
      const body = translateBody(MESSAGES, CHAT, message(blocks)) as Json;
      expect(body.choices[0].message).not.toHaveProperty('reasoning_content');
    }
  });

  it('streams thinking_delta as delta.reasoning_content', () => {
    const events = translateStream(MESSAGES, CHAT, [
      anthropicFrame({ type: 'message_start', message: { id: 'msg_1', model: 'example-model', usage: { input_tokens: 10, output_tokens: 1 } } }),
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Light ' } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'scatters.' } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      anthropicFrame({ type: 'content_block_stop', index: 0 }),
      anthropicFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      anthropicFrame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } }),
      anthropicFrame({ type: 'content_block_stop', index: 1 }),
      anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }),
      anthropicFrame({ type: 'message_stop' }),
    ]);
    const deltas = events.map((event) => event.choices?.[0]?.delta).filter(Boolean) as Json[];
    expect(deltas.filter((delta) => 'reasoning_content' in delta).map((delta) => delta.reasoning_content)).toEqual(['Light ', 'scatters.']);
    expect(deltas.filter((delta) => delta.content).map((delta) => delta.content)).toEqual(['Hi']);
    const firstReasoning = deltas.findIndex((delta) => 'reasoning_content' in delta);
    const firstText = deltas.findIndex((delta) => delta.content);
    expect(firstReasoning).toBeLessThan(firstText);
  });

  it('streams a Chat reply with no reasoning without a reasoning_content member', () => {
    const events = translateStream(MESSAGES, CHAT, [
      anthropicFrame({ type: 'message_start', message: { id: 'msg_1', model: 'example-model', usage: { input_tokens: 10 } } }),
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
      anthropicFrame({ type: 'message_stop' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('reasoning');
  });
});
