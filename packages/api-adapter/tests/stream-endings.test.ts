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

/** Feeds an adapter the way a seller's relay does: what each read of the upstream returned, then an empty final chunk. */
function adapt(from: StreamProtocol, to: StreamProtocol, reads: Uint8Array[]): SseEvent[] {
  const adapter = createStreamingAdapter({ from, to, fallbackModel: 'm' });
  expect(adapter).not.toBeNull();
  const chunks = [
    ...reads.map((data) => ({ requestId: 'req', data, done: false })),
    { requestId: 'req', data: new Uint8Array(0), done: true },
  ];
  return parseSse(chunks.flatMap((chunk) => adapter!.adaptChunk(chunk)).map((chunk) => decoder.decode(chunk.data)).join(''));
}

/** The upstream's frames, one read each. */
const translate = (from: StreamProtocol, to: StreamProtocol, frames: string[]): SseEvent[] =>
  adapt(from, to, frames.map((frame) => encoder.encode(frame)));

/** The same bytes in reads of `size` bytes, which split frames and characters anywhere. */
function translateInReads(from: StreamProtocol, to: StreamProtocol, frames: string[], size: number): SseEvent[] {
  const bytes = encoder.encode(frames.join(''));
  const reads: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) reads.push(bytes.subarray(start, start + size));
  return adapt(from, to, reads);
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
const RESPONSE_COMPLETED = typed('response.completed', {
  response: { id: 'resp_1', object: 'response', model: 'm', status: 'completed', usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107 }, output: [] },
});

/** Each source protocol's stream cut in the middle of an answer, and the frames that would have finished its text. */
const SOURCES: Record<StreamProtocol, { text: string[]; tool: string[]; partialFrame: string; errorEvent: string; finish: string[] }> = {
  [CHAT]: {
    text: [chatChunk({ role: 'assistant', content: '' }), chatChunk({ content: 'The answer is' })],
    tool: [
      chatChunk({ role: 'assistant', content: '' }),
      chatChunk({ content: 'The answer is' }),
      chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '{"path":' } }] }),
    ],
    partialFrame: 'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"The ans',
    errorEvent: frame({ error: { message: 'upstream failed', type: 'server_error', code: null } }),
    finish: [chatChunk({}, 'stop'), CHAT_USAGE, frame('[DONE]')],
  },
  [MESSAGES]: {
    text: [
      MESSAGE_START,
      typed('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      typed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'The answer is' } }),
    ],
    tool: [
      MESSAGE_START,
      typed('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      typed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'The answer is' } }),
      typed('content_block_stop', { index: 0 }),
      typed('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'write', input: {} } }),
      typed('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
    ],
    partialFrame: 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_del',
    errorEvent: frame({ type: 'error', error: { type: 'overloaded_error', message: 'upstream failed' } }, 'error'),
    finish: [
      typed('content_block_stop', { index: 0 }),
      typed('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }),
      typed('message_stop', {}),
    ],
  },
  [RESPONSES]: {
    text: [
      RESPONSE_CREATED,
      typed('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } }),
      RESPONSE_TEXT,
    ],
    tool: [
      RESPONSE_CREATED,
      typed('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } }),
      RESPONSE_TEXT,
      typed('response.output_item.added', { output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write', arguments: '', status: 'in_progress' } }),
      typed('response.function_call_arguments.delta', { output_index: 1, item_id: 'fc_1', delta: '{"path":' }),
    ],
    partialFrame: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"del',
    errorEvent: frame({ type: 'error', code: 'server_error', message: 'upstream failed', param: null, sequence_number: 9 }, 'error'),
    finish: [RESPONSE_COMPLETED],
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
/** The events that end a Responses stream: a stream has exactly one of them. */
const RESPONSES_ENDINGS = ['response.completed', 'response.incomplete', 'response.failed'];

/** Asserts the client was told, in its own protocol, that the answer failed, and never told that it finished. */
const EXPECT_FAILED: Record<StreamProtocol, (events: SseEvent[], message: string) => void> = {
  [MESSAGES](events, message) {
    expect(events.at(-1)?.event, FAILURE).toBe('error');
    expect(JSON.parse(events.at(-1)!.data)).toEqual({ type: 'error', error: { type: 'api_error', message } });
    expect(names(events).filter((name) => name === 'error')).toHaveLength(1);
    for (const closing of ['message_delta', 'message_stop']) expect(names(events)).not.toContain(closing);
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

/** The tool call arguments the client was sent, joined in order. */
const streamedArguments = (to: StreamProtocol, events: SseEvent[]): string => jsonFrames(events).map((body) => {
  if (to === CHAT) return (body.choices?.[0]?.delta?.tool_calls ?? []).map((call: Json) => call.function?.arguments ?? '').join('');
  if (to === MESSAGES) return body.type === 'content_block_delta' && body.delta.type === 'input_json_delta' ? body.delta.partial_json : '';
  return body.type === 'response.function_call_arguments.delta' ? body.delta : '';
}).join('');

/**
 * Asserts the tool call that was cut never reads as finished (its block, item or choice is never closed) and that
 * the client got its arguments as far as they came.
 */
function expectToolCallLeftOpen(to: StreamProtocol, events: SseEvent[]): void {
  const frames = jsonFrames(events);
  if (to === MESSAGES) {
    const tool = frames.find((body) => body.type === 'content_block_start' && body.content_block.type === 'tool_use');
    expect(tool).toBeDefined();
    expect(frames.filter((body) => body.type === 'content_block_stop' && body.index === tool!.index)).toEqual([]);
  } else if (to === RESPONSES) {
    expect(frames.some((body) => body.type === 'response.output_item.added' && body.item.type === 'function_call')).toBe(true);
  } else {
    expect(frames.some((body) => body.choices?.[0]?.delta?.tool_calls)).toBe(true);
  }
  expect(streamedArguments(to, events)).toBe('{"path":');
}

/**
 * Asserts the stream ended once, as finished, with the reason it reported: a Messages stop_reason or a Chat
 * finish_reason (end_turn and stop by default). A Responses client only learns completed, so it gets no reason.
 */
function expectFinished(to: StreamProtocol, events: SseEvent[], reason: string | null = to === MESSAGES ? 'end_turn' : 'stop'): void {
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
  expect(names(events).filter((name) => RESPONSES_ENDINGS.includes(name ?? ''))).toEqual(['response.completed']);
}

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
    const events = translate(from, to, source.tool);
    EXPECT_FAILED[to](events, CUT_OFF);
    expectToolCallLeftOpen(to, events);
    expect(streamedText(to, events)).toBe('The answer is');
  });

  it('reports an answer cut off inside a tool call with the relay error frame', () => {
    const events = translate(from, to, [...source.tool, RELAY_ERROR_FRAME]);
    EXPECT_FAILED[to](events, 'terminated');
    expectToolCallLeftOpen(to, events);
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

  it('keeps the failure when the stream says it finished after it', () => {
    const frames = [...source.text, source.errorEvent, ...source.finish];
    EXPECT_FAILED[to](translate(from, to, frames), 'upstream failed');
    EXPECT_FAILED[to](translate(from, to, [frames.join('')]), 'upstream failed');
  });

  it('reads a stream whose reads split frames and characters', () => {
    const text = 'Réponse — 答え 🙂';
    const answer = source.text.map((frame) => frame.replace('The answer is', text));
    const whole = translateInReads(from, to, [...answer, ...source.finish], 3);
    expectFinished(to, whole);
    expect(streamedText(to, whole)).toBe(text);
    const cut = translateInReads(from, to, [...answer, 'event: error\ndata: coupé 🙂\n\n'], 3);
    EXPECT_FAILED[to](cut, 'coupé 🙂');
    expect(streamedText(to, cut)).toBe(text);
  });

  it('passes on tool call arguments that arrive in pieces', () => {
    const events = translate(from, to, SPLIT_TOOL_CALL[from]);
    expect(streamedArguments(to, events)).toBe('{"path":"a"}');
    expectFinished(to, events, { [MESSAGES]: 'tool_use', [CHAT]: 'tool_calls', [RESPONSES]: null }[to]);
  });

  it('passes text on as it arrives, before the stream ends', () => {
    const adapter = createStreamingAdapter({ from, to, fallbackModel: 'm' })!;
    const sent = source.text.flatMap((frame) => adapter.adaptChunk({ requestId: 'req', data: encoder.encode(frame), done: false }));
    expect(streamedText(to, parseSse(sent.map((chunk) => decoder.decode(chunk.data)).join('')))).toBe('The answer is');
  });

  it('keeps the request id, and marks only its last chunk done', () => {
    const run = (chunks: Array<{ data: Uint8Array; done: boolean }>) => {
      const adapter = createStreamingAdapter({ from, to, fallbackModel: 'm' })!;
      return chunks.flatMap((chunk) => adapter.adaptChunk({ requestId: 'req-7', ...chunk }));
    };
    // A whole answer, a cut one and a failed one; with an empty final chunk, and with everything in the final chunk.
    for (const frames of [[...source.text, ...source.finish], source.text, [...source.text, RELAY_ERROR_FRAME]]) {
      const data = encoder.encode(frames.join(''));
      for (const sent of [run([{ data, done: false }, { data: new Uint8Array(0), done: true }]), run([{ data, done: true }])]) {
        expect(sent.map((chunk) => chunk.requestId)).toEqual(sent.map(() => 'req-7'));
        expect(sent.map((chunk) => chunk.done)).toEqual([...sent.slice(1).map(() => false), true]);
      }
    }
  });
});

/** Each source protocol's finished answer with one tool call whose arguments arrive in two pieces, neither of them JSON. */
const SPLIT_TOOL_CALL: Record<StreamProtocol, string[]> = {
  [CHAT]: [
    chatChunk({ role: 'assistant', content: '' }),
    chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }),
    chatChunk({}, 'tool_calls'),
    frame('[DONE]'),
  ],
  [MESSAGES]: [
    MESSAGE_START,
    typed('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} } }),
    typed('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"pa' } }),
    typed('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'th":"a"}' } }),
    typed('content_block_stop', { index: 0 }),
    typed('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } }),
    typed('message_stop', {}),
  ],
  [RESPONSES]: [
    RESPONSE_CREATED,
    typed('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '', status: 'in_progress' } }),
    typed('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_1', delta: '{"pa' }),
    typed('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_1', delta: 'th":"a"}' }),
    RESPONSE_COMPLETED,
  ],
};

describe('the failure a client is told', () => {
  it.each([
    [MESSAGES, CHAT, 'overloaded_error'],
    [RESPONSES, CHAT, 'server_error'],
  ] as const)('keeps the error type of a %s stream for a Chat client', (from, to, type) => {
    const [error] = jsonFrames(translate(from, to, [SOURCES[from].errorEvent])).filter((chunk) => chunk.error);
    expect(error).toEqual({ error: { message: 'upstream failed', type } });
  });

  // A failed Responses answer's error code is one of a fixed set: the source's code maps onto it.
  it.each([
    ['a Chat server_error', CHAT, SOURCES[CHAT].errorEvent, 'server_error'],
    ['a Messages overloaded_error', MESSAGES, SOURCES[MESSAGES].errorEvent, 'server_error'],
    ['a Messages rate_limit_error', MESSAGES, frame({ type: 'error', error: { type: 'rate_limit_error', message: 'upstream failed' } }, 'error'), 'rate_limit_exceeded'],
    ['a Chat rate_limit_exceeded', CHAT, frame({ error: { message: 'upstream failed', type: 'requests', code: 'rate_limit_exceeded' } }), 'rate_limit_exceeded'],
    ['a Chat context_length_exceeded', CHAT, frame({ error: { message: 'upstream failed', type: 'invalid_request_error', code: 'context_length_exceeded' } }), 'server_error'],
    ['a code named like an object property', CHAT, frame({ error: { message: 'upstream failed', code: '__proto__' } }), 'server_error'],
    ['a code named like a method', MESSAGES, frame({ type: 'error', error: { type: 'constructor', message: 'upstream failed' } }, 'error'), 'server_error'],
  ] as const)('gives a Responses client a Responses error code for %s', (_label, from, errorEvent, code) => {
    expect(failedResponse(translate(from, RESPONSES, [errorEvent])).error).toEqual({ code, message: 'upstream failed' });
  });

  it('uses a generic type and code when the upstream names none', () => {
    const [chat] = jsonFrames(translate(MESSAGES, CHAT, [RELAY_ERROR_FRAME])).filter((chunk) => chunk.error);
    expect(chat).toEqual({ error: { message: 'terminated', type: 'api_error' } });
    expect(failedResponse(translate(CHAT, RESPONSES, [RELAY_ERROR_FRAME])).error).toEqual({ code: 'server_error', message: 'terminated' });
    const [cutChat] = jsonFrames(translate(MESSAGES, CHAT, SOURCES[MESSAGES].text)).filter((chunk) => chunk.error);
    expect(cutChat).toEqual({ error: { message: CUT_OFF, type: 'api_error' } });
    expect(failedResponse(translate(CHAT, RESPONSES, SOURCES[CHAT].text)).error).toEqual({ code: 'server_error', message: CUT_OFF });
  });

  it('prefers the error code to its type', () => {
    const chunk = frame({ error: { type: 'invalid_request_error', code: 'rate_limit_exceeded', message: 'slow down' } });
    expect(failedResponse(translate(CHAT, RESPONSES, [chunk])).error).toEqual({ code: 'rate_limit_exceeded', message: 'slow down' });
  });

  it.each([
    [MESSAGES, frame({ type: 'error', error: { type: 'overloaded_error', message: 'upstream failed' } })],
    [RESPONSES, frame({ type: 'error', code: 'server_error', message: 'upstream failed', param: null })],
  ] as const)('reads a %s error event that has no event line', (from, errorEvent) => {
    EXPECT_FAILED[CHAT](translate(from, CHAT, [...SOURCES[from].text, errorEvent]), 'upstream failed');
  });

  it('keeps a string error type when the code is a number', () => {
    const chunk = frame({ error: { code: 429, type: 'rate_limit_error', message: 'slow down' } });
    expect(failedResponse(translate(CHAT, RESPONSES, [chunk])).error).toEqual({ code: 'rate_limit_exceeded', message: 'slow down' });
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

  // Which Messages stop reason a content filter becomes is the stop reason table's to say; the stream only agrees with it.
  it.each([
    ['max_output_tokens', 'max_tokens'],
    ['content_filter', undefined],
  ])('ends normally for a Messages client on %s, like the not-streamed answer', (reason, stopReason) => {
    const events = translate(RESPONSES, MESSAGES, [RESPONSE_CREATED, RESPONSE_TEXT, incomplete(reason)]);

    expect(names(events).slice(-3), FAILURE).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
    const delta = JSON.parse(events.at(-2)!.data) as Json;
    expect(delta.usage).toMatchObject({ input_tokens: 100, output_tokens: 7 });
    const answer = notStreamed(reason, MESSAGES);
    expect(answer.stop_reason).toEqual(stopReason ?? expect.any(String));
    expect(delta.delta.stop_reason).toBe(answer.stop_reason);
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

  // A tool call the limit cut is not a hand-off to the client's tool.
  it.each([[MESSAGES, 'max_tokens'], [CHAT, 'length']] as const)('reports a tool call cut by the limit to a %s client as cut', (to, reason) => {
    const events = translate(RESPONSES, to, [...SOURCES[RESPONSES].tool, incomplete('max_output_tokens')]);
    expectFinished(to, events, reason);
    expect(streamedArguments(to, events)).toBe('{"path":');
  });
});

describe('a Responses stream that ends with response.failed', () => {
  const failed = typed('response.failed', {
    response: { id: 'resp_1', object: 'response', model: 'm', status: 'failed', error: { code: 'server_error', message: 'backend failed' }, output: [], usage: null },
  });

  it.each([MESSAGES, CHAT] as const)('reports the failure to a %s client', (to) => {
    EXPECT_FAILED[to](translate(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, failed]), 'backend failed');
  });

  it.each([MESSAGES, CHAT] as const)('reports the failure in the middle of a tool call to a %s client', (to) => {
    const events = translate(RESPONSES, to, [...SOURCES[RESPONSES].tool, failed]);
    EXPECT_FAILED[to](events, 'backend failed');
    expectToolCallLeftOpen(to, events);
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

  it.each(CASES)('reports %s in a stream cut after its stop reason', (_label, from, _body, frames, reason) => {
    // Without the closing [DONE] or message_stop, and with the relay's error frame where the stream was cut.
    const cut = frames.slice(0, -1);
    for (const tail of [[], [RELAY_ERROR_FRAME]]) {
      const events = translate(from, RESPONSES, [...cut, ...tail]);
      expect(names(events)).not.toContain('response.failed');
      const final = JSON.parse(events.at(-2)!.data) as Json;
      expect(final.type).toBe('response.incomplete');
      expect(final.response.incomplete_details).toEqual({ reason });
    }
  });

  it.each(CASES)('reports %s when the seller answers a streamed request with JSON', (_label, from, body, _frames, reason) => {
    const transformed = transformResponse(response(body), { from, to: RESPONSES, streamRequested: true, fallbackModel: 'm' })!;
    const events = parseSse(decoder.decode(transformed.body));

    expect(names(events), FAILURE).not.toContain('response.completed');
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.type).toBe('response.incomplete');
    expect(final.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason } });
    const done = jsonFrames(events).filter((frame) => frame.type === 'response.output_item.done');
    expect(done.map((frame) => frame.item.status)).toEqual(['incomplete']);
    expect(done.map((frame) => frame.item)).toEqual(final.response.output);
    expect(events.at(-1)?.data).toBe('[DONE]');
  });

  it('marks only the cut item incomplete in a streamed answer', () => {
    const frames = [...SOURCES[CHAT].tool, chatChunk({}, 'length'), frame('[DONE]')];
    const events = translate(CHAT, RESPONSES, frames);
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.type).toBe('response.incomplete');
    expect(final.response.output).toMatchObject([
      { type: 'message', status: 'completed' },
      { type: 'function_call', arguments: '{"path":', status: 'incomplete' },
    ]);
    const done = jsonFrames(events).filter((body) => body.type === 'response.output_item.done');
    expect(done.map((body) => [body.item.type, body.item.status])).toEqual([['message', 'completed'], ['function_call', 'incomplete']]);
  });

  it('marks only the last of several tool calls incomplete', () => {
    const frames = [
      chatChunk({ role: 'assistant', content: '' }),
      chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      chatChunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'write', arguments: '{"path":' } }] }),
      chatChunk({}, 'length'),
      frame('[DONE]'),
    ];
    const final = JSON.parse(translate(CHAT, RESPONSES, frames).at(-2)!.data) as Json;
    expect(final.response.output.map((item: Json) => [item.call_id, item.status])).toEqual([['call_1', 'completed'], ['call_2', 'incomplete']]);
  });

  // Chat streams each tool call's arguments by index, so several can be unfinished when the answer is cut.
  it('marks every tool call whose arguments stop mid-value incomplete', () => {
    const calls = (finishReason: string) => [
      chatChunk({ role: 'assistant', content: '' }),
      chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"x":' } }] }),
      chatChunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'write', arguments: '{"y":' } }] }),
      chatChunk({}, finishReason),
      frame('[DONE]'),
    ];
    const statuses = (output: Json[]) => output.map((item) => [item.call_id, item.status]);
    const final = JSON.parse(translate(CHAT, RESPONSES, calls('length')).at(-2)!.data) as Json;
    expect(statuses(final.response.output)).toEqual([['call_1', 'incomplete'], ['call_2', 'incomplete']]);

    const body = chatBody('length');
    body.choices[0].message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"x":' } },
        { id: 'call_2', type: 'function', function: { name: 'write', arguments: '{"y":' } },
      ],
    };
    const answer = JSON.parse(decoder.decode(transformResponse(response(body), { from: CHAT, to: RESPONSES, fallbackModel: 'm' })!.body)) as Json;
    expect(statuses(answer.output)).toEqual([['call_1', 'incomplete'], ['call_2', 'incomplete']]);

    // An answer that finished on its own says its items are whole, whatever the arguments look like.
    const finished = JSON.parse(translate(CHAT, RESPONSES, calls('tool_calls')).at(-2)!.data) as Json;
    expect(statuses(finished.response.output)).toEqual([['call_1', 'completed'], ['call_2', 'completed']]);
  });

  it('leaves a finished tool call that takes no arguments completed', () => {
    const events = translate(MESSAGES, RESPONSES, [
      MESSAGE_START,
      typed('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'list', input: {} } }),
      typed('content_block_stop', { index: 0 }),
      typed('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      typed('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'The answer is' } }),
      typed('message_delta', { delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 7 } }),
      typed('message_stop', {}),
    ]);
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.response.output.map((item: Json) => [item.type, item.status])).toEqual([['message', 'incomplete'], ['function_call', 'completed']]);
  });

  // The message is rendered before the tool calls, but here the model wrote it after one and was cut in it.
  it('marks text cut after a finished tool call incomplete, not the tool call', () => {
    const statuses = (output: Json[]) => output.map((item) => [item.type, item.status]);
    const cutInText = [['message', 'incomplete'], ['function_call', 'completed']];
    const body = messagesBody('max_tokens');
    body.content = [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }, { type: 'text', text: 'The answer is' }];
    const answer = JSON.parse(decoder.decode(transformResponse(response(body), { from: MESSAGES, to: RESPONSES, fallbackModel: 'm' })!.body)) as Json;
    expect(statuses(answer.output)).toEqual(cutInText);

    const events = translate(MESSAGES, RESPONSES, [
      MESSAGE_START,
      typed('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} } }),
      typed('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }),
      typed('content_block_stop', { index: 0 }),
      typed('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      typed('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'The answer is' } }),
      typed('message_delta', { delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 7 } }),
      typed('message_stop', {}),
    ]);
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.type).toBe('response.incomplete');
    expect(statuses(final.response.output)).toEqual(cutInText);
    expect(statuses(jsonFrames(events).filter((frame) => frame.type === 'response.output_item.done').map((frame) => frame.item))).toEqual(cutInText);
  });

  it('leaves a finished tool call completed when the cut fell in an empty text block after it', () => {
    const statuses = (output: Json[]) => output.map((item) => [item.type, item.status]);
    const body = messagesBody('max_tokens');
    body.content = [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }, { type: 'text', text: '' }];
    const answer = JSON.parse(decoder.decode(transformResponse(response(body), { from: MESSAGES, to: RESPONSES, fallbackModel: 'm' })!.body)) as Json;
    expect(answer.status).toBe('incomplete');
    expect(statuses(answer.output)).toEqual([['function_call', 'completed']]);

    const events = translate(MESSAGES, RESPONSES, [
      MESSAGE_START,
      typed('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} } }),
      typed('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }),
      typed('content_block_stop', { index: 0 }),
      typed('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      typed('content_block_stop', { index: 1 }),
      typed('message_delta', { delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 7 } }),
      typed('message_stop', {}),
    ]);
    const final = JSON.parse(events.at(-2)!.data) as Json;
    expect(final.type).toBe('response.incomplete');
    expect(statuses(final.response.output)).toEqual([['function_call', 'completed']]);
    expect(statuses(jsonFrames(events).filter((frame) => frame.type === 'response.output_item.done').map((frame) => frame.item))).toEqual([['function_call', 'completed']]);
  });

  it('marks only the cut item incomplete in a not-streamed answer, and in its stream for a streamed request', () => {
    const body = chatBody('length');
    body.choices[0].message.tool_calls = [{ id: 'call_1', type: 'function', function: { name: 'write', arguments: '{"path":' } }];
    const answer = JSON.parse(decoder.decode(transformResponse(response(body), { from: CHAT, to: RESPONSES, fallbackModel: 'm' })!.body)) as Json;
    expect(answer.status).toBe('incomplete');
    expect(answer.output).toMatchObject([
      { type: 'message', status: 'completed' },
      { type: 'function_call', arguments: '{"path":', status: 'incomplete' },
    ]);

    const streamed = transformResponse(response(body), { from: CHAT, to: RESPONSES, streamRequested: true, fallbackModel: 'm' })!;
    const done = jsonFrames(parseSse(decoder.decode(streamed.body))).filter((frame) => frame.type === 'response.output_item.done');
    expect(done.map((frame) => [frame.item.type, frame.item.status])).toEqual([['message', 'completed'], ['function_call', 'incomplete']]);
  });

  it('tells the ending only in the final event when the seller answers a streamed request with JSON', () => {
    const transformed = transformResponse(response(chatBody('length')), { from: CHAT, to: RESPONSES, streamRequested: true, fallbackModel: 'm' })!;
    const [created] = jsonFrames(parseSse(decoder.decode(transformed.body)));
    expect(created!.type).toBe('response.created');
    expect(created!.response.status).toBe('in_progress');
    expect(created!.response).not.toHaveProperty('incomplete_details');
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
  // The text, then the frames that said how it finished, without the closing [DONE] or message_stop.
  const chatCutAfter = (finishReason: string): string[] => [...SOURCES[CHAT].text, chatChunk({}, finishReason)];
  const messagesCutAfter = (stopReason: string): string[] => [
    ...SOURCES[MESSAGES].text,
    typed('content_block_stop', { index: 0 }),
    typed('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 7 } }),
  ];
  const chatFinished = chatCutAfter('stop');
  const messagesFinished = messagesCutAfter('end_turn');

  it.each([MESSAGES, RESPONSES] as const)('a whole Chat stream to %s', (to) => {
    expectFinished(to, translate(CHAT, to, [...chatFinished, CHAT_USAGE, frame('[DONE]')]));
  });

  it.each([CHAT, RESPONSES] as const)('a whole Messages stream to %s', (to) => {
    expectFinished(to, translate(MESSAGES, to, [...messagesFinished, typed('message_stop', {})]));
  });

  it.each([MESSAGES, CHAT] as const)('a whole Responses stream to %s', (to) => {
    expectFinished(to, translate(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, RESPONSE_COMPLETED]));
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

  it.each([MESSAGES, RESPONSES] as const)('a Chat stream that failed after [DONE] and no finish_reason to %s', (to) => {
    expectFinished(to, translate(CHAT, to, [...SOURCES[CHAT].text, frame('[DONE]'), RELAY_ERROR_FRAME]), to === MESSAGES ? null : 'stop');
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
    expectFinished(to, translate(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, RESPONSE_COMPLETED, RELAY_ERROR_FRAME]));
  });

  it.each([MESSAGES, CHAT] as const)('a Responses stream with two response.completed events to %s', (to) => {
    expectFinished(to, translate(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, RESPONSE_COMPLETED, RESPONSE_COMPLETED]));
  });

  // The reason itself must survive a missing closing frame, not just the fact that the answer finished.
  it.each([
    ['Messages max_tokens', MESSAGES, CHAT, messagesCutAfter('max_tokens'), 'length'],
    ['Chat length', CHAT, MESSAGES, chatCutAfter('length'), 'max_tokens'],
  ] as const)('a stream cut after a %s reason keeps it', (_label, from, to, frames, reason) => {
    expectFinished(to, translate(from, to, [...frames]), reason);
    expectFinished(to, translate(from, to, [...frames, RELAY_ERROR_FRAME]), reason);
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

describe('nothing a source sends after its end reaches the client', () => {
  const AFTER_END = 'nothing after the end of a stream may reach the client';
  const TAIL = 'sent after the end';
  const TAIL_TOOL = 'tool_after_the_end';
  /** More text and a tool call, in the source's own protocol, after its stream ended. */
  const TAIL_FRAMES: Record<StreamProtocol, string[]> = {
    [CHAT]: [
      chatChunk({ content: TAIL }),
      chatChunk({ tool_calls: [{ index: 5, id: 'call_late', type: 'function', function: { name: TAIL_TOOL, arguments: `{"${TAIL}":` } }] }),
    ],
    [MESSAGES]: [
      typed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: TAIL } }),
      typed('content_block_start', { index: 5, content_block: { type: 'tool_use', id: 'call_late', name: TAIL_TOOL, input: {} } }),
      typed('content_block_delta', { index: 5, delta: { type: 'input_json_delta', partial_json: `{"${TAIL}":` } }),
    ],
    [RESPONSES]: [
      typed('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: TAIL }),
      typed('response.output_item.added', { output_index: 5, item: { type: 'function_call', id: 'fc_late', call_id: 'call_late', name: TAIL_TOOL, arguments: '', status: 'in_progress' } }),
      typed('response.function_call_arguments.delta', { output_index: 5, item_id: 'fc_late', delta: `{"${TAIL}":` }),
    ],
  };
  const leaked = (events: SseEvent[]): boolean => events.some((event) => event.data.includes(TAIL) || event.data.includes(TAIL_TOOL));
  /** The stream frame by frame, then all of it in one read. */
  const bothWays = (from: StreamProtocol, to: StreamProtocol, frames: string[]): SseEvent[][] =>
    [translate(from, to, frames), translate(from, to, [frames.join('')])];

  /** A different ending with other usage, in the source's own protocol, after its stream ended. */
  const LATE_ENDING: Record<StreamProtocol, string[]> = {
    [CHAT]: [chatChunk({}, 'length'), frame({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'm', choices: [], usage: { prompt_tokens: 9000, completion_tokens: 9000, total_tokens: 18000 } })],
    [MESSAGES]: [typed('message_delta', { delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 9000 } }), typed('message_stop', {})],
    [RESPONSES]: [typed('response.incomplete', { response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 9000, output_tokens: 9000, total_tokens: 18000 }, output: [] } })],
  };

  // The end is [DONE] for Chat, message_stop for Messages and response.completed for Responses.
  it.each(PAIRS)('after a finished %s stream, for a %s client', (from, to) => {
    for (const events of bothWays(from, to, [...SOURCES[from].text, ...SOURCES[from].finish, ...TAIL_FRAMES[from]])) {
      expect(leaked(events), AFTER_END).toBe(false);
      expectFinished(to, events);
      expect(streamedText(to, events)).toBe('The answer is');
    }
  });

  it.each([[MESSAGES, 'max_tokens'], [CHAT, 'length']] as const)('after response.incomplete, for a %s client', (to, reason) => {
    const incomplete = typed('response.incomplete', {
      response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107 }, output: [] },
    });
    for (const events of bothWays(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, incomplete, ...TAIL_FRAMES[RESPONSES]])) {
      expect(leaked(events), AFTER_END).toBe(false);
      expectFinished(to, events, reason);
      expect(streamedText(to, events)).toBe('The answer is');
    }
  });

  it.each(PAIRS)('after a finished %s stream, a later ending changes nothing for a %s client', (from, to) => {
    for (const events of bothWays(from, to, [...SOURCES[from].text, ...SOURCES[from].finish, ...LATE_ENDING[from]])) {
      expect(events.some((event) => event.data.includes('9000')), AFTER_END).toBe(false);
      expectFinished(to, events);
    }
  });

  it.each(PAIRS)('after a %s stream failed, for a %s client', (from, to) => {
    for (const events of bothWays(from, to, [...SOURCES[from].text, SOURCES[from].errorEvent, ...TAIL_FRAMES[from]])) {
      expect(leaked(events), AFTER_END).toBe(false);
      EXPECT_FAILED[to](events, 'upstream failed');
      expect(streamedText(to, events)).toBe('The answer is');
    }
  });

  it.each([MESSAGES, CHAT] as const)('after response.failed, for a %s client', (to) => {
    const failed = typed('response.failed', { response: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'backend failed' } } });
    for (const events of bothWays(RESPONSES, to, [RESPONSE_CREATED, RESPONSE_TEXT, failed, ...TAIL_FRAMES[RESPONSES]])) {
      expect(leaked(events), AFTER_END).toBe(false);
      EXPECT_FAILED[to](events, 'backend failed');
      expect(streamedText(to, events)).toBe('The answer is');
    }
  });

  it('keeps what comes after the last text but before the end: the stop reason and the usage', () => {
    const fromChat = translate(CHAT, MESSAGES, [...SOURCES[CHAT].text, chatChunk({}, 'length'), CHAT_USAGE, frame('[DONE]'), ...TAIL_FRAMES[CHAT]]);
    expect(jsonFrames(fromChat).find((body) => body.type === 'message_delta')).toMatchObject({
      delta: { stop_reason: 'max_tokens' },
      usage: { input_tokens: 100, output_tokens: 7 },
    });
    const fromMessages = translate(MESSAGES, CHAT, [...SOURCES[MESSAGES].text, ...SOURCES[MESSAGES].finish, ...TAIL_FRAMES[MESSAGES]]);
    expect(finishChunks(fromMessages)).toMatchObject([{ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 7 } }]);
  });

  it("still passes the relay's empty final chunk after the end", () => {
    const adapter = createStreamingAdapter({ from: MESSAGES, to: CHAT, fallbackModel: 'm' })!;
    for (const frame of [...SOURCES[MESSAGES].text, ...SOURCES[MESSAGES].finish, ...TAIL_FRAMES[MESSAGES]]) {
      adapter.adaptChunk({ requestId: 'req', data: encoder.encode(frame), done: false });
    }
    expect(adapter.adaptChunk({ requestId: 'req', data: new Uint8Array(0), done: true })).toEqual([{ requestId: 'req', data: new Uint8Array(0), done: true }]);
  });
});
