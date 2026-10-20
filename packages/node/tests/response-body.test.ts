import { describe, expect, it } from 'vitest';
import { ExposedSseStream, exposedJsonBody, type SellerCost } from '../src/utils/response-body.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import type { Provider, ProviderStreamCallbacks } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '../src/types/http.js';

const encode = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// $1 per million fresh input, $0.5 cached, $4 output.
const cost: SellerCost = (usage) => (usage.freshInputTokens * 1 + usage.cachedInputTokens * 0.5 + usage.outputTokens * 4) / 1_000_000;

const upstreamCompletion = {
  id: 'chatcmpl-1', model: 'm', provider: 'SomeHost', choices: [{ message: { content: 'ok' } }],
  usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 9e-7, cost: 0.0001, cost_details: { upstream_inference_cost: 0.0001 }, is_byok: false },
};

describe('exposedJsonBody', () => {
  it('replaces what the upstream says the request cost with the seller\'s price', () => {
    const body = JSON.parse(decode(exposedJsonBody(encode(upstreamCompletion), cost)));
    expect(body.usage).toEqual({ prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 });
    expect(body.provider).toBeUndefined();
    expect(body.choices[0].message.content).toBe('ok');
  });

  it('adds the seller\'s price where the upstream gave none', () => {
    const body = JSON.parse(decode(exposedJsonBody(encode({ usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 10 } }), cost)));
    expect(body.usage.estimated_cost).toBe(0.00024);
  });

  it('only drops the upstream cost when the price is not per token', () => {
    const body = JSON.parse(decode(exposedJsonBody(encode(upstreamCompletion))));
    expect(body.usage).toEqual({ prompt_tokens: 600, completion_tokens: 300 });
  });

  it('leaves bodies without usage byte for byte', () => {
    const plain = encode({ error: { message: 'x' } });
    expect(exposedJsonBody(plain, cost)).toBe(plain);
    const notJson = encode('not json "usage"');
    expect(exposedJsonBody(notJson, cost)).toBe(notJson);
  });
});

describe('ExposedSseStream', () => {
  it('prices a usage event even when it is split across chunks', () => {
    const stream = new ExposedSseStream(cost);
    const text = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
      + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 9e-7 } })}\n\n` + 'data: [DONE]\n\n';
    const cut = text.indexOf('estimated');
    const out = decode(stream.push(encode(text.slice(0, cut)))) + decode(stream.push(encode(text.slice(cut)))) + decode(stream.flush());
    expect(out).toBe('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
      + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 } })}\n\n` + 'data: [DONE]\n\n');
  });

  it('prices an Anthropic stream on its running totals', () => {
    const stream = new ExposedSseStream(cost);
    const start = `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 1 } } })}\n`;
    const delta = `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } })}\n`;
    const events = decode(stream.push(encode(start + delta))).split('\n').filter(Boolean).map((line) => JSON.parse(line.slice(6)));
    expect(events[1].usage.estimated_cost).toBe(0.00024);
  });
});

describe('seller response bodies', () => {
  const request: SerializedHttpRequest = { requestId: 'r1', method: 'POST', path: '/v1/chat/completions', headers: {}, body: new Uint8Array(0) };
  const execute = (provider: Partial<Provider>, callbacks?: ProviderStreamCallbacks) =>
    (Object.create(SellerRequestHandler.prototype) as { _executeRequest: (p: Partial<Provider>, r: SerializedHttpRequest, c?: SellerCost, s?: ProviderStreamCallbacks) => Promise<SerializedHttpResponse> })
      ._executeRequest(provider, request, cost, callbacks);

  it('carry the seller\'s price in a JSON response', async () => {
    const response = await execute({ handleRequest: async () => ({ requestId: 'r1', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encode(upstreamCompletion) }) });
    expect(JSON.parse(decode(response.body)).usage.estimated_cost).toBe(0.0018);
  });

  it('carry it in a stream, and return exactly the bytes the buyer was sent', async () => {
    const usageEvent = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 9e-7 } })}\n\n`;
    const parts = ['data: {"choices":[]}\n', '\n' + usageEvent.slice(0, 20), usageEvent.slice(20) + 'data: [DONE]\n\n'];
    const sent: SerializedHttpResponseChunk[] = [];
    const response = await execute({
      handleRequest: async () => { throw new Error('unused'); },
      handleRequestStream: async (_request, callbacks) => {
        const start = { requestId: 'r1', statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: new Uint8Array(0) };
        callbacks.onResponseStart(start);
        parts.forEach((part, index) => callbacks.onResponseChunk({ requestId: 'r1', data: encode(part), done: index === parts.length - 1 }));
        return { ...start, body: encode(parts.join('')) };
      },
    }, { onResponseStart: () => {}, onResponseChunk: (chunk) => { sent.push(chunk); } });
    const delivered = sent.map((chunk) => decode(chunk.data)).join('');
    expect(delivered).toContain('"estimated_cost":0.0018');
    expect(delivered).not.toContain('9e-7');
    expect(sent.at(-1)?.done).toBe(true);
    expect(decode(response.body)).toBe(delivered);
  });
});
