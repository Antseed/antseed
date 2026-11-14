import { describe, expect, it } from 'vitest';
import { exposedResponseHeaders, isExposedResponseHeader } from '../src/utils/response-headers.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import type { Provider, ProviderStreamCallbacks } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';

describe('exposedResponseHeaders', () => {
  it('keeps only Antseed headers and the generic ones clients act on', () => {
    expect(exposedResponseHeaders({
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'retry-after': '30',
      'x-antseed-streaming': '1',
      'x-codex-primary-used-percent': '37',
      'x-codex-turn-state': 'secret-session-state',
      'x-oai-request-id': 'req_upstream',
      'x-ratelimit-remaining-requests': '99',
      'anthropic-ratelimit-tokens-remaining': '1000',
      'set-cookie': '__cflb=abc',
      'server': 'cloudflare',
      'cf-ray': 'abc-ORD',
      'strict-transport-security': 'max-age=31536000',
    })).toEqual({
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'retry-after': '30',
      'x-antseed-streaming': '1',
    });
  });

  it('matches header names in any case', () => {
    expect(isExposedResponseHeader('Content-Type')).toBe(true);
    expect(isExposedResponseHeader('X-Antseed-Video-Price-Usdc')).toBe(true);
    expect(isExposedResponseHeader('X-Codex-Plan-Type')).toBe(false);
  });
});

describe('seller responses', () => {
  const upstreamHeaders = { 'content-type': 'text/event-stream', 'x-antseed-streaming': '1', 'x-codex-plan-type': 'pro', 'set-cookie': '__cflb=abc' };
  const request = { requestId: 'r1', method: 'POST', path: '/v1/responses', headers: {}, body: new Uint8Array(0) };
  // Every provider call goes through `_executeRequest`, whatever the plugin.
  const execute = (provider: Partial<Provider>, callbacks?: ProviderStreamCallbacks) =>
    (Object.create(SellerRequestHandler.prototype) as { _executeRequest: (p: Partial<Provider>, r: SerializedHttpRequest, cost?: undefined, c?: ProviderStreamCallbacks) => Promise<SerializedHttpResponse> })
      ._executeRequest(provider, request, undefined, callbacks);

  it('never carry a provider\'s upstream headers', async () => {
    const response = await execute({ handleRequest: async () => ({ requestId: 'r1', statusCode: 200, headers: upstreamHeaders, body: new Uint8Array(0) }) });
    expect(response.headers).toEqual({ 'content-type': 'text/event-stream', 'x-antseed-streaming': '1' });
  });

  it('strip them from a streamed response\'s start too', async () => {
    let started: SerializedHttpResponse | undefined;
    const response = await execute({
      handleRequest: async () => { throw new Error('unused'); },
      handleRequestStream: async (_request, callbacks) => {
        const start = { requestId: 'r1', statusCode: 200, headers: upstreamHeaders, body: new Uint8Array(0) };
        callbacks.onResponseStart(start);
        return start;
      },
    }, { onResponseStart: (start) => { started = start; }, onResponseChunk: () => {} });
    expect(started?.headers).toEqual({ 'content-type': 'text/event-stream', 'x-antseed-streaming': '1' });
    expect(response.headers).toEqual(started?.headers);
  });
});
