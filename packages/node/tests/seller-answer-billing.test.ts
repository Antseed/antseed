import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { estimateTokensFromBytesSampled, estimateTokensFromText } from '../src/payments/pricing.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider, ProviderStreamCallbacks } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import { VerificationMux } from '../src/verification/index.js';

const encoder = new TextEncoder();
const BUYER = '22'.repeat(20);
const CHANNEL = '0x' + 'ab'.repeat(32);
/** $1 per million tokens: N tokens price to exactly N base units. */
const PRICE = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
const REQUEST_BODY = encoder.encode(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'Tell me about seeds.' }], stream: true }));
const REQUEST_TOKENS = estimateTokensFromBytesSampled(REQUEST_BODY);

/** One SSE event of an OpenAI chat stream. */
const chunk = (fields: Record<string, unknown>): string => `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'test-model', ...fields })}\n\n`;
const textDelta = (content: string): string => chunk({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const DONE = 'data: [DONE]\n\n';

/** A provider that streams `events`, as a relay does. */
function streamingProvider(events: string[], pricing = PRICE): Provider {
  return {
    name: 'p',
    services: ['test-model'],
    pricing: { defaults: pricing },
    maxConcurrency: 1,
    handleRequest: vi.fn(),
    handleRequestStream: vi.fn(async (request: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => {
      const headers = { 'content-type': 'text/event-stream' };
      callbacks.onResponseStart({ requestId: request.requestId, statusCode: 200, headers, body: new Uint8Array(0) });
      for (const event of events) callbacks.onResponseChunk({ requestId: request.requestId, data: encoder.encode(event), done: false });
      callbacks.onResponseChunk({ requestId: request.requestId, data: new Uint8Array(0), done: true });
      return { requestId: request.requestId, statusCode: 200, headers, body: encoder.encode(events.join('')) };
    }),
    getCapacity: () => ({ current: 0, max: 1 }),
  };
}

/** A provider that answers in one piece. */
function plainProvider(statusCode: number, body: unknown, pricing = PRICE): Provider {
  return {
    name: 'p',
    services: ['test-model'],
    pricing: { defaults: pricing },
    maxConcurrency: 1,
    handleRequest: vi.fn(async (request: SerializedHttpRequest) => ({
      requestId: request.requestId, statusCode, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)),
    })),
    getCapacity: () => ({ current: 0, max: 1 }),
  };
}

/** A buyer with an open channel, and what the seller records and asks for on it. */
function paymentManager() {
  let spent = 0n;
  const manager = {
    hasSession: () => true,
    hasClosingChannel: () => false,
    getChannelByPeer: () => ({ sessionId: CHANNEL, authMax: '0' }),
    waitForPendingAuths: async () => {},
    getAcceptedCumulative: () => 0n,
    getCumulativeSpend: () => spent,
    getEffectiveReserveMax: () => 1_000_000_000n,
    isChannelBlocked: () => false,
    beginBillableRequest: () => {},
    endBillableRequest: () => {},
    recordSpend: (_channel: string, amount: bigint) => { spent += amount; },
  };
  return { manager, spent: () => spent };
}

/** Serves one request on a paid channel and returns the answer, the spend recorded and the NeedAuth sent. */
async function serve(provider: Provider, { path = '/v1/chat/completions', body = REQUEST_BODY, contentType = 'application/json' }: { path?: string; body?: Uint8Array; contentType?: string } = {}) {
  const { manager, spent } = paymentManager();
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [provider],
    sellerPaymentManager: manager as any,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit: () => false,
  });
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const sendNeedAuth = vi.fn();
  const { mux } = handler.handleConnection(conn as any, BUYER, { sendNeedAuth, sendPaymentRequired: vi.fn() } as any, new VerificationMux(conn as any));
  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({ requestId: 'req-1', method: 'POST', path, headers: { 'content-type': contentType }, body }),
  });
  const frame = conn.send.mock.calls.map(([raw]) => decodeFrame(raw)!.message).find((message) => message.type === MessageType.HttpResponse)!;
  return { response: decodeHttpResponse(frame.payload), spent: spent(), needAuth: sendNeedAuth.mock.calls[0]?.[0] as Record<string, string> | undefined };
}

describe('seller billing of an answer without a usage report', () => {
  it('charges a streamed chat answer an estimate from its prompt and its text, not its framing', async () => {
    const text = 'Seeds store a young plant and the food it needs to start growing, for a season or for centuries.';
    const words = text.split(/(?<= )/);
    const { spent, needAuth } = await serve(streamingProvider([...words.map(textDelta), chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), DONE]));

    const outputTokens = estimateTokensFromText(text);
    expect(needAuth).toMatchObject({
      inputTokens: String(REQUEST_TOKENS),
      freshInputTokens: String(REQUEST_TOKENS),
      cachedInputTokens: '0',
      outputTokens: String(outputTokens),
      lastRequestCost: String(REQUEST_TOKENS + outputTokens),
    });
    expect(spent).toBe(BigInt(REQUEST_TOKENS + outputTokens));
  });

  it('counts reasoning and tool arguments as generated output', async () => {
    const events = [
      chunk({ choices: [{ index: 0, delta: { reasoning_content: 'The user wants a call. ' }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"seed":' } }] }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"oak"}' } }] }, finish_reason: null }] }),
      DONE,
    ];
    const { needAuth } = await serve(streamingProvider(events));
    expect(needAuth?.outputTokens).toBe(String(estimateTokensFromText('The user wants a call. lookup{"seed":"oak"}')));
  });

  it('charges a chat answer sent in one piece that reports no usage', async () => {
    const text = 'Seeds store a young plant.';
    const { needAuth } = await serve(plainProvider(200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
    expect(needAuth).toMatchObject({ inputTokens: String(REQUEST_TOKENS), outputTokens: String(estimateTokensFromText(text)) });
  });

  it('estimates the prompt whatever content type the request declares', async () => {
    const text = 'Seeds store a young plant.';
    const { needAuth } = await serve(
      plainProvider(200, { choices: [{ index: 0, message: { role: 'assistant', content: text } }] }),
      { contentType: 'text/plain' },
    );
    expect(needAuth).toMatchObject({ inputTokens: String(REQUEST_TOKENS), outputTokens: String(estimateTokensFromText(text)) });
  });

  it('counts an attachment as a flat allowance, not by its encoded size or its link', async () => {
    const answer = { choices: [{ index: 0, message: { role: 'assistant', content: 'A seed.' } }] };
    const withImage = (url: string) => encoder.encode(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url } }] }] }));
    const inline = await serve(plainProvider(200, answer), { body: withImage(`data:image/png;base64,${'A'.repeat(1_000_000)}`) });
    const linked = await serve(plainProvider(200, answer), { body: withImage('https://example.com/seed.png') });
    const text = estimateTokensFromBytesSampled(encoder.encode(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url' }] }] })));
    expect(inline.needAuth?.inputTokens).toBe(String(text + 1290));
    expect(linked.needAuth?.inputTokens).toBe(String(text + 1290));
  });

  it('counts a tool schema property named like an attachment as text', async () => {
    const body = encoder.encode(JSON.stringify({ model: 'test-model', messages: [], tools: [{ type: 'function', function: { name: 'read', parameters: { properties: { file: { type: 'string' } } } } }] }));
    const { needAuth } = await serve(plainProvider(200, { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }), { body });
    expect(needAuth?.inputTokens).toBe(String(estimateTokensFromBytesSampled(body)));
  });

  it('counts only what the model wrote, not metadata beside it', async () => {
    const { needAuth } = await serve(streamingProvider([
      chunk({ choices: [{ index: 0, delta: { content: 'Seeds.', reasoning_details: [{ type: 'reasoning.encrypted', data: 'x'.repeat(4_000), signature: 'y'.repeat(4_000) }], annotations: [{ url: 'https://example.com/a-very-long-link' }] }, logprobs: { content: [{ token: 'Seeds' }] }, finish_reason: 'stop' }] }),
      DONE,
    ]));
    expect(needAuth?.outputTokens).toBe(String(estimateTokensFromText('Seeds.')));
  });

  it('treats a usage report of all zeros as no report', async () => {
    const text = 'Seeds store a young plant.';
    const { needAuth } = await serve(streamingProvider([textDelta(text), chunk({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), DONE]));
    expect(needAuth).toMatchObject({ inputTokens: String(REQUEST_TOKENS), outputTokens: String(estimateTokensFromText(text)) });
  });

  it('charges a legacy completion that reports no usage', async () => {
    const text = 'Seeds store a young plant.';
    const { needAuth } = await serve(plainProvider(200, { id: 'x', object: 'text_completion', choices: [{ index: 0, text, finish_reason: 'stop' }] }), { path: '/v1/completions' });
    expect(needAuth?.outputTokens).toBe(String(estimateTokensFromText(text)));
  });

  it('bills the reported usage, never an estimate, when the answer has one', async () => {
    const { spent, needAuth } = await serve(streamingProvider([
      textDelta('A much longer answer than the usage below would suggest, on purpose.'),
      chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      DONE,
    ]));
    expect(needAuth).toMatchObject({ inputTokens: '3', outputTokens: '2', lastRequestCost: '5' });
    expect(spent).toBe(5n);
  });

  it('charges nothing by estimate for a stream that failed', async () => {
    const { spent, needAuth } = await serve(streamingProvider([textDelta('Seeds store'), 'event: error\ndata: upstream dropped\n\n']));
    expect(needAuth?.lastRequestCost).toBe('0');
    expect(spent).toBe(0n);
  });

  it('charges nothing for an upstream error', async () => {
    const { spent, needAuth } = await serve(plainProvider(500, { choices: [{ index: 0, message: { role: 'assistant', content: 'never delivered' } }] }));
    expect(needAuth?.lastRequestCost).toBe('0');
    expect(spent).toBe(0n);
  });

  it('charges nothing for an answer that is not a chat answer', async () => {
    const { spent, needAuth } = await serve(plainProvider(200, { ok: true }));
    expect(needAuth?.lastRequestCost).toBe('0');
    expect(spent).toBe(0n);
  });

  it('never charges a free service', async () => {
    const { spent, needAuth } = await serve(streamingProvider([textDelta('Free words.'), DONE], { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }));
    expect(needAuth).toBeUndefined();
    expect(spent).toBe(0n);
  });
});

describe('seller request paths', () => {
  const chatAnswer = { choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };

  it.each([
    ['a chat request to an image service', '/v1/chat/completions', ['openai-images']],
    ['a legacy completion to a chat service', '/v1/completions', ['openai-chat-completions']],
    ['an image request to a chat service', '/v1/images/generations', ['openai-chat-completions']],
  ] as const)('refuses %s before billing or reaching the provider', async (_shape, path, protocols) => {
    const provider = { ...plainProvider(200, chatAnswer), serviceApiProtocols: { 'test-model': [...protocols] } };
    const { response, spent, needAuth } = await serve(provider, { path });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(response.body)).error.code).toBe('invalid_billing_request');
    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(needAuth).toBeUndefined();
    expect(spent).toBe(0n);
  });

  it.each([
    ['its own protocol', '/v1/chat/completions', ['openai-chat-completions']],
    ['a protocol the buyer can translate to it', '/v1/messages', ['openai-chat-completions']],
    ['a path no protocol claims', '/v1/embeddings', ['openai-chat-completions']],
  ] as const)('serves a request on %s', async (_shape, path, protocols) => {
    const provider = { ...plainProvider(200, chatAnswer), serviceApiProtocols: { 'test-model': [...protocols] } };
    const { response } = await serve(provider, { path });
    expect(response.statusCode).toBe(200);
    expect(provider.handleRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a dot segment', '/v1/./chat/completions'],
    ['a parent segment', '/x/../v1/chat/completions'],
    ['a parent segment after a known prefix', '/v1/responses/../chat/completions'],
    ['an encoded dot segment', '/v1/%2e/chat/completions'],
    ['an encoded parent segment', '/x/%2E%2e/v1/chat/completions'],
    ['an encoded letter', '/v1/chat/complet%69ons'],
    ['an encoded slash', '/v1%2Fchat%2Fcompletions'],
    ['an empty segment', '/v1//chat/completions'],
    ['a leading double slash', '//v1/chat/completions'],
    ['backslashes', '/v1\\chat\\completions'],
    ['no leading slash', 'v1/chat/completions'],
    ['a control character', '/v1/\tchat/completions'],
    ['a fragment', '/v1/responses#/../chat/completions'],
    ['a path parameter', '/v1;x=1/chat/completions'],
  ])('refuses a path with %s before billing or reaching the provider', async (_shape, path) => {
    const provider = plainProvider(200, chatAnswer);
    const { response, spent, needAuth } = await serve(provider, { path });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(response.body)).error.code).toBe('invalid_request_path');
    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(needAuth).toBeUndefined();
    expect(spent).toBe(0n);
  });

  it.each([
    ['the plain path', '/v1/chat/completions'],
    ['a query string, whatever it holds', '/v1/messages?beta=true&next=/a/../b%2F'],
    ['a trailing slash', '/v1/chat/completions/'],
    ['a colon in a segment', '/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'],
    ['a dot inside a segment', '/v1/models.v2/chat.completions'],
    ['a resource id', '/v1/responses/resp_1-a~b/cancel'],
  ])('serves %s', async (_shape, path) => {
    const provider = plainProvider(200, chatAnswer);
    const { response } = await serve(provider, { path });
    expect(response.statusCode).toBe(200);
    expect(provider.handleRequest).toHaveBeenCalledTimes(1);
  });
});
