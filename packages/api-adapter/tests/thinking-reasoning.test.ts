import { describe, expect, it } from 'vitest';
import {
  createStreamingAdapter,
  transformRequest,
  transformResponse,
  withoutAdapterThinkingBlocks,
  type ServiceApiProtocol,
} from '../src/index.js';
import { parseSseBuffer } from '../src/utils.js';

const MESSAGES = 'anthropic-messages';
const CHAT = 'openai-chat-completions';
const RESPONSES = 'openai-responses';

const PATHS: Record<string, string> = {
  [MESSAGES]: '/v1/messages',
  [CHAT]: '/v1/chat/completions',
};

/** Whether the client asked for the model's reasoning: what `transformRequest` returns as `includeReasoning`. */
interface ClientOptions {
  includeReasoning?: boolean;
}

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
function translateBody(
  from: ServiceApiProtocol,
  to: ServiceApiProtocol,
  body: Json,
  streamRequested = false,
  { includeReasoning = true }: ClientOptions = {},
): Json | string {
  const result = transformResponse({
    requestId: 'req-thinking',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify(body)),
  }, { from, to, streamRequested, fallbackModel: 'example-model', includeReasoning });
  expect(result).not.toBeNull();
  const text = decoder.decode(result!.body);
  return streamRequested ? text : JSON.parse(text) as Json;
}

/** A seller's stream, one frame per chunk, as the client of `to` receives it. */
function translateStream(
  from: ServiceApiProtocol,
  to: ServiceApiProtocol,
  frames: string[],
  { includeReasoning = true }: ClientOptions = {},
): Json[] {
  const adapter = createStreamingAdapter({ from, to, fallbackModel: 'example-model', includeReasoning })!;
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
        : delta.type === 'signature_delta' ? delta.signature
          : delta.type === 'text_delta' ? delta.text
            : delta.partial_json;
      log.push(`${delta.type} ${event.index} ${body}`);
    } else if (event.type === 'content_block_stop') log.push(`stop ${event.index}`);
  }
  return log;
}

describe('thinking blocks in the history of a Messages request', () => {
  it('drops thinking blocks of earlier assistant turns that the adapter did not make', () => {
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
      { type: 'thinking', thinking: 'Light scatters.', signature: 'antseed.reasoning.v1:example-model#chatcmpl-1' },
      { type: 'text', text: 'Because of Rayleigh scattering.' },
    ]);
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
      'signature_delta 0 antseed.reasoning.v1:example-model#chatcmpl-1',
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
      'signature_delta 0 antseed.reasoning.v1:example-model#chatcmpl-1',
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
      'signature_delta 0 antseed.reasoning.v1:example-model#chatcmpl-1',
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
      'signature_delta 0 antseed.reasoning.v1:example-model#chatcmpl-1',
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
    expect(blockLog(events)).toEqual([
      'start 0 thinking',
      'thinking_delta 0 Only thoughts.',
      'signature_delta 0 antseed.reasoning.v1:example-model#chatcmpl-1',
      'stop 0',
    ]);
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

  it('joins two thinking blocks on a new line, streamed as buffered', () => {
    const buffered = translateBody(MESSAGES, CHAT, message([
      { type: 'thinking', thinking: 'First.', signature: 'sig' },
      { type: 'thinking', thinking: 'Second.', signature: 'sig' },
      { type: 'text', text: 'Hi' },
    ])) as Json;
    const events = translateStream(MESSAGES, CHAT, [
      anthropicFrame({ type: 'message_start', message: { id: 'msg_1', model: 'example-model', usage: { input_tokens: 10 } } }),
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'First.' } }),
      anthropicFrame({ type: 'content_block_stop', index: 0 }),
      anthropicFrame({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      anthropicFrame({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'Second.' } }),
      anthropicFrame({ type: 'content_block_stop', index: 1 }),
      anthropicFrame({ type: 'message_stop' }),
    ]);
    const streamed = events.map((event) => event.choices?.[0]?.delta?.reasoning_content).filter(Boolean).join('');
    expect(buffered.choices[0].message.reasoning_content).toBe('First.\nSecond.');
    expect(streamed).toBe('First.\nSecond.');
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

describe('thoughts a seller writes that the Messages client did not ask for', () => {
  const reply = (message: Json): Json => ({
    id: 'chatcmpl-1',
    model: 'example-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi', ...message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
  });

  it('reports includeReasoning for enabled and adaptive thinking only', () => {
    const flag = (thinking?: Json): boolean => {
      const result = transformRequest({
        requestId: 'r',
        method: 'POST',
        path: PATHS[MESSAGES]!,
        headers: {},
        body: encoder.encode(JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }], ...(thinking ? { thinking } : {}) })),
      }, { from: MESSAGES, to: CHAT });
      return result!.includeReasoning;
    };
    expect(flag({ type: 'enabled', budget_tokens: 2000 })).toBe(true);
    expect(flag({ type: 'adaptive' })).toBe(true);
    expect(flag({ type: 'disabled' })).toBe(false);
    expect(flag()).toBe(false);
  });

  it('leaves them out of a non-streamed Messages response, as before', () => {
    const body = translateBody(CHAT, MESSAGES, reply({ reasoning_content: 'Own thoughts.' }), false, { includeReasoning: false }) as Json;
    expect(body.content).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('leaves them out of a Messages stream built from a whole response, as before', () => {
    const sse = translateBody(CHAT, MESSAGES, reply({ reasoning_content: 'Own thoughts.' }), true, { includeReasoning: false }) as string;
    expect(blockLog(sseEvents(sse))).toEqual(['start 0 text', 'text_delta 0 Hi', 'stop 0']);
  });

  it('leaves them out of a Messages stream, and the text keeps index 0', () => {
    const events = translateStream(CHAT, MESSAGES, [
      chatFrame({ reasoning_content: 'Own thoughts.' }),
      chatFrame({ content: 'Hi' }),
      chatFrame({}, 'stop'),
      CHAT_DONE,
    ], { includeReasoning: false });
    expect(blockLog(events)).toEqual(['start 0 text', 'text_delta 0 Hi', 'stop 0']);
    expect(JSON.stringify(events)).not.toContain('thinking');
  });

  it('still gives a Chat client the thoughts of a native Messages seller', () => {
    const events = translateStream(MESSAGES, CHAT, [
      anthropicFrame({ type: 'message_start', message: { id: 'msg_1', model: 'example-model', usage: { input_tokens: 10 } } }),
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Own thoughts.' } }),
      anthropicFrame({ type: 'message_stop' }),
    ]);
    expect(JSON.stringify(events)).toContain('reasoning_content');
  });
});

describe('sealed reasoning a chat seller passes through, for a Messages client', () => {
  const MARKER = '__ENCRYPTED_REASONING__';
  const reply = (message: Json): Json => ({
    id: 'chatcmpl-1',
    model: 'example-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi', ...message }, finish_reason: 'stop' }],
  });

  it.each([
    { reasoning_content: `${MARKER}opaque` },
    { reasoning_content: 'opaque', reasoning_encrypted: true },
    { reasoning: `${MARKER}opaque` },
  ])('never becomes a thinking block in a buffered answer %j', (message) => {
    for (const stream of [false, true]) {
      const translated = JSON.stringify(translateBody(CHAT, MESSAGES, reply(message), stream));
      expect(translated).not.toContain('thinking');
      expect(translated).not.toContain('opaque');
    }
  });

  it.each([
    [{ reasoning_content: `${MARKER}opaque` }],
    [{ reasoning_content: 'opaque', reasoning_encrypted: true }],
  ])('never becomes a thinking block in a stream %j', (delta) => {
    const events = translateStream(CHAT, MESSAGES, [
      chatFrame(delta),
      chatFrame({ reasoning_content: 'more opaque' }),
      chatFrame({ content: 'Hi' }),
      chatFrame({}, 'stop'),
      CHAT_DONE,
    ]);
    expect(blockLog(events)).toEqual(['start 0 text', 'text_delta 0 Hi', 'stop 0']);
  });

  it('shows only the plain thoughts before the marker, wherever the marker is split across deltas', () => {
    for (let split = 1; split < MARKER.length; split++) {
      const events = translateStream(CHAT, MESSAGES, [
        chatFrame({ reasoning_content: `Plain. ${MARKER.slice(0, split)}` }),
        chatFrame({ reasoning_content: `${MARKER.slice(split)}opaque` }),
        chatFrame({ content: 'Hi' }),
        chatFrame({}, 'stop'),
        CHAT_DONE,
      ]);
      const thoughts = events
        .filter((event) => event.delta?.type === 'thinking_delta')
        .map((event) => event.delta.thinking as string)
        .join('');
      expect(thoughts, `marker split after ${split} characters`).toBe('Plain. ');
    }
  });
});

describe('a Messages seller\'s thinking, for a Responses client that keeps reasoning state', () => {
  const message: Json = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'example-model',
    content: [
      { type: 'thinking', thinking: 'Light scatters.', signature: 'sig' },
      { type: 'text', text: 'Because of Rayleigh scattering.' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 30 },
  };
  const frames = [
    anthropicFrame({ type: 'message_start', message: { id: 'msg_1', model: 'example-model', usage: { input_tokens: 10, output_tokens: 1 } } }),
    anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Light ' } }),
    anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'scatters.' } }),
    anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    anthropicFrame({ type: 'content_block_stop', index: 0 }),
    anthropicFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    anthropicFrame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Because of Rayleigh scattering.' } }),
    anthropicFrame({ type: 'content_block_stop', index: 1 }),
    anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }),
    anthropicFrame({ type: 'message_stop' }),
  ];
  const reasoningItem = {
    type: 'reasoning',
    id: 'rs_msg_1_0',
    summary: [],
    content: [{ type: 'reasoning_text', text: 'Light scatters.' }],
    encrypted_content: 'antseed.reasoning.v1:example-model',
  };

  it('gets the thoughts as a tagged reasoning item ahead of the message, buffered', () => {
    const body = translateBody(MESSAGES, RESPONSES, message) as Json;
    expect(body.output.map((item: Json) => item.type)).toEqual(['reasoning', 'message']);
    expect(body.output[0]).toEqual(reasoningItem);
  });

  it('gets the same output streamed as buffered', () => {
    const buffered = translateBody(MESSAGES, RESPONSES, message) as Json;
    const completed = translateStream(MESSAGES, RESPONSES, frames).find((event) => event.type === 'response.completed')!;
    expect(completed.response.output).toEqual(buffered.output);
    expect(completed.response.output_text).toBe(buffered.output_text);
  });

  it('gets no reasoning item when it keeps no reasoning state, streamed or buffered', () => {
    const buffered = translateBody(MESSAGES, RESPONSES, message, false, { includeReasoning: false }) as Json;
    const completed = translateStream(MESSAGES, RESPONSES, frames, { includeReasoning: false })
      .find((event) => event.type === 'response.completed')!;
    expect(buffered.output.map((item: Json) => item.type)).toEqual(['message']);
    expect(completed.response.output).toEqual(buffered.output);
  });
});

describe('thinking blocks only for a Messages request that switched thinking on', () => {
  /** What `transformRequest` tells the response side for a Messages request with these fields. */
  const includeReasoningFor = (fields: Json): boolean => transformRequest({
    requestId: 'req-thinking',
    method: 'POST',
    path: PATHS[MESSAGES]!,
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify({ model: 'example-model', max_tokens: 4096, messages: [{ role: 'user', content: 'Hi' }], ...fields })),
  }, { from: MESSAGES, to: CHAT })!.includeReasoning;

  const reply: Json = {
    id: 'chatcmpl-1',
    model: 'example-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi', reasoning_content: 'Light scatters.' }, finish_reason: 'stop' }],
  };
  const frames = [chatFrame({ reasoning_content: 'Light scatters.' }), chatFrame({ content: 'Hi' }), chatFrame({}, 'stop'), CHAT_DONE];

  it.each([
    ['absent', {}],
    ['disabled', { thinking: { type: 'disabled' } }],
  ])('makes no thinking block when thinking is %s, streamed or buffered', (_name, fields) => {
    const includeReasoning = includeReasoningFor(fields);
    expect(includeReasoning).toBe(false);
    for (const stream of [false, true]) {
      expect(JSON.stringify(translateBody(CHAT, MESSAGES, reply, stream, { includeReasoning }))).not.toContain('thinking');
    }
    expect(blockLog(translateStream(CHAT, MESSAGES, frames, { includeReasoning }))).toEqual(['start 0 text', 'text_delta 0 Hi', 'stop 0']);
  });

  it.each([
    ['enabled', { thinking: { type: 'enabled', budget_tokens: 2000 } }],
    ['adaptive', { thinking: { type: 'adaptive', display: 'updates' }, output_config: { effort: 'high' } }],
  ])('makes the thinking block when thinking is %s', (_name, fields) => {
    const includeReasoning = includeReasoningFor(fields);
    expect(includeReasoning).toBe(true);
    expect((translateBody(CHAT, MESSAGES, reply, false, { includeReasoning }) as Json).content[0].type).toBe('thinking');
    expect(blockLog(translateStream(CHAT, MESSAGES, frames, { includeReasoning }))[0]).toBe('start 0 thinking');
  });
});

describe('the signature of a thinking block the adapter made', () => {
  const TAG = 'antseed.reasoning.v1:';
  const reply = (id: string): Json => ({
    id,
    model: 'seller-label',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi', reasoning_content: 'Light scatters.' }, finish_reason: 'stop' }],
  });
  const frames = (id: string): string[] => [
    `data: ${JSON.stringify({ id, model: 'seller-label', choices: [{ index: 0, delta: { reasoning_content: 'Light scatters.' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id, model: 'seller-label', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] })}\n\n`,
    CHAT_DONE,
  ];
  const translate = (requestedModel: string, id: string) => {
    const result = transformResponse({
      requestId: 'req-signature',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify(reply(id))),
    }, { from: CHAT, to: MESSAGES, fallbackModel: requestedModel, includeReasoning: true })!;
    const adapter = createStreamingAdapter({ from: CHAT, to: MESSAGES, fallbackModel: requestedModel, includeReasoning: true })!;
    let sse = '';
    for (const frame of frames(id)) {
      for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode(frame), done: false })) sse += decoder.decode(out.data);
    }
    return { buffered: JSON.parse(decoder.decode(result.body)) as Json, streamed: sseEvents(sse) };
  };

  it('starts empty, gets one signature_delta before the block stops, and matches the buffered answer', () => {
    const { buffered, streamed } = translate('example-model', 'chatcmpl-1');
    const thinking = streamed.filter((event) => event.index === 0);
    expect(thinking[0]).toMatchObject({ type: 'content_block_start', content_block: { type: 'thinking', thinking: '', signature: '' } });
    const signatures = thinking.filter((event) => event.delta?.type === 'signature_delta');
    expect(signatures).toHaveLength(1);
    expect(thinking.at(-2)).toBe(signatures[0]);
    expect(thinking.at(-1)!.type).toBe('content_block_stop');
    expect(signatures[0]!.delta.signature).toBe(buffered.content[0].signature);
  });

  it('names the model the request asked for, after the tag, with the response id after a #', () => {
    const model = 'moonshotai/Kimi-K3.1-Pro:free';
    const { buffered } = translate(model, 'chatcmpl-1');
    expect(buffered.content[0].signature).toBe(`${TAG}${model}#chatcmpl-1`);
  });

  it('differs for every answer', () => {
    const first = translate('example-model', 'chatcmpl-1');
    const second = translate('example-model', 'chatcmpl-2');
    expect(first.buffered.content[0].signature).not.toBe(second.buffered.content[0].signature);
  });

  it('is short and cannot be read as base64', () => {
    const { buffered } = translate('example-model', 'chatcmpl-1');
    expect(buffered.content[0].signature.length).toBeLessThan(80);
    expect(() => atob(buffered.content[0].signature)).toThrow();
  });
});

describe('a thinking block the adapter made, sent back in a Messages request for a chat seller', () => {
  const TAG = 'antseed.reasoning.v1:';
  const toolTurn = (thinking: Json): Json[] => [
    { role: 'user', content: 'Q1' },
    {
      role: 'assistant',
      content: [
        thinking,
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 1 } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }] },
  ];
  const assistantOf = (model: string, thinking: Json): Json => sellerBody(CHAT, {
    model,
    messages: toolTurn(thinking),
    thinking: { type: 'adaptive' },
  }).messages[1];
  const tagged = (model: string, text = 'Need the tool.'): Json => ({ type: 'thinking', thinking: text, signature: `${TAG}${model}#chatcmpl-1` });

  it('goes back as reasoning_content on the assistant message it led to, for the same model', () => {
    expect(assistantOf('kimi-k3-1-pro', tagged('kimi-k3-1-pro'))).toEqual({
      role: 'assistant',
      content: 'Checking.',
      reasoning_content: 'Need the tool.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
    });
  });

  it('counts another spelling of the same model as the same model', () => {
    expect(assistantOf('moonshotai/Kimi-K3.1-Pro', tagged('kimi-k3.1-pro')).reasoning_content).toBe('Need the tool.');
  });

  it.each([
    ['another model', tagged('kimi-k3-fast')],
    ['no signature', { type: 'thinking', thinking: 'Need the tool.' }],
    ['an empty signature', { type: 'thinking', thinking: 'Need the tool.', signature: '' }],
    ['a signature from another provider', { type: 'thinking', thinking: 'Need the tool.', signature: 'EqQBCkYIBxgCKkA2b3Vy' }],
    ['the tag with no answer id', { type: 'thinking', thinking: 'Need the tool.', signature: `${TAG}kimi-k3-1-pro` }],
    ['sealed text', tagged('kimi-k3-1-pro', '__ENCRYPTED_REASONING__opaque')],
    ['a redacted_thinking block', { type: 'redacted_thinking', data: `${TAG}kimi-k3-1-pro#chatcmpl-1` }],
  ])('never goes back from %s', (_name, thinking) => {
    const assistant = assistantOf('kimi-k3-1-pro', thinking);
    expect(assistant).not.toHaveProperty('reasoning_content');
    expect(JSON.stringify(assistant)).not.toContain('opaque');
    expect(assistant.content).toBe('Checking.');
  });

  it('is dropped when nothing follows it in its message', () => {
    const body = sellerBody(CHAT, {
      model: 'kimi-k3-1-pro',
      messages: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: [tagged('kimi-k3-1-pro')] },
        { role: 'user', content: 'Q2' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('Need the tool.');
  });

  it('round-trips: the signature of a translated answer brings its thoughts back next turn', () => {
    const answer = translateBody(CHAT, MESSAGES, {
      id: 'chatcmpl-9',
      model: 'seller-label',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Checking.', reasoning_content: 'Need the tool.' }, finish_reason: 'stop' }],
    }) as Json;
    const body = sellerBody(CHAT, {
      messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: answer.content }, { role: 'user', content: 'Q2' }],
    });
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'Checking.', reasoning_content: 'Need the tool.' });
  });
});

describe('withoutAdapterThinkingBlocks: a Messages request for a native Messages seller', () => {
  const ours = { type: 'thinking', thinking: 'Our thoughts.', signature: 'antseed.reasoning.v1:example-model#chatcmpl-1' };
  const unsigned = { type: 'thinking', thinking: 'Unsigned thoughts.' };
  const anthropicSigned = { type: 'thinking', thinking: 'Real thoughts.', signature: 'EqQBCkYIBxgCKkA2b3Vy' };
  const redacted = { type: 'redacted_thinking', data: 'opaque' };
  const request = (body: Json, headers: Record<string, string> = {}) => ({
    requestId: 'req-strip',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', ...headers },
    body: encoder.encode(JSON.stringify(body)),
  });
  const messagesOf = (req: { body: Uint8Array }): Json[] => (JSON.parse(decoder.decode(req.body)) as Json).messages;

  it('removes the thinking blocks the adapter made, and keeps every other block', () => {
    const stripped = withoutAdapterThinkingBlocks(request({
      model: 'example-model',
      messages: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: [ours, { type: 'text', text: 'A1' }] },
        { role: 'user', content: 'Q2' },
        { role: 'assistant', content: [unsigned, anthropicSigned, redacted, { type: 'text', text: 'A2' }] },
        { role: 'user', content: 'Q3' },
      ],
    }));
    expect(messagesOf(stripped)).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: [unsigned, anthropicSigned, redacted, { type: 'text', text: 'A2' }] },
      { role: 'user', content: 'Q3' },
    ]);
  });

  it('drops an assistant message that held only the adapter\'s thinking', () => {
    const stripped = withoutAdapterThinkingBlocks(request({
      model: 'example-model',
      messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: [ours] }, { role: 'user', content: 'Q2' }],
    }));
    expect(messagesOf(stripped)).toEqual([{ role: 'user', content: 'Q1' }, { role: 'user', content: 'Q2' }]);
  });

  it('returns a request without the adapter\'s thinking unchanged, and fixes content-length when it rewrites one', () => {
    const untouched = request({ model: 'example-model', messages: [{ role: 'assistant', content: [unsigned, anthropicSigned] }] }, { 'content-length': '123' });
    expect(withoutAdapterThinkingBlocks(untouched)).toBe(untouched);

    const sized = request({ model: 'example-model', messages: [{ role: 'assistant', content: [ours, { type: 'text', text: 'A1' }] }] }, { 'Content-Length': '999' });
    const rewritten = withoutAdapterThinkingBlocks(sized);
    expect(rewritten.headers['Content-Length']).toBe(String(rewritten.body.length));
  });
});

describe('block indexes of a translated Messages stream', () => {
  const toolFrame = (index: number, id: string) => chatFrame({ tool_calls: [{ index, id, type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] });
  const SIGNATURE = 'signature_delta 0 antseed.reasoning.v1:example-model#chatcmpl-1';

  it('gives text after a tool call after thinking the next index, in order', () => {
    const events = translateStream(CHAT, MESSAGES, [
      chatFrame({ reasoning_content: 'Need a tool.' }),
      toolFrame(0, 'call_a'),
      chatFrame({ content: 'Done.' }),
      chatFrame({}, 'stop'),
      CHAT_DONE,
    ]);
    expect(blockLog(events)).toEqual([
      'start 0 thinking',
      'thinking_delta 0 Need a tool.',
      SIGNATURE,
      'stop 0',
      'start 1 tool_use',
      'input_json_delta 1 {"q":1}',
      'stop 1',
      'start 2 text',
      'text_delta 2 Done.',
      'stop 2',
    ]);
  });

  it('never reuses an index for a second text block', () => {
    const events = translateStream(CHAT, MESSAGES, [
      chatFrame({ content: 'First.' }),
      toolFrame(0, 'call_a'),
      chatFrame({ content: 'Second.' }),
      toolFrame(1, 'call_b'),
      chatFrame({}, 'tool_calls'),
      CHAT_DONE,
    ]);
    const starts = events.filter((event) => event.type === 'content_block_start').map((event) => `${event.index} ${event.content_block.type}`);
    expect(starts).toEqual(['0 text', '1 tool_use', '2 text', '3 tool_use']);
  });
});

describe('the same answer streamed and buffered', () => {
  it('for a Responses client of a Messages seller that thinks and calls a tool', () => {
    const message: Json = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'example-model',
      content: [
        { type: 'thinking', thinking: 'Need the tool.', signature: 'sig' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 30 },
    };
    const frames = [
      anthropicFrame({ type: 'message_start', message: { id: 'msg_2', model: 'example-model', usage: { input_tokens: 10, output_tokens: 1 } } }),
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the tool.' } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      anthropicFrame({ type: 'content_block_stop', index: 0 }),
      anthropicFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} } }),
      anthropicFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } }),
      anthropicFrame({ type: 'content_block_stop', index: 1 }),
      anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }),
      anthropicFrame({ type: 'message_stop' }),
    ];
    const buffered = translateBody(MESSAGES, RESPONSES, message) as Json;
    const completed = translateStream(MESSAGES, RESPONSES, frames).find((event) => event.type === 'response.completed')!;
    expect(buffered.output.map((item: Json) => item.type)).toEqual(['reasoning', 'function_call']);
    expect(completed.response.output).toEqual(buffered.output);
    expect(completed.response.end_turn).toBe(buffered.end_turn);
  });

  it('for a Messages client of a chat seller that thinks, writes and calls a tool', () => {
    const reply: Json = {
      id: 'chatcmpl-1',
      model: 'example-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          reasoning_content: 'Need the tool.',
          content: 'Checking.',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const live = translateStream(CHAT, MESSAGES, [
      chatFrame({ reasoning_content: 'Need the tool.' }),
      chatFrame({ content: 'Checking.' }),
      chatFrame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] }),
      chatFrame({}, 'tool_calls'),
      CHAT_DONE,
    ]);
    const whole = sseEvents(translateBody(CHAT, MESSAGES, reply, true) as string);
    const expected = [
      'start 0 thinking',
      'thinking_delta 0 Need the tool.',
      'signature_delta 0 antseed.reasoning.v1:example-model#chatcmpl-1',
      'stop 0',
      'start 1 text',
      'text_delta 1 Checking.',
      'stop 1',
      'start 2 tool_use',
      'input_json_delta 2 {"q":1}',
      'stop 2',
    ];
    expect(blockLog(live)).toEqual(expected);
    expect(blockLog(whole)).toEqual(expected);
  });
});
