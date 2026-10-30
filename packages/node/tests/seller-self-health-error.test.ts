import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler, assertSameNameUpstreamsAgree } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';

function makeProvider(name: string, statusCode: number): Provider {
  return {
    name,
    services: ['test-model'],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 1,
    handleRequest: vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(statusCode >= 400 ? { error: { message: 'upstream overloaded' } } : { ok: true })),
    })),
    getCapacity: () => ({ current: 0, max: 1 }),
  };
}

async function serve(providers: Provider[], emit: (event: string, ...args: unknown[]) => boolean = () => false, headers: Record<string, string> = {}) {
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers,
    sellerPaymentManager: null,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit,
  });
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const { mux } = handler.handleConnection(conn as any, '22'.repeat(20), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any, new VerificationMux(conn as any));
  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({
      requestId: 'req-1', method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', ...headers },
      body: new TextEncoder().encode(JSON.stringify({ model: 'test-model' })),
    }),
  });
  const frame = conn.send.mock.calls.map(([raw]) => decodeFrame(raw)!.message).find((message) => message.type === MessageType.HttpResponse)!;
  return decodeHttpResponse(frame.payload);
}

describe('seller self health error', () => {
  const failing = { status: 'failing' as const, reason: 'timeout' as const, consecutiveFailures: 3, failingSince: 1_700_000_000_000 };

  it('explains an upstream failure of a model its own health check marks failing', async () => {
    const provider = makeProvider('p', 502);
    provider.serviceHealth = { 'test-model': failing };
    const events: Array<[string, unknown]> = [];
    const response = await serve([provider], (event, payload) => { events.push([event, payload]); return true; });
    expect(response.statusCode).toBe(503);
    const error = JSON.parse(new TextDecoder().decode(response.body)).error;
    expect(error).toMatchObject({ code: 'seller_self_health_failing', service: 'test-model', service_health: failing, upstream_status: 502 });
    expect(error.message).not.toContain('upstream overloaded');
    // The health checker still sees the upstream's own body.
    expect(events.find(([event]) => event === 'provider:response')?.[1]).toMatchObject({ service: 'test-model', statusCode: 502, body: expect.stringContaining('upstream overloaded') });
  });

  it('passes upstream errors through unchanged while the model is healthy', async () => {
    const response = await serve([makeProvider('p', 502)]);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ error: { message: 'upstream overloaded' } });
  });

  it('prefers a provider whose health check is not failing the model', async () => {
    const down = makeProvider('down', 502);
    down.serviceHealth = { 'test-model': failing };
    const up = makeProvider('up', 200);
    const response = await serve([down, up]);
    expect(response.statusCode).toBe(200);
    expect(down.handleRequest).not.toHaveBeenCalled();
  });

  it('prefers a healthy upstream among those sharing the requested provider name', async () => {
    const down = makeProvider('openai', 502);
    down.serviceHealth = { 'test-model': failing };
    const up = makeProvider('openai', 200);
    const response = await serve([down, up], undefined, { 'x-antseed-provider': 'openai' });
    expect(response.statusCode).toBe(200);
    expect(down.handleRequest).not.toHaveBeenCalled();
  });
});

describe('upstreams sharing a provider name', () => {
  it('keeps video requests on the first matching upstream, where a job lives', () => {
    const first = makeProvider('venice', 200);
    first.services = ['video-model'];
    first.serviceApiProtocols = { 'video-model': ['venice-video'] };
    first.serviceHealth = { 'video-model': { status: 'failing', reason: 'out_of_credit' } };
    const second = { ...makeProvider('venice', 200), services: ['video-model'], serviceApiProtocols: first.serviceApiProtocols };
    const handler = new SellerRequestHandler({
      identity: identityFromPrivateKeyHex('11'.repeat(32)),
      providers: [first, second],
      sellerPaymentManager: null, sessionTracker: null, channelsClient: null, announcer: null, emit: () => false,
    });
    const retrieve = {
      requestId: 'r', method: 'POST', path: '/api/v1/video/retrieve', headers: { 'content-type': 'application/json', 'x-antseed-provider': 'venice', 'x-antseed-service': 'video-model' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'video-model', queue_id: 'job' })),
    };
    expect(handler.matchProvider(retrieve)).toBe(first);
  });

  it('may share a name when they offer a service on the same terms', () => {
    expect(() => assertSameNameUpstreamsAgree([makeProvider('openai', 200), makeProvider('OpenAI', 200)])).not.toThrow();
  });

  it('refuses one name for a service offered on different terms', () => {
    const cheap = makeProvider('openai', 200);
    const pricey = makeProvider('openai', 200);
    pricey.pricing = { defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 } };
    expect(() => assertSameNameUpstreamsAgree([cheap, pricey])).toThrow(/sharing the name "openai" offer "test-model"/);
    const images = makeProvider('openai', 200);
    images.serviceApiProtocols = { 'test-model': ['openai-images'] };
    expect(() => assertSameNameUpstreamsAgree([cheap, images])).toThrow(/from one of them only, or on the same terms/);
    expect(() => assertSameNameUpstreamsAgree([cheap, { ...images, name: 'fal-video' }])).not.toThrow();
  });
});
