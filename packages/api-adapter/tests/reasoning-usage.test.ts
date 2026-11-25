import { describe, expect, it } from 'vitest';
import { createStreamingAdapter, extractUsage, transformResponse, type ServiceApiProtocol } from '../src/index.js';

const MESSAGES = 'anthropic-messages';
const CHAT = 'openai-chat-completions';
const RESPONSES = 'openai-responses';
const PROTOCOLS: ServiceApiProtocol[] = [MESSAGES, CHAT, RESPONSES];
const PAIRS = PROTOCOLS.flatMap((from) => PROTOCOLS.filter((to) => to !== from).map((to) => ({ from, to })));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A seller's usage in its own protocol: 10 input and 300 output tokens, `reasoning` of them spent reasoning (undefined: not itemised). */
function sellerUsage(protocol: ServiceApiProtocol, reasoning: number | undefined): Record<string, unknown> {
  if (protocol === MESSAGES) {
    return { input_tokens: 10, output_tokens: 300, ...(reasoning !== undefined ? { output_tokens_details: { thinking_tokens: reasoning } } : {}) };
  }
  if (protocol === CHAT) {
    return { prompt_tokens: 10, completion_tokens: 300, total_tokens: 310, ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) };
  }
  return { input_tokens: 10, output_tokens: 300, total_tokens: 310, ...(reasoning !== undefined ? { output_tokens_details: { reasoning_tokens: reasoning } } : {}) };
}

/** The usage a client of `protocol` must read for that same answer. */
function clientUsage(protocol: ServiceApiProtocol, reasoning: number | undefined): Record<string, unknown> {
  if (protocol === MESSAGES) {
    return { input_tokens: 10, output_tokens: 300, ...(reasoning !== undefined ? { output_tokens_details: { thinking_tokens: reasoning } } : {}) };
  }
  return sellerUsage(protocol, reasoning);
}

function sellerJson(protocol: ServiceApiProtocol, reasoning: number | undefined): Record<string, unknown> {
  const usage = sellerUsage(protocol, reasoning);
  if (protocol === MESSAGES) {
    return { id: 'msg_1', type: 'message', role: 'assistant', model: 'example-model', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', stop_sequence: null, usage };
  }
  if (protocol === CHAT) {
    return { id: 'chatcmpl-1', object: 'chat.completion', model: 'example-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }], usage };
  }
  return {
    id: 'resp_1', object: 'response', model: 'example-model', status: 'completed',
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }],
    usage,
  };
}

function sellerStream(protocol: ServiceApiProtocol, reasoning: number | undefined): string {
  const usage = sellerUsage(protocol, reasoning);
  const event = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  if (protocol === MESSAGES) {
    return event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'example-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } })
      + event('content_block_stop', { index: 0 })
      // As the Messages API does: the reasoning breakdown comes only with the final message_delta.
      + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 300, ...(reasoning !== undefined ? { output_tokens_details: { thinking_tokens: reasoning } } : {}) } })
      + event('message_stop', {});
  }
  if (protocol === CHAT) {
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'example-model', choices, ...extra })}\n\n`;
    return chunk([{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }])
      + chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
      + chunk([], { usage })
      + 'data: [DONE]\n\n';
  }
  return event('response.created', { response: { id: 'resp_1', model: 'example-model', status: 'in_progress' } })
    + event('response.output_text.delta', { delta: 'Done.' })
    + event('response.completed', { response: sellerJson(RESPONSES, reasoning) });
}

/** The usage of a translated JSON answer. */
function translatedJsonUsage(from: ServiceApiProtocol, to: ServiceApiProtocol, reasoning: number | undefined): unknown {
  const answer = transformResponse({
    requestId: 'req-reasoning-usage', statusCode: 200, headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify(sellerJson(from, reasoning))),
  }, { from, to });
  return (JSON.parse(decoder.decode(answer!.body)) as { usage: unknown }).usage;
}

/** The last usage a client of `protocol` reads in a stream of that protocol. */
function finalStreamUsage(protocol: ServiceApiProtocol, sse: string): unknown {
  const payloads = sse.split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  if (protocol === MESSAGES) return payloads.filter((payload) => payload.type === 'message_delta').at(-1)?.usage;
  if (protocol === CHAT) return payloads.filter((payload) => payload.usage).at(-1)?.usage;
  return (payloads.filter((payload) => payload.type === 'response.completed').at(-1)?.response as { usage?: unknown } | undefined)?.usage;
}

/** The final usage of a seller's live stream, translated for the client. */
function translatedStreamUsage(from: ServiceApiProtocol, to: ServiceApiProtocol, reasoning: number | undefined): unknown {
  const adapter = createStreamingAdapter({ from, to })!;
  const chunks = adapter.adaptChunk({ requestId: 'req-reasoning-usage', data: encoder.encode(sellerStream(from, reasoning)), done: true });
  return finalStreamUsage(to, chunks.map((chunk) => decoder.decode(chunk.data)).join(''));
}

/** The final usage of the stream built for a client that asked for one, when the seller answered with JSON. */
function builtStreamUsage(from: ServiceApiProtocol, to: ServiceApiProtocol, reasoning: number | undefined): unknown {
  const answer = transformResponse({
    requestId: 'req-reasoning-usage', statusCode: 200, headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify(sellerJson(from, reasoning))),
  }, { from, to, streamRequested: true });
  return finalStreamUsage(to, decoder.decode(answer!.body));
}

describe('reasoning token count in a translated JSON answer', () => {
  it.each(PAIRS)('preserves the count from a $from seller for a $to client', ({ from, to }) => {
    expect(translatedJsonUsage(from, to, 250)).toEqual(clientUsage(to, 250));
  });

  it.each(PAIRS)('preserves a reported zero from a $from seller for a $to client', ({ from, to }) => {
    expect(translatedJsonUsage(from, to, 0)).toEqual(clientUsage(to, 0));
  });

  it.each(PAIRS)('invents no count when a $from seller itemises none for a $to client', ({ from, to }) => {
    expect(translatedJsonUsage(from, to, undefined)).toEqual(clientUsage(to, undefined));
  });
});

describe('reasoning token count at the end of a translated stream', () => {
  it.each(PAIRS)('preserves the count from a $from seller for a $to client', ({ from, to }) => {
    expect(translatedStreamUsage(from, to, 250)).toMatchObject(clientUsage(to, 250));
  });

  it.each(PAIRS)('preserves a reported zero from a $from seller for a $to client', ({ from, to }) => {
    expect(translatedStreamUsage(from, to, 0)).toMatchObject(clientUsage(to, 0));
  });

  it.each(PAIRS)('invents no count when a $from seller itemises none for a $to client', ({ from, to }) => {
    const usage = translatedStreamUsage(from, to, undefined) as Record<string, unknown>;
    expect(usage).not.toHaveProperty('completion_tokens_details');
    expect(usage).not.toHaveProperty('output_tokens_details');
  });
});

describe('reasoning token count in a stream built from a JSON answer', () => {
  it.each(PAIRS)('preserves the count from a $from seller for a $to client', ({ from, to }) => {
    // A built Messages stream reports its input in message_start; its final message_delta carries the output side.
    const { input_tokens: _input, ...messagesOutput } = clientUsage(MESSAGES, 250);
    expect(builtStreamUsage(from, to, 250)).toMatchObject(to === MESSAGES ? messagesOutput : clientUsage(to, 250));
  });

  it.each(PAIRS)('invents no count when a $from seller itemises none for a $to client', ({ from, to }) => {
    const usage = builtStreamUsage(from, to, undefined) as Record<string, unknown>;
    expect(usage).not.toHaveProperty('completion_tokens_details');
    expect(usage).not.toHaveProperty('output_tokens_details');
  });
});

describe('reasoning token count in a stream built from a JSON answer, reported as zero', () => {
  it.each(PAIRS)('preserves a reported zero from a $from seller for a $to client', ({ from, to }) => {
    const { input_tokens: _input, ...messagesOutput } = clientUsage(MESSAGES, 0);
    expect(builtStreamUsage(from, to, 0)).toMatchObject(to === MESSAGES ? messagesOutput : clientUsage(to, 0));
  });
});

/** The final usage a client of `to` reads when a `from` seller streams exactly `sse`, fed in pieces of `size` bytes. */
function streamedUsage(from: ServiceApiProtocol, to: ServiceApiProtocol, sse: string, size = Number.POSITIVE_INFINITY): unknown {
  const adapter = createStreamingAdapter({ from, to })!;
  const bytes = encoder.encode(sse);
  const step = Math.min(size, bytes.length);
  let out = '';
  for (let start = 0; start < bytes.length; start += step) {
    const done = start + step >= bytes.length;
    for (const chunk of adapter.adaptChunk({ requestId: 'req-reasoning-usage', data: bytes.slice(start, start + step), done })) {
      out += decoder.decode(chunk.data, { stream: true });
    }
  }
  return finalStreamUsage(to, out);
}

const event = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
const chatChunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'example-model', choices, ...extra })}\n\n`;

describe('reasoning token count read from a stream', () => {
  it.each(PAIRS)('is the same when a $from stream arrives a few bytes at a time for a $to client', ({ from, to }) => {
    expect(streamedUsage(from, to, sellerStream(from, 250), 7)).toMatchObject(clientUsage(to, 250));
  });

  it('keeps the cache split beside the count', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 250 } };
    const sse = chatChunk([{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }])
      + chatChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) + chatChunk([], { usage }) + 'data: [DONE]\n\n';
    expect(streamedUsage(CHAT, MESSAGES, sse)).toEqual({ input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 300, output_tokens_details: { thinking_tokens: 250 } });
    expect(streamedUsage(CHAT, RESPONSES, sse)).toEqual({ input_tokens: 1000, output_tokens: 300, total_tokens: 1300, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 250 } });
  });

  it('reaches a Messages client whose seller reported no input', () => {
    const usage = { prompt_tokens: 0, completion_tokens: 300, total_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } };
    const sse = chatChunk([{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }])
      + chatChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) + chatChunk([], { usage }) + 'data: [DONE]\n\n';
    expect(streamedUsage(CHAT, MESSAGES, sse)).toEqual({ output_tokens: 300, output_tokens_details: { thinking_tokens: 250 } });
  });
});

describe('a reasoning token count and the output total it belongs to', () => {
  it('reads the count only where the answer\'s own protocol itemises it', () => {
    const answer = sellerJson(RESPONSES, 12);
    // A seller that adds another protocol's field, here with its default of 0.
    (answer.usage as Record<string, unknown>).completion_tokens_details = { reasoning_tokens: 0 };
    const translated = transformResponse({
      requestId: 'req-reasoning-usage', statusCode: 200, headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify(answer)),
    }, { from: RESPONSES, to: CHAT });
    expect((JSON.parse(decoder.decode(translated!.body)) as { usage: unknown }).usage).toMatchObject({ completion_tokens_details: { reasoning_tokens: 12 } });
  });

  it('drops a Responses breakdown from an earlier event when the final total comes without one', () => {
    const final = sellerJson(RESPONSES, undefined);
    final.usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 };
    const sse = event('response.created', { response: { id: 'resp_1', model: 'example-model', status: 'in_progress', usage: sellerUsage(RESPONSES, 12) } })
      + event('response.output_text.delta', { delta: 'Done.' })
      + event('response.completed', { response: final });
    expect(streamedUsage(RESPONSES, CHAT, sse)).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });

  it('drops a Messages breakdown from an earlier event when a later output total comes without one', () => {
    const sse = event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'example-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 30, output_tokens_details: { thinking_tokens: 12 } } } })
      + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } })
      + event('content_block_stop', { index: 0 })
      + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
      + event('message_stop', {});
    expect(streamedUsage(MESSAGES, CHAT, sse)).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });

  it('takes a Chat stream\'s last usage report whole, breakdown included', () => {
    const first = { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } };
    const last = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
    const sse = chatChunk([{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }], { usage: first })
      + chatChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) + chatChunk([], { usage: last }) + 'data: [DONE]\n\n';
    expect(streamedUsage(CHAT, RESPONSES, sse)).toEqual({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  });
});

describe('the usage billing reads', () => {
  it.each(PROTOCOLS)('is the same four counts for a %s answer, with or without a reasoning count', (protocol) => {
    const expected = { inputTokens: 10, outputTokens: 300, freshInputTokens: 10, cachedInputTokens: 0 };
    expect(extractUsage(sellerJson(protocol, 250))).toEqual(expected);
    expect(extractUsage(sellerJson(protocol, undefined))).toEqual(expected);
  });
});
