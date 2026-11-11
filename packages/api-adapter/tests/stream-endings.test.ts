import { describe, expect, it } from 'vitest';
import { transformResponse } from '../src/response-transform.js';
import { createStreamingAdapter } from '../src/stream-transform.js';
import type { ServiceApiProtocol } from '../src/types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SseEvent {
  event: string | null;
  data: string;
}

type Json = Record<string, any>;

const CHAT = 'openai-chat-completions' satisfies ServiceApiProtocol;
const MESSAGES = 'anthropic-messages' satisfies ServiceApiProtocol;
const RESPONSES = 'openai-responses' satisfies ServiceApiProtocol;
type StreamProtocol = typeof CHAT | typeof MESSAGES | typeof RESPONSES;

/** What the client is told when the stream ended without saying how. */
const CUT_OFF = 'The upstream ended the stream before the response finished';
/** The frame a seller's relay appends when reading the upstream fails. */
const RELAY_ERROR_FRAME = 'event: error\ndata: terminated\n\n';

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split('\n');
      return {
        event: lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? null,
        data: lines.find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? '',
      };
    });
}

/** Feeds an adapter the way a seller's relay does: the upstream's frames one by one, then an empty final chunk. */
function translate(from: StreamProtocol, to: StreamProtocol, frames: string[]): SseEvent[] {
  const adapter = createStreamingAdapter({ from, to, fallbackModel: 'm' });
  expect(adapter).not.toBeNull();
  const chunks = [
    ...frames.map((frame) => ({ requestId: 'req', data: encoder.encode(frame), done: false })),
    { requestId: 'req', data: new Uint8Array(0), done: true },
  ];
  return parseSse(chunks.flatMap((chunk) => adapter!.adaptChunk(chunk)).map((chunk) => decoder.decode(chunk.data)).join(''));
}

const frame = (data: unknown, event?: string): string =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const typed = (type: string, body: Json): string => frame({ type, ...body }, type);
const chatChunk = (delta: Json, finishReason: string | null = null): string =>
  frame({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finishReason }] });

const CHAT_USAGE = frame({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'm', choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 } });
const MESSAGE_START = typed('message_start', { message: { id: 'msg_1', model: 'm', usage: { input_tokens: 100, output_tokens: 0 } } });
const RESPONSE_CREATED = typed('response.created', { response: { id: 'resp_1', object: 'response', model: 'm', status: 'in_progress', output: [], usage: null } });
const RESPONSE_TEXT = typed('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'The answer is' });

/** Each source protocol's stream cut in the middle of an answer. */
const SOURCES: Record<StreamProtocol, { text: string[]; tool: string[]; partialFrame: string; errorEvent: string }> = {
  [CHAT]: {
    text: [chatChunk({ role: 'assistant', content: '' }), chatChunk({ content: 'The answer is' })],
    tool: [
      chatChunk({ role: 'assistant', content: '' }),
      chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '{"path":' } }] }),
    ],
    partialFrame: 'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"The ans',
    errorEvent: frame({ error: { message: 'upstream failed', type: 'server_error', code: null } }),
  },
  [MESSAGES]: {
    text: [
      MESSAGE_START,
      typed('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      typed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'The answer is' } }),
    ],
    tool: [
      MESSAGE_START,
      typed('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'write', input: {} } }),
      typed('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
    ],
    partialFrame: 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_del',
    errorEvent: frame({ type: 'error', error: { type: 'overloaded_error', message: 'upstream failed' } }, 'error'),
  },
  [RESPONSES]: {
    text: [
      RESPONSE_CREATED,
      typed('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } }),
      RESPONSE_TEXT,
    ],
    tool: [
      RESPONSE_CREATED,
      typed('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write', arguments: '', status: 'in_progress' } }),
      typed('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_1', delta: '{"path":' }),
    ],
    partialFrame: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"del',
    errorEvent: frame({ type: 'error', code: 'server_error', message: 'upstream failed', param: null, sequence_number: 9 }, 'error'),
  },
};

const PAIRS: Array<[StreamProtocol, StreamProtocol]> = [
  [CHAT, MESSAGES],
  [CHAT, RESPONSES],
  [MESSAGES, CHAT],
  [MESSAGES, RESPONSES],
  [RESPONSES, MESSAGES],
  [RESPONSES, CHAT],
];

const names = (events: SseEvent[]): Array<string | null> => events.map((event) => event.event);
const jsonFrames = (events: SseEvent[]): Json[] => events.filter((event) => event.data !== '[DONE]').map((event) => JSON.parse(event.data) as Json);
const doneMarkers = (events: SseEvent[]): SseEvent[] => events.filter((event) => event.data === '[DONE]');
const finishChunks = (events: SseEvent[]): Json[] => jsonFrames(events).filter((chunk) => typeof chunk.choices?.[0]?.finish_reason === 'string');

const FAILURE = 'a translated stream must report the failure';

/** Asserts the client was told, in its own protocol, that the answer failed, and never told that it finished. */
const EXPECT_FAILED: Record<StreamProtocol, (events: SseEvent[], message: string) => void> = {
  [MESSAGES](events, message) {
    expect(events.at(-1)?.event, FAILURE).toBe('error');
    expect(JSON.parse(events.at(-1)!.data)).toEqual({ type: 'error', error: { type: 'api_error', message } });
    expect(names(events).filter((name) => name === 'error')).toHaveLength(1);
    for (const closing of ['content_block_stop', 'message_delta', 'message_stop']) expect(names(events)).not.toContain(closing);
  },
  [RESPONSES](events, message) {
    expect(events.at(-1)?.event, FAILURE).toBe('response.failed');
    const { response } = JSON.parse(events.at(-1)!.data) as Json;
    expect(response).toMatchObject({ status: 'failed', output: [], usage: null, error: { message } });
    expect(names(events).filter((name) => name === 'response.failed')).toHaveLength(1);
    expect(names(events).filter((name) => name?.endsWith('.done') || name === 'response.completed' || name === 'response.incomplete')).toEqual([]);
    expect(doneMarkers(events)).toEqual([]);
  },
  [CHAT](events, message) {
    expect(events.at(-1)?.data, FAILURE).not.toBe('[DONE]');
    expect(events, FAILURE).not.toEqual([]);
    expect((JSON.parse(events.at(-1)!.data) as Json).error?.message, FAILURE).toBe(message);
    expect(jsonFrames(events).filter((chunk) => chunk.error)).toHaveLength(1);
    expect(finishChunks(events)).toEqual([]);
    expect(doneMarkers(events)).toEqual([]);
  },
};

/** The `response` of the stream's `response.failed` event. */
function failedResponse(events: SseEvent[]): Json {
  const failed = events.find((event) => event.event === 'response.failed');
  expect(failed, FAILURE).toBeDefined();
  return (JSON.parse(failed!.data) as Json).response as Json;
}

const streamedText = (to: StreamProtocol, events: SseEvent[]): string => jsonFrames(events).map((body) => {
  if (to === CHAT) return body.choices?.[0]?.delta?.content ?? '';
  if (to === MESSAGES) return body.type === 'content_block_delta' ? body.delta.text ?? '' : '';
  return body.type === 'response.output_text.delta' ? body.delta : '';
}).join('');

describe.each(PAIRS)('a stream from %s translated to %s', (from, to) => {
  const source = SOURCES[from];

  it('reports an answer cut off after some text', () => {
    const events = translate(from, to, source.text);
    EXPECT_FAILED[to](events, CUT_OFF);
    expect(streamedText(to, events)).toBe('The answer is');
  });

  it('reports an answer cut off with the relay error frame', () => {
    const events = translate(from, to, [...source.text, RELAY_ERROR_FRAME]);
    EXPECT_FAILED[to](events, 'terminated');
    expect(streamedText(to, events)).toBe('The answer is');
  });

  it('reports an answer cut off inside a tool call', () => {
    EXPECT_FAILED[to](translate(from, to, source.tool), CUT_OFF);
  });

  it('reports an answer cut off inside a tool call with the relay error frame', () => {
    EXPECT_FAILED[to](translate(from, to, [...source.tool, RELAY_ERROR_FRAME]), 'terminated');
  });

  it('reports a cut inside a frame, where the relay error frame cannot be read', () => {
    const events = translate(from, to, [...source.text, source.partialFrame, RELAY_ERROR_FRAME]);
    EXPECT_FAILED[to](events, CUT_OFF);
    expect(streamedText(to, events)).toBe('The answer is');
  });

  it("reports the upstream's own error event", () => {
    EXPECT_FAILED[to](translate(from, to, [...source.text, source.errorEvent]), 'upstream failed');
  });

  it('reports one failure when a stream fails again after its error event', () => {
    EXPECT_FAILED[to](translate(from, to, [...source.text, source.errorEvent, RELAY_ERROR_FRAME]), 'upstream failed');
  });

  it('reports a failure before any output', () => {
    EXPECT_FAILED[to](translate(from, to, [RELAY_ERROR_FRAME]), 'terminated');
  });

  it('reports a stream with no events at all', () => {
    EXPECT_FAILED[to](translate(from, to, []), CUT_OFF);
  });

  it('reports a relay error frame with no text', () => {
    EXPECT_FAILED[to](translate(from, to, [...source.text, 'event: error\ndata: \n\n']), 'Upstream error');
  });
});

describe('the failure a client is told', () => {
  it.each([
    [MESSAGES, CHAT, 'overloaded_error'],
    [RESPONSES, CHAT, 'server_error'],
  ] as const)('keeps the error type of a %s stream for a Chat client', (from, to, type) => {
    const [error] = jsonFrames(translate(from, to, [SOURCES[from].errorEvent])).filter((chunk) => chunk.error);
    expect(error).toEqual({ error: { message: 'upstream failed', type } });
  });

  it.each([
    [CHAT, 'server_error'],
    [MESSAGES, 'overloaded_error'],
  ] as const)('keeps the error code of a %s stream for a Responses client', (from, code) => {
    expect(failedResponse(translate(from, RESPONSES, [SOURCES[from].errorEvent])).error).toEqual({ code, message: 'upstream failed' });
  });

  it('uses a generic type and code when the upstream names none', () => {
    const [chat] = jsonFrames(translate(MESSAGES, CHAT, [RELAY_ERROR_FRAME])).filter((chunk) => chunk.error);
    expect(chat).toEqual({ error: { message: 'terminated', type: 'api_error' } });
    expect(failedResponse(translate(CHAT, RESPONSES, [RELAY_ERROR_FRAME])).error).toEqual({ code: 'server_error', message: 'terminated' });
  });

  it('keeps a string error type when the code is a number', () => {
    const chunk = frame({ error: { code: 429, type: 'rate_limit_error', message: 'slow down' } });
    expect(failedResponse(translate(CHAT, RESPONSES, [chunk])).error).toEqual({ code: 'rate_limit_error', message: 'slow down' });
  });

  it('keeps relay error text that reads as JSON', () => {
    EXPECT_FAILED[MESSAGES](translate(CHAT, MESSAGES, ['event: error\ndata: 404\n\n']), '404');
  });

  it('reads an error chunk whose error is a plain string', () => {
    EXPECT_FAILED[MESSAGES](translate(CHAT, MESSAGES, [frame({ error: 'model crashed' })]), 'model crashed');
  });

  it('reads an error chunk that also closes its choice', () => {
    const chunk = frame({ id: 'chatcmpl-1', error: { code: 502, message: 'provider dropped' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
    EXPECT_FAILED[RESPONSES](translate(CHAT, RESPONSES, [...SOURCES[CHAT].text, chunk]), 'provider dropped');
  });

  it('opens the response before failing it for a Responses client', () => {
    expect(names(translate(CHAT, RESPONSES, [RELAY_ERROR_FRAME]))).toEqual(['response.created', 'response.failed']);
  });

  it('escapes an error message so it cannot forge a frame', () => {
    const events = translate(CHAT, MESSAGES, [frame({ error: { message: 'x\n\nevent: message_stop\ndata: {}' } })]);
    expect(names(events)).toEqual(['error']);
  });
});

describe('a Responses stream that ends with response.incomplete', () => {
  const usage = { input_tokens: 100, output_tokens: 7, total_tokens: 107 };
  const incomplete = (reason: string): string => typed('response.incomplete', {
    response: {
      id: 'resp_1', object: 'response', model: 'm', status: 'incomplete', incomplete_details: { reason }, usage,
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'The answer is', annotations: [] }] }],
    },
  });
  const body = (reason: string) => ({
    requestId: 'req',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify({
      id: 'resp_1', object: 'response', model: 'm', status: 'incomplete', incomplete_details: { reason }, usage,
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'The answer is', annotations: [] }] }],
    })),
  });
  const notStreamed = (reason: string, to: StreamProtocol): Json =>
    JSON.parse(decoder.decode(transformResponse(body(reason), { from: RESPONSES, to, fallbackModel: 'm' })!.body)) as Json;

  it.each([
    ['max_output_tokens', 'max_tokens'],
    ['content_filter', 'content_filter'],
  ])('ends normally for a Messages client on %s, like the not-streamed answer', (reason, stopReason) => {
    const events = translate(RESPONSES, MESSAGES, [RESPONSE_CREATED, RESPONSE_TEXT, incomplete(reason)]);

    expect(names(events).slice(-3), FAILURE).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
    const delta = JSON.parse(events.at(-2)!.data) as Json;
    expect(delta.delta.stop_reason).toBe(stopReason);
    expect(delta.usage).toMatchObject({ input_tokens: 100, output_tokens: 7 });
    const answer = notStreamed(reason, MESSAGES);
    expect(answer.stop_reason).toBe(stopReason);
    expect(delta.usage).toMatchObject(answer.usage);
  });

  it.each([
    ['max_output_tokens', 'length'],
    ['content_filter', 'content_filter'],
  ])('ends normally for a Chat client on %s, like the not-streamed answer', (reason, finishReason) => {
    const events = translate(RESPONSES, CHAT, [RESPONSE_CREATED, RESPONSE_TEXT, incomplete(reason)]);

    expect(events.at(-1)?.data, FAILURE).toBe('[DONE]');
    expect(doneMarkers(events)).toHaveLength(1);
    const finishes = finishChunks(events);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.choices[0].finish_reason).toBe(finishReason);
    expect(finishes[0]!.usage).toEqual({ prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 });
    const answer = notStreamed(reason, CHAT);
    expect(answer.choices[0].finish_reason).toBe(finishReason);
    expect(answer.usage).toEqual(finishes[0]!.usage);
  });
});

describe('a Responses stream that ends with response.failed', () => {
  const failed = typed('response.failed', {
    response: { id: 'resp_1', object: 'response', model: 'm', status: 'failed', error: { code: 'server_error', message: 'backend failed' }, output: [], usage: null },
  });

  it.each([MESSAGES, CHAT] as const)('reports the failure to a %s client', (to) => {
    EXPECT_FAILED[to](translate(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, failed]), 'backend failed');
  });

  it('keeps the error code for a Chat client', () => {
    const [chunk] = jsonFrames(translate(RESPONSES, CHAT, [RESPONSE_CREATED, failed])).filter((event) => event.error);
    expect(chunk).toEqual({ error: { message: 'backend failed', type: 'server_error' } });
  });

  it('reports a failure that names no error', () => {
    const bare = typed('response.failed', { response: { id: 'resp_1', status: 'failed', error: null } });
    EXPECT_FAILED[MESSAGES](translate(RESPONSES, MESSAGES, [RESPONSE_CREATED, bare]), 'Upstream error');
  });

  it('reports one failure when an error event comes first', () => {
    const events = translate(RESPONSES, MESSAGES, [RESPONSE_CREATED, SOURCES[RESPONSES].errorEvent, failed]);
    EXPECT_FAILED[MESSAGES](events, 'upstream failed');
  });
});

describe('an answer cut at a limit, for a Responses client', () => {
  const chatBody = (finishReason: string): Json => ({
    id: 'chatcmpl-1', object: 'chat.completion', model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'The answer is' }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 },
  });
  const messagesBody = (stopReason: string): Json => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text: 'The answer is' }], stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 7 },
  });
  const response = (body: Json) => ({ requestId: 'req', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)) });
  const chatStream = (finishReason: string): string[] => [...SOURCES[CHAT].text, chatChunk({}, finishReason), CHAT_USAGE, frame('[DONE]')];
  const messagesStream = (stopReason: string): string[] => [
    ...SOURCES[MESSAGES].text,
    typed('content_block_stop', { index: 0 }),
    typed('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 7 } }),
    typed('message_stop', {}),
  ];

  const CASES: Array<[string, StreamProtocol, Json, string[], string]> = [
    ['Chat length', CHAT, chatBody('length'), chatStream('length'), 'max_output_tokens'],
    ['Chat content_filter', CHAT, chatBody('content_filter'), chatStream('content_filter'), 'content_filter'],
    ['Messages max_tokens', MESSAGES, messagesBody('max_tokens'), messagesStream('max_tokens'), 'max_output_tokens'],
  ];

  it.each(CASES)('reports %s in a not-streamed answer', (_label, from, body, _frames, reason) => {
    const answer = JSON.parse(decoder.decode(transformResponse(response(body), { from, to: RESPONSES, fallbackModel: 'm' })!.body)) as Json;

    expect(answer.status, FAILURE).toBe('incomplete');
    expect(answer.incomplete_details).toEqual({ reason });
    expect(answer.output[0].status).toBe('incomplete');
    expect(answer.output_text).toBe('The answer is');
  });

  it.each(CASES)('reports %s in a streamed answer', (_label, from, _body, frames, reason) => {
    const events = translate(from, RESPONSES, frames);

    expect(names(events), FAILURE).not.toContain('response.completed');
    expect(names(events).filter((name) => name === 'response.incomplete')).toHaveLength(1);
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.type).toBe('response.incomplete');
    expect(final.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, output_text: 'The answer is', usage: { output_tokens: 7 } });
    expect(final.response.output[0].status).toBe('incomplete');
    const done = jsonFrames(events).find((body) => body.type === 'response.output_item.done');
    expect(done?.item.status).toBe('incomplete');
    expect(events.at(-1)?.data).toBe('[DONE]');
  });

  it.each(CASES)('reports %s when the seller answers a streamed request with JSON', (_label, from, body, _frames, reason) => {
    const transformed = transformResponse(response(body), { from, to: RESPONSES, streamRequested: true, fallbackModel: 'm' })!;
    const events = parseSse(decoder.decode(transformed.body));

    expect(names(events), FAILURE).not.toContain('response.completed');
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.type).toBe('response.incomplete');
    expect(final.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason } });
    expect(events.at(-1)?.data).toBe('[DONE]');
  });

  it('keeps a cut tool call from reading as completed', () => {
    const frames = [...SOURCES[CHAT].tool, chatChunk({}, 'length'), frame('[DONE]')];
    const events = translate(CHAT, RESPONSES, frames);
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.response.output).toMatchObject([{ type: 'function_call', arguments: '{"path":', status: 'incomplete' }]);
    const done = jsonFrames(events).find((body) => body.type === 'response.output_item.done');
    expect(done?.item.status).toBe('incomplete');
  });

  it('leaves an answer that finished on its own as completed', () => {
    const answer = JSON.parse(decoder.decode(transformResponse(response(chatBody('stop')), { from: CHAT, to: RESPONSES, fallbackModel: 'm' })!.body)) as Json;
    expect(answer.status).toBe('completed');
    expect(answer).not.toHaveProperty('incomplete_details');
    expect(answer.output[0].status).toBe('completed');

    const events = translate(CHAT, RESPONSES, chatStream('stop'));
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.type).toBe('response.completed');
    expect(final.response.status).toBe('completed');
    expect(final.response).not.toHaveProperty('incomplete_details');
    expect(final.response.output[0].status).toBe('completed');
  });
});

describe('an answer that finished stays finished', () => {
  const completed = typed('response.completed', {
    response: { id: 'resp_1', object: 'response', model: 'm', status: 'completed', usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107 }, output: [] },
  });
  const chatFinished = [...SOURCES[CHAT].text, chatChunk({}, 'stop')];
  const messagesFinished = [
    ...SOURCES[MESSAGES].text,
    typed('content_block_stop', { index: 0 }),
    typed('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }),
  ];

  /** Asserts the stream ended once, as finished, with the reason it reported (end_turn, stop, completed by default). */
  const expectFinished = (to: StreamProtocol, events: SseEvent[], reason: string | null = to === MESSAGES ? 'end_turn' : 'stop'): void => {
    if (to === MESSAGES) {
      expect(names(events)).not.toContain('error');
      expect(names(events).filter((name) => name === 'message_stop')).toHaveLength(1);
      expect(events.at(-1)?.event).toBe('message_stop');
      expect(jsonFrames(events).find((body) => body.type === 'message_delta')?.delta.stop_reason).toBe(reason);
      return;
    }
    expect(doneMarkers(events)).toHaveLength(1);
    expect(events.at(-1)?.data).toBe('[DONE]');
    if (to === CHAT) {
      expect(jsonFrames(events).filter((chunk) => chunk.error)).toEqual([]);
      expect(finishChunks(events).map((chunk) => chunk.choices[0].finish_reason)).toEqual([reason]);
      return;
    }
    expect(names(events)).not.toContain('response.failed');
    expect(names(events).filter((name) => name === 'response.completed')).toHaveLength(1);
  };

  it.each([MESSAGES, RESPONSES] as const)('a whole Chat stream to %s', (to) => {
    expectFinished(to, translate(CHAT, to, [...chatFinished, CHAT_USAGE, frame('[DONE]')]));
  });

  it.each([CHAT, RESPONSES] as const)('a whole Messages stream to %s', (to) => {
    expectFinished(to, translate(MESSAGES, to, [...messagesFinished, typed('message_stop', {})]));
  });

  it.each([MESSAGES, CHAT] as const)('a whole Responses stream to %s', (to) => {
    expectFinished(to, translate(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, completed]));
  });

  it.each([MESSAGES, RESPONSES] as const)('a Chat stream cut after its finish_reason to %s', (to) => {
    expectFinished(to, translate(CHAT, to, chatFinished));
  });

  it.each([MESSAGES, RESPONSES] as const)('a Chat stream that failed after its finish_reason to %s', (to) => {
    expectFinished(to, translate(CHAT, to, [...chatFinished, RELAY_ERROR_FRAME]));
  });

  // [DONE] is the stream's own end marker, so the stream finished. It never said why: a Messages client gets no
  // stop reason, as the not-streamed translation of a Chat answer without a finish_reason does.
  it.each([MESSAGES, RESPONSES] as const)('a Chat stream that ends with [DONE] and no finish_reason to %s', (to) => {
    expectFinished(to, translate(CHAT, to, [...SOURCES[CHAT].text, frame('[DONE]')]), to === MESSAGES ? null : 'stop');
  });

  it.each([MESSAGES, RESPONSES] as const)('a Chat stream that failed after [DONE] to %s', (to) => {
    expectFinished(to, translate(CHAT, to, [...chatFinished, CHAT_USAGE, frame('[DONE]'), RELAY_ERROR_FRAME]));
  });

  it.each([CHAT, RESPONSES] as const)('a Messages stream cut after its stop_reason to %s', (to) => {
    expectFinished(to, translate(MESSAGES, to, messagesFinished));
  });

  it.each([CHAT, RESPONSES] as const)('a Messages stream that failed after its stop_reason to %s', (to) => {
    expectFinished(to, translate(MESSAGES, to, [...messagesFinished, RELAY_ERROR_FRAME]));
  });

  it.each([CHAT, RESPONSES] as const)('a Messages stream that failed after message_stop to %s', (to) => {
    expectFinished(to, translate(MESSAGES, to, [...messagesFinished, typed('message_stop', {}), RELAY_ERROR_FRAME]));
  });

  it.each([MESSAGES, CHAT] as const)('a Responses stream that failed after response.completed to %s', (to) => {
    expectFinished(to, translate(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, completed, RELAY_ERROR_FRAME]));
  });

  it.each([MESSAGES, CHAT] as const)('a Responses stream with two response.completed events to %s', (to) => {
    expectFinished(to, translate(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, completed, completed]));
  });

  it('a final chunk that carries the last frames still counts them', () => {
    const adapter = createStreamingAdapter({ from: MESSAGES, to: CHAT, fallbackModel: 'm' })!;
    const chunks = adapter.adaptChunk({ requestId: 'req', data: encoder.encode(messagesFinished.join('')), done: true });
    expectFinished(CHAT, parseSse(chunks.map((chunk) => decoder.decode(chunk.data)).join('')));
  });

  it('a final chunk that carries [DONE] finishes once', () => {
    const adapter = createStreamingAdapter({ from: CHAT, to: MESSAGES, fallbackModel: 'm' })!;
    const data = encoder.encode([...chatFinished, CHAT_USAGE, frame('[DONE]')].join(''));
    expectFinished(MESSAGES, parseSse(adapter.adaptChunk({ requestId: 'req', data, done: true }).map((chunk) => decoder.decode(chunk.data)).join('')));
  });

  it('a final chunk that carries a cut answer reports it', () => {
    const adapter = createStreamingAdapter({ from: MESSAGES, to: CHAT, fallbackModel: 'm' })!;
    const chunks = adapter.adaptChunk({ requestId: 'req', data: encoder.encode(SOURCES[MESSAGES].text.join('')), done: true });
    EXPECT_FAILED[CHAT](parseSse(chunks.map((chunk) => decoder.decode(chunk.data)).join('')), CUT_OFF);
  });
});
