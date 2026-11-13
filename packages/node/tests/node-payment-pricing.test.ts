import { describe, expect, it, vi } from 'vitest';
import { SellerBuyerLimiter } from '../src/payments/seller-buyer-limiter.js';
import { SellerRequestHandler, assertSingleRoutingService } from '../src/seller-request-handler.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { MessageType, PAYMENT_CODE_CHANNEL_EXHAUSTED } from '../src/types/protocol.js';
import { ANTSEED_ATTEST_PATH, type Prover, type SellerRequest } from '../src/interfaces/plugin.js';
import { ResourceOwnershipStore } from '../src/resources/resource-ownership-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ATTEST_ID = 'antseed-verifier';
const ATTEST_ROUTE = `${ANTSEED_ATTEST_PATH}/${ATTEST_ID}`;

describe('completed-request seller payments', () => {
  const candidate = { id: 'model-a@a', model: 'model-a', pricing: { input: 1, cache_read: 1, output: 3 } };
  const body = { request: { messages: [{ role: 'user', content: 'Help with code' }] }, routing: { cost_quality_tradeoff: 5, candidates: [candidate] } };
  const routingHeaders = {};
  const result = { id: 'rank-1', object: 'routing.ranking', created: 1, router: { id: 'alpha', version: '1' }, ranked: [{ candidate_id: candidate.id }] };
  function setup(overrides: Record<string, unknown> = {}, routing = true) {
    let spend = 0n;
    const provider = makeProvider(10, 10, { name: 'alpha', services: ['alpha-route', 'image'] });
    provider.serviceApiProtocols = routing ? { 'alpha-route': ['irp-suggest'] } : {};
    provider.serviceUnitBillingModels = { 'alpha-route': { 'irp-suggest': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } } };
    provider.pricing = { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 }, services: { 'alpha-route': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } };
    provider.handleRequest = vi.fn(async request => ({ requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(result)) }));
    delete (provider as Partial<Provider>).handleRequestStream;
    const spm = makeSpmMock({
      recordSpend: vi.fn((_channel: string, amount: bigint) => { spend += amount; }),
      getCumulativeSpend: () => spend, getAcceptedCumulative: () => spend, ...overrides,
    });
    const frames: Uint8Array[] = [];
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() };
    const handler = makeSellerRequestHandler({ providers: [provider], sellerPaymentManager: spm, sessionTracker: null, channelsClient: {} as any, announcer: null, emit: () => false });
    const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), paymentMux as any);
    const send = async (requestId = 'fixed', patch: Partial<SerializedHttpRequest> = {}) => {
      await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
        requestId, method: 'POST', path: '/v1/routing/rank',
        headers: { 'content-type': 'application/json', ...routingHeaders },
        body: new TextEncoder().encode(JSON.stringify(body)), ...patch,
      }) });
      return frames.map(frame => decodeHttpResponse(decodeFrame(frame).message!.payload)).reverse().find(response => response.requestId === requestId)!;
    };
    return { provider, spm, paymentMux, send };
  }
  it('charges exactly the fee for a well-formed ranking, with zero tokens', async () => {
    const harness = setup();
    expect((await harness.send()).statusCode).toBe(200);
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 1000n);
    expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ lastRequestCost: '1000', inputTokens: '0', outputTokens: '0', billingUsage: { version: 1, units: { completed_requests: '1' } } }));
  });
  it('serves the routing model list for free through the provider, under the authenticated buyer id', async () => {
    const harness = setup();
    const headers = { ...routingHeaders, 'X-Antseed-Buyer-Peer-Id': 'f'.repeat(40), 'X-Antseed-Free-Tier-Delegations': 'delegations' };
    expect((await harness.send('models', { method: 'GET', path: '/v1/routing/models', headers, body: new Uint8Array() })).statusCode).toBe(200);
    const forwarded = vi.mocked(harness.provider.handleRequest).mock.calls[0]![0];
    expect(forwarded.path).toBe('/v1/routing/models');
    // The buyer-sent copy (any casing) is replaced by the id from the authenticated connection.
    expect(forwarded.headers['x-antseed-buyer-peer-id']).toBe('b'.repeat(40));
    expect(Object.keys(forwarded.headers).filter(key => key.toLowerCase() === 'x-antseed-buyer-peer-id')).toEqual(['x-antseed-buyer-peer-id']);
    // Free-tier delegations are for the seller only and never reach a plugin.
    expect(Object.keys(forwarded.headers).map(key => key.toLowerCase())).not.toContain('x-antseed-free-tier-delegations');
    expect(harness.spm.recordSpend).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
  });
  it('answers routing model-list requests with a 404 problem when the seller offers no router', async () => {
    const harness = setup({}, false);
    const response = await harness.send('none', { method: 'GET', path: '/v1/routing/models', headers: {}, body: new Uint8Array() });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(new TextDecoder().decode(response.body))).toMatchObject({ type: 'urn:irp:problem:invalid-request', status: 404 });
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
  });
  it('allows at most one routing service per seller', () => {
    const routing = (name: string, service: string) => Object.assign(makeProvider(0, 0, { name, services: [service] }), { serviceApiProtocols: { [service]: ['irp-suggest'] } }) as Provider;
    expect(() => assertSingleRoutingService([routing('alpha', 'route')])).not.toThrow();
    expect(() => assertSingleRoutingService([routing('alpha', 'route'), routing('beta', 'other')])).toThrow('at most one irp-suggest routing service');
  });
  it('does not rate limit routing model-list requests; the router limits its own list', async () => {
    const harness = setup();
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await harness.send(`models-${index}`, { method: 'GET', path: '/v1/routing/models', headers: routingHeaders, body: new Uint8Array() })).statusCode);
    }
    expect(statuses.every(status => status === 200)).toBe(true);
    expect(harness.provider.handleRequest).toHaveBeenCalledTimes(12);
  });
  it('negotiates once before execution and allows retrying that request ID', async () => {
    let hasSession = false;
    const harness = setup({ hasSession: () => hasSession });
    expect((await harness.send()).statusCode).toBe(402);
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();
    hasSession = true;
    expect((await harness.send()).statusCode).toBe(200);
    expect(harness.provider.handleRequest).toHaveBeenCalledOnce();
  });
  it('rejects the next request after the confirmed reserve is spent', async () => {
    const harness = setup({ getReserveMax: () => 1000n });
    expect((await harness.send('first')).statusCode).toBe(200);
    expect((await harness.send('second')).statusCode).toBe(402);
    expect(harness.provider.handleRequest).toHaveBeenCalledOnce();
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 1000n);
  });
  it('does not charge a malformed ranking, so the buyer and seller stay in agreement', async () => {
    const harness = setup();
    vi.mocked(harness.provider.handleRequest).mockImplementation(async request => ({ requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode('{}') }));
    expect((await harness.send('opaque')).statusCode).toBe(200);
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 0n);
    expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ lastRequestCost: '0', billingUsage: { version: 1, units: { completed_requests: '0' } } }));
  });
  it('uses ordinary concurrent dispatch for paid routing requests', async () => {
    const harness = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(harness.provider.handleRequest).mockImplementation(async request => {
      await gate;
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(result)) };
    });
    const first = harness.send('active');
    const second = harness.send('concurrent');
    try {
      await vi.waitFor(() => expect(harness.provider.handleRequest).toHaveBeenCalledTimes(2));
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(harness.spm.recordSpend).toHaveBeenCalledTimes(2);
  });
  it('does not charge requests rejected by the provider', async () => {
    const harness = setup();
    vi.mocked(harness.provider.handleRequest).mockImplementation(async request => ({ requestId: request.requestId, statusCode: 400, headers: {}, body: new TextEncoder().encode('{}') }));
    expect((await harness.send()).statusCode).toBe(400);
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 0n);
    expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ lastRequestCost: '0', billingUsage: { version: 1, units: { completed_requests: '0' } } }));
  });
  it('preserves concurrent inference after a completed-request purchase', async () => {
    const harness = setup();
    expect((await harness.send('route-attempt')).statusCode).toBe(200);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handleRequestStream = vi.fn(async (request: SerializedHttpRequest) => {
      await gate;
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode('{}') };
    });
    harness.provider.handleRequestStream = handleRequestStream;
    const request = { path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'image' })) };
    const first = harness.send('first', request);
    const second = harness.send('second', request);
    try {
      await vi.waitFor(() => expect(handleRequestStream).toHaveBeenCalledTimes(2));
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });
  it('keeps legacy image charges and v1 reports unchanged on a mixed seller', async () => {
    const harness = setup();
    harness.provider.pricing = { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } };
    harness.provider.serviceApiProtocols = { ...harness.provider.serviceApiProtocols, image: ['openai-images'] };
    harness.provider.serviceUnitBillingModels = { ...harness.provider.serviceUnitBillingModels, image: { 'openai-images': {
      version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }],
    } } };
    harness.provider.handleRequestStream = undefined;
    vi.mocked(harness.provider.handleRequest).mockImplementation(async request => ({
      requestId: request.requestId, statusCode: 200, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }, { b64_json: 'd29ybGQ=' }] })),
    }));
    const response = await harness.send('legacy-image', {
      path: '/v1/images/generations', headers: { 'content-type': 'application/json', 'x-antseed-provider': 'alpha' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'image', prompt: 'A tree', n: 2 })),
    });
    expect(response.statusCode).toBe(200);
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 80_000n);
    expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({
      lastRequestCost: '80000', billingUsage: { version: 1, units: { output_images: '2' } },
    }));
  });
});

function makeProvider(inputUsdPerMillion: number, outputUsdPerMillion: number, opts: {
  name: string;
  services: string[];
  servicePricing?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number }>;
  serviceApiProtocols?: Provider['serviceApiProtocols'];
  serviceUnitBillingModels?: Provider['serviceUnitBillingModels'];
}): Provider {
  return {
    name: opts.name,
    services: opts.services,
    pricing: {
      defaults: { inputUsdPerMillion, outputUsdPerMillion },
      ...(opts.servicePricing ? { services: opts.servicePricing } : {}),
    },
    ...(opts.serviceApiProtocols ? { serviceApiProtocols: opts.serviceApiProtocols } : {}),
    ...(opts.serviceUnitBillingModels ? { serviceUnitBillingModels: opts.serviceUnitBillingModels } : {}),
    maxConcurrency: 1,
    async handleRequest(_req) {
      return {
        requestId: 'test',
        statusCode: 200,
        headers: {},
        body: new Uint8Array(0),
      };
    },
    getCapacity() {
      return { current: 0, max: 1 };
    },
  };
}

function makeSpmMock(overrides: Record<string, unknown> = {}): any {
  let inFlight = 0;
  return {
    hasSession: () => true,
    getChannelByPeer: () => ({ sessionId: 'session-1', authMax: '1000000' }),
    recordSpend: vi.fn(),
    getCumulativeSpend: () => 0n,
    getAcceptedCumulative: () => 0n,
    getEffectiveReserveMax() {
      return this.getReserveMax();
    },
    async refreshReserveMaxFromChain() {
      return this.getEffectiveReserveMax();
    },
    isChannelBlocked: () => false,
    getPaymentRequirements: () => ({ minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
    waitForPendingAuths: async () => {},
    awaitAcceptedAtLeast: async () => false,
    settleSession: vi.fn(async () => {}),
    beginBillableRequest: vi.fn(() => { inFlight += 1; }),
    endBillableRequest: vi.fn(() => { inFlight -= 1; }),
    hasInFlightRequests: () => inFlight > 0,
    hasClosingChannel: () => false,
    waitForClosingChannel: async () => false,
    isTopUpRunning: () => false,
    isTopUpPendingFor: () => false,
    waitForTopUp: async () => true,
    // The real one waits for in-flight requests, then settles.
    closeSessionWhenIdle(buyerPeerId: string) {
      return this.settleSession(buyerPeerId);
    },
    ...oneOffSpmMock(),
    ...overrides,
  };
}

/**
 * One-off channel state for a seller payment manager mock. By default every
 * video create already has its own open channel covering 10 USDC; pass
 * `{ opened: false }` to get the 402 + plan path first.
 */
function oneOffSpmMock(options: { opened?: boolean; reserve?: bigint } = {}) {
  const opened = options.opened ?? true;
  const channels = new Map<string, { sessionId: string; requestCount: number; reserve: bigint }>();
  const plans = new Map<string, unknown>();
  const key = (buyer: string, requestId: string) => `${buyer}:${requestId}`;
  const open = (buyer: string, requestId: string, reserve = options.reserve ?? 10_000_000n) => {
    const channel = { sessionId: `one-off-${requestId}`, requestCount: 0, reserve };
    channels.set(key(buyer, requestId), channel);
    return channel;
  };
  const byId = (channelId: string) => [...channels.values()].find((channel) => channel.sessionId === channelId);
  return {
    oneOffPlans: plans,
    openOneOff: open,
    registerOneOffPlan: vi.fn((buyer: string, requestId: string, plan: unknown): number | null => { plans.set(key(buyer, requestId), plan); return null; }),
    oneOffRetryAfterSeconds: vi.fn((): number | null => null),
    markOneOffCreateAccepted: vi.fn(),
    getOneOffChannelForRequest: (buyer: string, requestId: string) => channels.get(key(buyer, requestId))
      ?? (opened ? open(buyer, requestId) : null),
    claimOneOffChannel: (channelId: string) => {
      const channel = byId(channelId);
      if (!channel || channel.requestCount > 0) return false;
      channel.requestCount = 1;
      return true;
    },
    isOneOffChannel: (channelId: string) => byId(channelId) != null,
    closeOneOffChannel: vi.fn(async () => true),
    getChannel: (channelId: string) => {
      const channel = byId(channelId);
      return channel ? { sessionId: channelId, status: 'active', previousConsumption: channel.reserve.toString() } : null;
    },
    getReserveMax(channelId: string) {
      return byId(channelId)?.reserve ?? 1_000_000n;
    },
  };
}

function makeConn(sentFrames: Uint8Array[]): any {
  return {
    send(frame: Uint8Array) {
      sentFrames.push(frame);
    },
    hasRemoteCapability: () => false,
    remoteAddress: '203.0.113.7',
  };
}

function makeSellerRequestHandler(
  deps: Omit<ConstructorParameters<typeof SellerRequestHandler>[0], 'identity'>,
): SellerRequestHandler {
  return new SellerRequestHandler({
    identity: { peerId: 's'.repeat(40), privateKey: new Uint8Array(32).fill(7) } as any,
    ...deps,
  });
}

it('does not charge a native video on acceptance or JSON status, preserves buyer ownership, and serves follow-ups without budget', async () => {
  const provider = makeProvider(0, 0, {
    name: 'venice', services: ['video'], serviceApiProtocols: { video: ['venice-video'] },
    serviceUnitBillingModels: { video: { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } } },
  });
  const owners = new Map<string, string>();
  provider.handleRequest = vi.fn(async request => {
    expect(request.headers['X-Antseed-Buyer-Peer-Id']).toBeUndefined();
    const buyer = request.headers['x-antseed-buyer-peer-id']!;
    const isCreate = request.path.endsWith('/queue');
    if (isCreate) owners.set('task', buyer);
    const statusCode = owners.get('task') === buyer ? 200 : 403;
    return { requestId: request.requestId, statusCode, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(isCreate ? { queue_id: 'task', status: 'QUEUED' } : { status: 'COMPLETED' })) };
  });
  let paid = true;
  const recordSpend = vi.fn();
  const sendNeedAuth = vi.fn();
  const handler = makeSellerRequestHandler({
    providers: [provider], sellerPaymentManager: makeSpmMock({ recordSpend, hasSession: () => paid }),
    channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
    resourceOwnershipStore: new ResourceOwnershipStore(join(mkdtempSync(join(tmpdir(), 'antseed-resources-')), 'metering.db')),
  });
  const frames: Uint8Array[] = [];
  const payment = { sendNeedAuth, sendPaymentRequired: vi.fn() } as any;
  const buyer = 'b'.repeat(40);
  const { mux } = handler.handleConnection(makeConn(frames), buyer, payment);
  const request = (method: string, path: string): SerializedHttpRequest => ({ requestId: `${method}-${frames.length}`, method, path,
    headers: { 'content-type': 'application/json', 'x-antseed-service': 'video', 'X-Antseed-Buyer-Peer-Id': 'spoofed', 'x-antseed-buyer-peer-id': 'spoofed' }, body: Buffer.from(JSON.stringify(path.endsWith('/queue') ? { model: 'video', duration: '8s' } : { model: 'video', queue_id: 'task' })) });
  await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest(request('POST', '/api/v1/video/queue')) });
  // Acceptance charges nothing; the price is charged when the video is delivered.
  expect(recordSpend.mock.calls.every(([, cost]) => cost === 0n)).toBe(true);
  expect(sendNeedAuth.mock.calls.some(([payload]) => payload.billingUsage)).toBe(false);
  recordSpend.mockClear();
  sendNeedAuth.mockClear();
  paid = false;
  for (const method of ['POST', 'POST']) {
    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: frames.length + 1, payload: encodeHttpRequest(request(method, '/api/v1/video/retrieve')) });
    expect(decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode).toBe(200);
  }
  // A JSON COMPLETED status is not a delivery; only a checked MP4 stream is
  // (covered end to end in video-reserve-flow.test.ts).
  expect(recordSpend.mock.calls.every(([, cost]) => cost === 0n)).toBe(true);
  expect(sendNeedAuth.mock.calls.some(([payload]) => payload.billingUsage)).toBe(false);
  expect(payment.sendPaymentRequired).not.toHaveBeenCalled();
  const other = handler.handleConnection(makeConn(frames), 'c'.repeat(40), payment);
  await other.mux.handleFrame({ type: MessageType.HttpRequest, messageId: 10, payload: encodeHttpRequest(request('POST', '/api/v1/video/retrieve')) });
  expect(decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode).toBe(404);
  expect(owners.get('task')).toBe(buyer);
  expect(provider.handleRequest).toHaveBeenCalledTimes(3);
});

it('charges a multipart request the price of its own service, and nothing for a free one on a paid provider', async () => {
  const boundary = 'form-boundary';
  const provider = makeProvider(10, 20, {
    name: 'images',
    services: ['priced', 'at-default', 'free'],
    servicePricing: { priced: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, free: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
  });
  provider.handleRequest = vi.fn(async request => ({
    requestId: request.requestId,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 1000 } })),
  }));
  const recordSpend = vi.fn();
  const handler = makeSellerRequestHandler({ providers: [provider], sellerPaymentManager: makeSpmMock({ recordSpend, getReserveMax: () => 1_000_000n }), channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false });
  const frames: Uint8Array[] = [];
  const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
  const serve = async (model: string) => {
    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: frames.length + 1,
      payload: encodeHttpRequest({
        requestId: model,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}--\r\n`),
      }),
    });
    return frames
      .map(frame => decodeFrame(frame)!.message)
      .filter(message => message.type === MessageType.HttpResponse)
      .map(message => decodeHttpResponse(message.payload))
      .find(answer => answer.requestId === model)!.statusCode;
  };

  expect(await serve('priced')).toBe(200);
  expect(recordSpend.mock.calls).toEqual([['session-1', 3000n]]);
  expect(await serve('at-default')).toBe(200);
  expect(recordSpend.mock.calls).toEqual([['session-1', 3000n], ['session-1', 30000n]]);
  expect(await serve('free')).toBe(200);
  expect(recordSpend.mock.calls).toEqual([['session-1', 3000n], ['session-1', 30000n]]);
  expect(vi.mocked(provider.handleRequest).mock.calls.map(([request]) => request.headers['x-antseed-service'])).toEqual(['priced', 'at-default', 'free']);
});

describe('charges for requests whose fields every reader reads alike', () => {
  const boundary = 'form-boundary';
  type Part = [headers: string, content: string];
  const text = (name: string, value: string): Part => [`Content-Disposition: form-data; name="${name}"`, value];
  const form = (parts: Part[]) => ({
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: new TextEncoder().encode(`${parts.map(([headers, content]) => `--${boundary}\r\n${headers}\r\n\r\n${content}\r\n`).join('')}--${boundary}--\r\n`),
  });

  /** An image seller priced per image by quality, on top of token prices, with every charge and provider call recorded. */
  function imageSeller() {
    const provider = makeProvider(0, 0, {
      name: 'images',
      services: ['image-model', 'chat-model'],
      servicePricing: { 'chat-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      serviceApiProtocols: { 'image-model': ['openai-images'], 'chat-model': ['openai-chat-completions'] },
      serviceUnitBillingModels: { 'image-model': { 'openai-images': { version: 1, components: [
        { unit: 'output_images', priceUsd: 0.01, match: { quality: 'low' } },
        { unit: 'output_images', priceUsd: 0.04, match: { quality: 'high' } },
        { unit: 'output_images', priceUsd: 0.02, match: { quality: 'auto' } },
      ] } } },
    });
    const received: Array<{ headers: Record<string, string>; body: Uint8Array }> = [];
    provider.handleRequest = vi.fn(async request => {
      received.push({ headers: { ...request.headers }, body: request.body });
      const answer = request.headers['x-antseed-service'] === 'image-model'
        ? { data: [{ b64_json: 'a' }, { b64_json: 'b' }] }
        : { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 1000 } };
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(answer)) };
    });
    const recordSpend = vi.fn();
    const handler = makeSellerRequestHandler({ providers: [provider], sellerPaymentManager: makeSpmMock({ recordSpend, getReserveMax: () => 1_000_000n }), channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false });
    const frames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
    let sent = 0;
    const serve = async (path: string, request: { headers: Record<string, string>; body: Uint8Array }) => {
      const requestId = `request-${sent += 1}`;
      await mux.handleFrame({ type: MessageType.HttpRequest, messageId: sent, payload: encodeHttpRequest({ requestId, method: 'POST', path, ...request }) });
      const response = frames.map(frame => decodeFrame(frame)!.message)
        .filter(message => message.type === MessageType.HttpResponse)
        .map(message => decodeHttpResponse(message.payload))
        .find(answer => answer.requestId === requestId)!;
      return { status: response.statusCode, code: response.statusCode === 200 ? undefined : JSON.parse(new TextDecoder().decode(response.body)).error.code as string };
    };
    return { serve, received, charges: () => recordSpend.mock.calls.map(([, amount]) => amount as bigint) };
  }

  it('charges a multipart image request by its one quality and count, the values its provider receives', async () => {
    const { serve, received, charges } = imageSeller();
    const upload: Part = ['Content-Disposition: form-data; name="audio"; filename="voice.wav"\r\nContent-Type: audio/wav', 'RIFF'];

    expect(await serve('/v1/images/edits', form([text('model', 'image-model'), text('quality', 'high'), text('n', '2'), upload]))).toEqual({ status: 200 });
    expect(charges()).toEqual([80_000n]);
    expect(await serve('/v1/images/edits', form([text('model', 'image-model'), text('quality', 'low'), text('n', '2')]))).toEqual({ status: 200 });
    expect(charges()).toEqual([80_000n, 20_000n]);

    // What the provider was handed, read by a parser the seller does not share: the values that were charged.
    const read = await Promise.all(received.map(async ({ headers, body }) => {
      const fields = await new Response(body, { headers: { 'content-type': headers['content-type']! } }).formData();
      return Object.fromEntries(['model', 'quality', 'n'].map(name => [name, fields.getAll(name)]));
    }));
    expect(read).toEqual([
      { model: ['image-model'], quality: ['high'], n: ['2'] },
      { model: ['image-model'], quality: ['low'], n: ['2'] },
    ]);
  });

  it.each<[string, Part[], string]>([
    ['a quality sent twice, the higher one last', [text('quality', 'low'), text('quality', 'high')], 'repeated_field'],
    ['a quality sent twice, the higher one first', [text('quality', 'high'), text('quality', 'low')], 'repeated_field'],
    ['a count sent twice', [text('quality', 'low'), text('n', '1'), text('n', '2')], 'repeated_field'],
    ['a quality billing would not read, sent as a file', [['Content-Disposition: form-data; name="quality"; filename=""', 'high']], 'invalid_billing_field'],
    ['a quality billing would not read, over the field limit', [text('quality', `high${' '.repeat(4096)}`)], 'invalid_billing_field'],
    ['a quality under another spelling', [text('Quality', 'high')], 'invalid_billing_field'],
    ['a quality under two spellings', [text('quality', 'low'), text('Quality', 'high')], 'invalid_billing_field'],
    ['a count billing would not read', [text('quality', 'low'), text('n', '4abc')], 'invalid_billing_field'],
    ['a parameter key padded with a control byte', [text('quality', 'low'), ['Content-Disposition: form-data; name="decoy"; name\x1f="quality"', 'high']], 'unsupported_multipart_body'],
  ])('charges nothing and calls no provider for a multipart image request with %s', async (_name, parts, code) => {
    const { serve, received, charges } = imageSeller();
    expect(await serve('/v1/images/edits', form([text('model', 'image-model'), ...parts]))).toEqual({ status: 400, code });
    expect(charges()).toEqual([]);
    expect(received).toEqual([]);
  });

  // Some form parser reads each of these parts as the field in brackets; the seller writes only the name it read.
  it.each<[string, Part[], bigint, Record<string, string[]>]>([
    ['a part billing reads as "user" (quality)', [['Content-Disposition: form-data; filenamename="quality"; name="user"', 'low'], text('quality', 'high')], 40_000n, { quality: ['high'], user: ['low'] }],
    ['a part whose other header quotes a disposition line (quality)', [text('quality', 'low'), ['X-Note: content-disposition: form-data; name="quality"\r\nContent-Disposition: form-data; name="prompt"', 'high']], 10_000n, { quality: ['low'], prompt: ['high'] }],
    ['an escaped quote hiding a name (quality)', [text('quality', 'low'), ['Content-Disposition: form-data; name="decoy"; foo="a\\\\"; bar="x; name=quality; y"', 'high']], 10_000n, { quality: ['low'], decoy: ['high'] }],
    ['an extra parameter on the quality', [['Content-Disposition: form-data; name="quality"; x=a/b', 'low']], 10_000n, { quality: ['low'] }],
  ])('charges a multipart image request with %s by the value its provider receives', async (_name, parts, charge, expected) => {
    const { serve, received, charges } = imageSeller();
    expect(await serve('/v1/images/edits', form([text('model', 'image-model'), ...parts]))).toEqual({ status: 200 });
    expect(charges()).toEqual([charge]);
    const fields = await new Response(received[0]!.body, { headers: { 'content-type': received[0]!.headers['content-type']! } }).formData();
    expect(Object.fromEntries(Object.keys(expected).map((name) => [name, fields.getAll(name)]))).toEqual(expected);
  });

  it.each(['/v1/images/./generations', '/v1/chat/completions/../../images/generations', '//v1/images/generations', '/v1/images/generations/'])(
    'charges nothing and calls no provider for an image request on the path %s, which billing would not price',
    async (path) => {
      const { serve, received, charges } = imageSeller();
      const body = new TextEncoder().encode('{"model":"image-model"}');
      expect(await serve(path, { headers: { 'content-type': 'application/json' }, body })).toEqual({ status: 400, code: 'invalid_request_path' });
      expect(charges()).toEqual([]);
      expect(received).toEqual([]);
      expect(await serve('/v1/images/generations', { headers: { 'content-type': 'application/json' }, body })).toEqual({ status: 200 });
      expect(charges()).toEqual([20_000n]);
    },
  );

  it('charges a JSON image request with a count sent twice by the one count its provider receives', async () => {
    const { serve, received, charges } = imageSeller();
    const body = new TextEncoder().encode('{"model":"image-model","quality":"low","n":1,"n":2}');
    expect(await serve('/v1/images/generations', { headers: { 'content-type': 'application/json' }, body })).toEqual({ status: 200 });
    expect(charges()).toEqual([20_000n]);
    expect(JSON.parse(new TextDecoder().decode(received[0]!.body))).toEqual({ model: 'image-model', quality: 'low', n: 2 });
  });

  it.each<[string, string]>([
    ['a count sent in two letter cases', '{"model":"image-model","quality":"low","n":1,"N":2}'],
    ['a quality sent in two letter cases', '{"model":"image-model","Quality":"high","quality":"low","n":2}'],
    ['a quality only in another letter case', '{"model":"image-model","Quality":"high","n":2}'],
    ['a count only in another letter case', '{"model":"image-model","quality":"low","N":8}'],
    ['a quality in a list', '{"model":"image-model","quality":["high"],"n":2}'],
    ['a count billing would not read', '{"model":"image-model","quality":"low","n":"4abc"}'],
  ])('charges nothing and calls no provider for a JSON image request with %s', async (_name, body) => {
    const { serve, received, charges } = imageSeller();
    const json = (text: string) => ({ headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(text) });
    expect(await serve('/v1/images/generations', json(body))).toEqual({ status: 400, code: 'invalid_billing_field' });
    expect(charges()).toEqual([]);
    expect(received).toEqual([]);
    expect(await serve('/v1/images/generations', json('{"model":"image-model","quality":"low","n":2}'))).toEqual({ status: 200 });
    expect(charges()).toEqual([20_000n]);
  });

  it.each<[string, Record<string, string>]>([
    ['text, as a browser fetch sends', { 'content-type': 'text/plain;charset=UTF-8' }],
    ['a form, as curl -d sends', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['JSON', { 'content-type': 'application/json' }],
  ])('charges a JSON request labelled %s the price of its service, and hands it to the provider as JSON', async (_name, headers) => {
    const { serve, received, charges } = imageSeller();
    const body = new TextEncoder().encode(JSON.stringify({ model: 'chat-model', messages: [{ role: 'user', content: '&model=image-model&' }] }));
    expect(await serve('/v1/chat/completions', { headers, body })).toEqual({ status: 200 });
    expect(charges()).toEqual([3000n]);
    expect(received.map(request => [request.headers['content-type'], request.headers['x-antseed-service'], request.body])).toEqual([['application/json', 'chat-model', body]]);
  });
});

describe('native video job ownership', () => {
  it('authorizes Venice downloads against the queue owner without charging for bytes', async () => {
    const provider = makeProvider(0, 0, {
      name: 'venice', services: ['video'], serviceApiProtocols: { video: ['venice-video'] },
      serviceUnitBillingModels: { video: { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } } },
    });
    provider.handleRequest = vi.fn(async request => ({ requestId: request.requestId, statusCode: 206, headers: { 'content-type': 'video/mp4' }, body: Buffer.from('video') }));
    const dbPath = join(mkdtempSync(join(tmpdir(), 'antseed-video-download-')), 'metering.db');
    let store = new ResourceOwnershipStore(dbPath);
    store.recordAcceptedCreate('venice-video', 'job', 'b'.repeat(40));
    store.close();
    store = new ResourceOwnershipStore(dbPath);
    const recordSpend = vi.fn();
    const handler = makeSellerRequestHandler({ providers: [provider], sellerPaymentManager: makeSpmMock({ recordSpend, hasSession: () => false }), channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false, resourceOwnershipStore: store });
    try {
      for (const buyer of ['b'.repeat(40), 'c'.repeat(40)]) {
        const frames: Uint8Array[] = [];
        const payment = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
        const { mux } = handler.handleConnection(makeConn(frames), buyer, payment);
        const request = { requestId: buyer, method: 'POST', path: '/api/v1/video/retrieve', headers: { 'content-type': 'application/json', 'x-antseed-service': 'video' }, body: new TextEncoder().encode(JSON.stringify({ model: 'video', queue_id: 'job' })) };
        await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest(request) });
        expect(decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode).toBe(buyer.startsWith('b') ? 206 : 404);
        expect(payment.sendNeedAuth).not.toHaveBeenCalled();
        expect(payment.sendPaymentRequired).not.toHaveBeenCalled();
      }
      expect(provider.handleRequest).toHaveBeenCalledTimes(1);
      expect(recordSpend).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
  it('keeps video polls and downloads outside token-based buyer limits', async () => {
    const provider = makeProvider(0, 0, {
      name: 'venice', services: ['video'], serviceApiProtocols: { video: ['venice-video'] },
      serviceUnitBillingModels: { video: { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } } },
    });
    provider.handleRequest = vi.fn(async request => ({ requestId: request.requestId, statusCode: 206, headers: { 'content-type': 'video/mp4' }, body: Buffer.from('video') }));
    const store = new ResourceOwnershipStore(join(mkdtempSync(join(tmpdir(), 'antseed-video-limits-')), 'metering.db'));
    store.recordAcceptedCreate('venice-video', 'job', 'b'.repeat(40));
    const handler = makeSellerRequestHandler({
      providers: [provider], sellerPaymentManager: makeSpmMock({ hasSession: () => false }), channelsClient: {} as any,
      sessionTracker: null, announcer: null, emit: () => false, resourceOwnershipStore: store,
      sellerBuyerLimiter: new SellerBuyerLimiter({ maxTokensPerBuyer: 1_000 }, () => null),
    });
    try {
      const frames: Uint8Array[] = [];
      const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
      for (let i = 1; i <= 4; i++) {
        const request = { requestId: `poll-${i}`, method: 'POST', path: '/api/v1/video/retrieve', headers: { 'content-type': 'application/json', 'x-antseed-service': 'video' }, body: new TextEncoder().encode(JSON.stringify({ model: 'video', queue_id: 'job' })) };
        await mux.handleFrame({ type: MessageType.HttpRequest, messageId: i, payload: encodeHttpRequest(request) });
        expect(decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode).toBe(206);
      }
    } finally { store.close(); }
  });
  const buyer = 'b'.repeat(40);
  const other = 'c'.repeat(40);
  const pricing = { version: 1 as const, components: [{ unit: 'video_seconds' as const, priceUsd: 0.1 }] };

  function setup(
    dbPath = join(mkdtempSync(join(tmpdir(), 'antseed-resources-')), 'metering.db'),
    taskIds = ['task-1', 'task-2'],
    spmOverrides: Record<string, unknown> = {},
  ) {
    const provider = makeProvider(0, 0, {
      name: 'venice', services: ['video'], serviceApiProtocols: { video: ['venice-video'] },
      serviceUnitBillingModels: { video: { 'venice-video': pricing } },
    });
    const creates: string[] = [];
    provider.handleRequest = vi.fn(async request => {
      const id = request.method === 'POST' && request.path.endsWith('/queue') ? taskIds[creates.push(request.requestId) - 1]! : 'task-1';
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ queue_id: id, status: 'PENDING' })) };
    });
    const recordSpend = vi.fn();
    const store = new ResourceOwnershipStore(dbPath);
    // One channel per buyer: accepted videos keep their price reserved on it.
    const spm = makeSpmMock({
      recordSpend,
      getChannelByPeer: (peer: string) => ({ sessionId: peer === buyer ? 'session-1' : `session-${peer.slice(0, 8)}`, authMax: '1000000' }),
      ...spmOverrides,
    });
    const handler = makeSellerRequestHandler({
      providers: [provider], sellerPaymentManager: spm,
      channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
      resourceOwnershipStore: store,
    });
    const frames: Uint8Array[] = [];
    const payment = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
    const connections = new Map<string, ReturnType<SellerRequestHandler['handleConnection']>>();
    let messageId = 0;
    const send = async (peer: string, method: string, path: string, body: object = {}, headers: Record<string, string> = {}) => {
      const connection = connections.get(peer) ?? handler.handleConnection(makeConn(frames), peer, payment);
      connections.set(peer, connection);
      messageId += 1;
      const request: SerializedHttpRequest = { requestId: `r-${messageId}`, method, path, headers: { 'content-type': 'application/json', 'x-antseed-service': 'video', ...headers }, body: Buffer.from(JSON.stringify(body)) };
      await connection.mux.handleFrame({ type: MessageType.HttpRequest, messageId, payload: encodeHttpRequest(request) });
      return decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload);
    };
    const create = (peer: string, headers: Record<string, string> = {}, body: object = { model: 'video', duration: '8s' }) => send(peer, 'POST', '/api/v1/video/queue', body, headers);
    return { provider, recordSpend, store, send, create, payment, dbPath, settleSession: spm.settleSession };
  }

  it('rejects polls from buyers that did not create the job, without calling upstream', async () => {
    const { provider, send, create, store } = setup();
    expect((await create(buyer)).statusCode).toBe(200);
    const denied = await send(other, 'POST', '/api/v1/video/retrieve', { model: 'video', queue_id: 'task-1' });
    expect(denied.statusCode).toBe(404);
    expect(JSON.parse(new TextDecoder().decode(denied.body)).error.code).toBe('resource_not_found');
    expect((await send(other, 'POST', '/api/v1/video/retrieve', { model: 'video', queue_id: 'unknown' })).statusCode).toBe(404);
    expect(provider.handleRequest).toHaveBeenCalledTimes(1);
    expect((await send(buyer, 'POST', '/api/v1/video/retrieve', { model: 'video', queue_id: 'task-1' })).statusCode).toBe(200);
    store.close();
  });

  it('does not charge for a video whose owner cannot be saved', async () => {
    const { create, send, recordSpend, store } = setup();
    vi.spyOn(store, 'recordAcceptedCreate').mockImplementation(() => { throw new Error('disk full'); });
    const response = await create(buyer);
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(new TextDecoder().decode(response.body)).error.code).toBe('resource_ownership_unavailable');
    expect(recordSpend.mock.calls.every(([, cost]) => cost === 0n)).toBe(true);
    expect((await send(buyer, 'POST', '/api/v1/video/retrieve', { model: 'video', queue_id: 'task-1' })).statusCode).toBe(404);
    store.close();
  });

  it('keeps ownership across a seller restart', async () => {
    const first = setup();
    await first.create(buyer);
    first.store.close();
    const restarted = setup(first.dbPath);
    expect((await restarted.send(buyer, 'POST', '/api/v1/video/retrieve', { model: 'video', queue_id: 'task-1' })).statusCode).toBe(200);
    expect((await restarted.send(other, 'POST', '/api/v1/video/retrieve', { model: 'video', queue_id: 'task-1' })).statusCode).toBe(404);
    restarted.store.close();
  });

  it('does not charge or remember upstream rejections as accepted jobs', async () => {
    const { provider, recordSpend, create, store } = setup();
    provider.handleRequest = vi.fn(async request => ({
      requestId: request.requestId, statusCode: 400, headers: {}, body: Buffer.from('{"error":{"message":"Invalid parameters"}}'),
    }));
    try {
      expect((await create(buyer)).statusCode).toBe(400);
      expect(provider.handleRequest).toHaveBeenCalledTimes(1);
      expect(recordSpend.mock.calls.every(([, amount]) => amount === 0n)).toBe(true);
      expect(store.getPendingCharge('venice-video', 'task-1', buyer)).toBeNull();
    } finally {
      store.close();
    }
  });

  describe('one-off video channels', () => {
    const newDbPath = () => join(mkdtempSync(join(tmpdir(), 'antseed-resources-')), 'metering.db');
    const bigVideo = { model: 'video', duration: '20s' };
    const bodyOf = (response: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(response.body));
    const channelsClient = {
      getFirstSignCap: async () => 1_000_000n,
      getTopUpSettledThresholdBps: async () => 6_500n,
    } as any;

    function setupOneOff(spmOverrides: Record<string, unknown> = {}, opened = false) {
      const oneOff = oneOffSpmMock({ opened });
      const provider = makeProvider(0, 0, {
        name: 'venice', services: ['video'], serviceApiProtocols: { video: ['venice-video'] },
        serviceUnitBillingModels: { video: { 'venice-video': pricing } },
      });
      let jobs = 0;
      provider.handleRequest = vi.fn(async request => ({
        requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ queue_id: `task-${++jobs}`, status: 'PENDING' })),
      }));
      const store = new ResourceOwnershipStore(newDbPath());
      const settleSession = vi.fn(async () => {});
      const recordSpend = vi.fn();
      const spm = makeSpmMock({ recordSpend, settleSession, ...oneOff, ...spmOverrides });
      const handler = makeSellerRequestHandler({
        providers: [provider], sellerPaymentManager: spm, channelsClient,
        sessionTracker: null, announcer: null, emit: () => false, resourceOwnershipStore: store,
      });
      const frames: Uint8Array[] = [];
      const payment = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
      const { mux } = handler.handleConnection(makeConn(frames), buyer, payment);
      let messageId = 0;
      const create = async (requestId: string, body: object = { model: 'video', duration: '8s' }) => {
        messageId += 1;
        await mux.handleFrame({ type: MessageType.HttpRequest, messageId, payload: encodeHttpRequest({
          requestId, method: 'POST', path: '/api/v1/video/queue',
          headers: { 'content-type': 'application/json', 'x-antseed-service': 'video' },
          body: Buffer.from(JSON.stringify(body)),
        }) });
        return decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload);
      };
      return { provider, store, spm, oneOff, create, payment, recordSpend, settleSession };
    }

    it('offers a one-off channel plan without starting the job or touching the session channel', async () => {
      const { provider, create, spm, recordSpend, settleSession, store } = setupOneOff({ getCumulativeSpend: () => 100_000n });
      try {
        const response = await create('video-1', bigVideo);
        expect(response.statusCode).toBe(402);
        expect(bodyOf(response)).toMatchObject({
          error: 'payment_required',
          code: 'one_off_channel_required',
          oneOffPlan: {
            openingReserveAmount: '1000000',
            requiredCumulativeAmount: '650000',
            requestCost: '2000000',
          },
        });
        expect(spm.registerOneOffPlan).toHaveBeenCalledWith(buyer, 'video-1', expect.objectContaining({ requestCost: '2000000' }));
        expect(provider.handleRequest).not.toHaveBeenCalled();
        expect(recordSpend).not.toHaveBeenCalled();
        expect(settleSession).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('answers a create the provider refuses before offering a channel, so it costs nothing', async () => {
      const { provider, create, spm, recordSpend, store } = setupOneOff();
      provider.checkRequest = vi.fn(request => JSON.parse(new TextDecoder().decode(request.body)).duration === '20s'
        ? { statusCode: 422, code: 'invalid_video_duration', message: 'duration must be the source length in whole seconds, rounded down: 12' }
        : null);
      try {
        const refused = await create('video-1', bigVideo);
        expect(refused.statusCode).toBe(422);
        expect(bodyOf(refused)).toEqual({ error: { code: 'invalid_video_duration', message: 'duration must be the source length in whole seconds, rounded down: 12' } });
        expect(spm.registerOneOffPlan).not.toHaveBeenCalled();
        expect(provider.handleRequest).not.toHaveBeenCalled();
        expect(recordSpend).not.toHaveBeenCalled();
        // An accepted create is priced by its duration as usual.
        const accepted = await create('video-2', { model: 'video', duration: '12s' });
        expect(accepted.statusCode).toBe(402);
        expect(bodyOf(accepted).oneOffPlan.requestCost).toBe('1200000');
      } finally { store.close(); }
    });

    it('answers 500 when the provider check throws, without offering a channel', async () => {
      const { provider, create, spm, store } = setupOneOff();
      provider.checkRequest = () => { throw new Error('boom'); };
      try {
        const response = await create('video-1', bigVideo);
        expect(response.statusCode).toBe(500);
        expect(bodyOf(response).error.code).toBe('request_check_failed');
        expect(spm.registerOneOffPlan).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('needs no serious fee when the video fits under the first-sign cap', async () => {
      const { create, store } = setupOneOff();
      try {
        const response = await create('video-small', { model: 'video', duration: '5s' });
        expect(bodyOf(response).oneOffPlan).toEqual({
          openingReserveAmount: '500000',
          requiredCumulativeAmount: '0',
          requestCost: '500000',
        });
      } finally { store.close(); }
    });

    it('offers a one-off channel even without a session, and ignores the session reserve', async () => {
      const { create, store } = setupOneOff({ hasSession: () => false, getEffectiveReserveMax: () => 0n });
      try {
        const response = await create('video-1', bigVideo);
        expect(response.statusCode).toBe(402);
        expect(bodyOf(response).code).toBe('one_off_channel_required');
      } finally { store.close(); }
    });

    it('starts the create once its one-off channel is open, and records the charge against it', async () => {
      const { provider, create, oneOff, store, payment } = setupOneOff();
      try {
        expect((await create('video-1', bigVideo)).statusCode).toBe(402);
        oneOff.openOneOff(buyer, 'video-1');
        const response = await create('video-1', bigVideo);
        expect(response.statusCode).toBe(200);
        expect(provider.handleRequest).toHaveBeenCalledOnce();
        expect(store.getPendingCharge('venice-video', 'task-1', buyer)).toMatchObject({ channelId: 'one-off-video-1', amount: 2_000_000n });
        expect(payment.sendNeedAuth).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('refuses to reuse a one-off channel for a second create', async () => {
      const { provider, create, oneOff, store } = setupOneOff();
      try {
        oneOff.openOneOff(buyer, 'video-1');
        expect((await create('video-1')).statusCode).toBe(200);
        const replay = await create('video-1');
        expect(replay.statusCode).toBe(409);
        expect(bodyOf(replay).error.code).toBe('one_off_channel_used');
        expect(provider.handleRequest).toHaveBeenCalledOnce();
      } finally { store.close(); }
    });

    it('refuses a one-off channel whose reserve does not cover the price', async () => {
      const { provider, create, oneOff, store } = setupOneOff();
      try {
        oneOff.openOneOff(buyer, 'video-1', 1_999_999n);
        const response = await create('video-1', bigVideo);
        expect(response.statusCode).toBe(409);
        expect(bodyOf(response).error.code).toBe('one_off_channel_mismatch');
        expect(provider.handleRequest).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('closes the one-off channel when the provider does not accept the create', async () => {
      const { provider, create, spm, store } = setupOneOff({}, true);
      provider.handleRequest = vi.fn(async request => ({
        requestId: request.requestId, statusCode: 400, headers: {}, body: Buffer.from('{"error":{"message":"Invalid parameters"}}'),
      }));
      try {
        expect((await create('video-1')).statusCode).toBe(400);
        expect(spm.closeOneOffChannel).toHaveBeenCalledWith('one-off-video-1', 'video not accepted');
      } finally { store.close(); }
    });

    it('closes the one-off channel when the provider throws', async () => {
      const { provider, create, spm, store } = setupOneOff({}, true);
      provider.handleRequest = vi.fn(async () => { throw new Error('upstream down'); });
      try {
        expect((await create('video-1')).statusCode).toBe(500);
        expect(spm.closeOneOffChannel).toHaveBeenCalledWith('one-off-video-1', 'video create failed');
      } finally { store.close(); }
    });

    it.each([undefined, 'auto', '0s', '-1s'])('rejects an unbillable video with duration %s before offering a channel', async (duration) => {
      const { provider, create, spm, store } = setupOneOff();
      try {
        const response = await create('video-1', { model: 'video', duration });
        expect(response.statusCode).toBe(400);
        expect(bodyOf(response).error.code).toBe('invalid_billing_request');
        expect(spm.registerOneOffPlan).not.toHaveBeenCalled();
        expect(provider.handleRequest).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('holds back a buyer with too many unproven channels: a 429 with Retry-After, no plan and no chain reads', async () => {
      const firstSignCap = vi.spyOn(channelsClient, 'getFirstSignCap');
      const { provider, create, spm, store } = setupOneOff({ oneOffRetryAfterSeconds: vi.fn(() => 120) });
      try {
        const response = await create('video-1', bigVideo);
        expect(response.statusCode).toBe(429);
        expect(response.headers['retry-after']).toBe('120');
        expect(bodyOf(response).error.code).toBe('one_off_channel_backoff');
        expect(bodyOf(response).error.message).toContain('retry in 120 seconds');
        expect(bodyOf(response).oneOffPlan).toBeUndefined();
        expect(spm.registerOneOffPlan).not.toHaveBeenCalled();
        expect(firstSignCap).not.toHaveBeenCalled();
        expect(provider.handleRequest).not.toHaveBeenCalled();
      } finally { firstSignCap.mockRestore(); store.close(); }
    });

    it('holds back a create that loses the last offer to a parallel one during the chain reads', async () => {
      const { provider, create, store } = setupOneOff({ registerOneOffPlan: vi.fn(() => 60) });
      try {
        const response = await create('video-1', bigVideo);
        expect(response.statusCode).toBe(429);
        expect(response.headers['retry-after']).toBe('60');
        expect(bodyOf(response).oneOffPlan).toBeUndefined();
        expect(provider.handleRequest).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('still runs a create whose channel is already open while its buyer is held back', async () => {
      const { provider, create, store } = setupOneOff({ oneOffRetryAfterSeconds: vi.fn(() => 120) }, true);
      try {
        expect((await create('video-1')).statusCode).toBe(200);
        expect(provider.handleRequest).toHaveBeenCalledOnce();
      } finally { store.close(); }
    });

    it('stops counting a channel against its buyer when its paid create is accepted', async () => {
      const { create, spm, store } = setupOneOff({}, true);
      try {
        expect((await create('video-1')).statusCode).toBe(200);
        expect(spm.markOneOffCreateAccepted).toHaveBeenCalledOnce();
        expect(spm.markOneOffCreateAccepted).toHaveBeenCalledWith('one-off-video-1');
      } finally { store.close(); }
    });

    it('keeps counting the channel when the provider refuses the create', async () => {
      const { provider, create, spm, store } = setupOneOff({}, true);
      provider.handleRequest = vi.fn(async request => ({
        requestId: request.requestId, statusCode: 429, headers: {}, body: Buffer.from('{"error":{"message":"busy"}}'),
      }));
      try {
        await create('video-1');
        expect(spm.markOneOffCreateAccepted).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('keeps counting the channel when the accepted job cannot be recorded', async () => {
      const { create, spm, store } = setupOneOff({}, true);
      vi.spyOn(store, 'recordAcceptedCreate').mockImplementation(() => { throw new Error('database is locked'); });
      try {
        expect((await create('video-1')).statusCode).toBe(503);
        expect(spm.markOneOffCreateAccepted).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('has no channel to mark for a free create', async () => {
      const { provider, create, spm, store } = setupOneOff({}, true);
      provider.serviceUnitBillingModels = { video: { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0 }] } } };
      try {
        expect((await create('video-1')).statusCode).toBe(200);
        expect(provider.handleRequest).toHaveBeenCalledOnce();
        expect(spm.markOneOffCreateAccepted).not.toHaveBeenCalled();
      } finally { store.close(); }
    });

    it('runs several creates from the same buyer in parallel, each on its own channel', async () => {
      const { provider, create, store } = setupOneOff({}, true);
      const releases: Array<() => void> = [];
      provider.handleRequest = vi.fn(request => new Promise(resolve => {
        releases.push(() => resolve({
          requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ queue_id: `task-${request.requestId}` })),
        }));
      }));
      try {
        const first = create('video-a');
        const second = create('video-b');
        for (let attempt = 0; attempt < 100 && releases.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
        expect(provider.handleRequest).toHaveBeenCalledTimes(2);
        releases.forEach(release => release());
        expect((await first).statusCode).toBe(200);
        expect((await second).statusCode).toBe(200);
        expect(store.getPendingCharge('venice-video', 'task-video-a', buyer)?.channelId).toBe('one-off-video-a');
        expect(store.getPendingCharge('venice-video', 'task-video-b', buyer)?.channelId).toBe('one-off-video-b');
      } finally {
        releases.forEach(release => release());
        store.close();
      }
    });
  });

  it('refuses video when ownership storage is unavailable', async () => {
    const provider = makeProvider(0, 0, { name: 'venice', services: ['video'], serviceApiProtocols: { video: ['venice-video'] }, serviceUnitBillingModels: { video: { 'venice-video': pricing } } });
    provider.handleRequest = vi.fn(provider.handleRequest);
    const handler = makeSellerRequestHandler({ providers: [provider], sellerPaymentManager: makeSpmMock(), channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false });
    const frames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(makeConn(frames), buyer, { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'r', method: 'POST', path: '/api/v1/video/retrieve', headers: { 'x-antseed-service': 'video' }, body: Buffer.from('{"model":"video","queue_id":"task"}') }) });
    expect(decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode).toBe(503);
    expect(provider.handleRequest).not.toHaveBeenCalled();
  });
});

function makeAttestHarness(channelBinding: string | null = null) {
  const provider = makeProvider(1, 1, { name: 'openai', services: ['gpt-5.5'] });
  provider.handleRequest = vi.fn(provider.handleRequest);
  const prove = vi.fn(async (req: SellerRequest) => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ ok: true, path: req.path })),
  }));
  const prover: Prover = {
    type: 'prover',
    name: ATTEST_ID,
    displayName: 'Refound verifier',
    version: '0.1.0',
    description: 'test prover',
    prove,
  };
  const sendPaymentRequired = vi.fn();
  const handler = makeSellerRequestHandler({
    providers: [provider],
    provers: [prover],
    sellerPaymentManager: makeSpmMock({ hasSession: () => false }),
    sessionTracker: null,
    channelsClient: {} as any,
    announcer: null,
    emit: () => false,
  });
  const sentFrames: Uint8Array[] = [];
  const { mux } = handler.handleConnection(
    { ...makeConn(sentFrames), channelBinding },
    'b'.repeat(40),
    { sendNeedAuth: vi.fn(), sendPaymentRequired } as any,
  );
  return {
    provider,
    prove,
    sendPaymentRequired,
    sendAttest: (i = 0, body = new Uint8Array([1]), headers: Record<string, string> = {}) => mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: i + 1,
      payload: encodeHttpRequest({
        requestId: `req-attest-${i}`,
        method: 'POST',
        path: ATTEST_ROUTE,
        headers,
        body,
      }),
    }),
    responses: () => sentFrames.map((f) => decodeHttpResponse(decodeFrame(f)!.message.payload)),
  };
}

describe('SellerRequestHandler payment pricing selection', () => {
  it('routes GET /v1/models to the local handler even when a query string is appended', async () => {
    const provider = makeProvider(1, 1, {
      name: 'openai',
      services: ['gpt-5.4', 'gpt-5.5'],
    });
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: null,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId: 'req-models-list',
        method: 'GET',
        path: '/v1/models?client_version=0.125.0',
        headers: {},
        body: new Uint8Array(0),
      }),
    });

    const decoded = decodeFrame(sentFrames[0]!);
    expect(decoded?.message.type).toBe(MessageType.HttpResponse);
    const response = decodeHttpResponse(decoded!.message.payload);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(body.object).toBe('list');
    expect(body.data.map((m: { id: string }) => m.id).sort()).toEqual(['gpt-5.4', 'gpt-5.5']);
  });

  it('routes GET /v1/models/:id to the local handler even when a query string is appended', async () => {
    const provider = makeProvider(1, 1, {
      name: 'openai',
      services: ['gpt-5.5'],
    });
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: null,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId: 'req-models-single',
        method: 'GET',
        path: '/v1/models/gpt-5.5?client_version=0.125.0',
        headers: {},
        body: new Uint8Array(0),
      }),
    });

    const decoded = decodeFrame(sentFrames[0]!);
    const response = decodeHttpResponse(decoded!.message.payload);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(body.id).toBe('gpt-5.5');
  });

  it('dispatches attestation requests before provider and payment logic', async () => {
    const { provider, prove, sendPaymentRequired, sendAttest, responses } = makeAttestHarness();
    await sendAttest(0, new Uint8Array([1, 2, 3]));

    expect(responses()[0]!.statusCode).toBe(200);
    expect(prove).toHaveBeenCalledOnce();
    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendPaymentRequired).not.toHaveBeenCalled();
  });

  it('never passes free-tier delegations to a prover', async () => {
    const { prove, sendAttest } = makeAttestHarness();
    await sendAttest(0, new Uint8Array([1]), { 'X-Antseed-Free-Tier-Delegations': 'delegations' });
    const headers = prove.mock.calls[0]![0].headers;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('x-antseed-free-tier-delegations');
  });

  it('hands the prover the session hash of the connection the request arrived on, never a buyer-sent one', async () => {
    const binding = 'c'.repeat(64);
    const { prove, sendAttest } = makeAttestHarness(binding);
    await sendAttest(0, new Uint8Array([1]), { 'X-Antseed-Channel-Binding': 'd'.repeat(64) });
    const headers: Record<string, string> = prove.mock.calls[0]![0].headers;
    const sent = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'x-antseed-channel-binding');
    expect(sent).toEqual([['x-antseed-channel-binding', binding]]);
  });

  it('drops a buyer-sent session hash on a connection without one', async () => {
    const { prove, sendAttest } = makeAttestHarness();
    await sendAttest(0, new Uint8Array([1]), { 'x-antseed-channel-binding': 'd'.repeat(64) });
    const headers: Record<string, string> = prove.mock.calls[0]![0].headers;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('x-antseed-channel-binding');
  });

  it('rate-limits the free attestation route per buyer', async () => {
    const { prove, sendAttest, responses } = makeAttestHarness();

    for (let i = 0; i < 11; i++) {
      await sendAttest(i);
    }

    const statuses = responses().map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses[10]).toBe(429);
    expect(prove).toHaveBeenCalledTimes(10);
  });

  it('hard-bounds tracked attestation rate-limit peers', () => {
    const handler = makeSellerRequestHandler({
      providers: [],
      sellerPaymentManager: null,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    }) as unknown as {
      _allowAttest(peerId: string): boolean;
      _attestRateWindows: Map<string, unknown>;
    };

    for (let i = 0; i < 1024; i++) {
      expect(handler._allowAttest(`peer-${i}`)).toBe(true);
    }
    expect(handler._attestRateWindows.size).toBe(1024);
    expect(handler._allowAttest('peer-overflow')).toBe(false);
    expect(handler._attestRateWindows.size).toBe(1024);
  });

  it('matches the requested provider and service pricing instead of using the first provider defaults', () => {
    const anthropic = makeProvider(3, 15, {
      name: 'anthropic',
      services: ['claude-sonnet'],
    });
    const openai = makeProvider(3, 15, {
      name: 'openai',
      services: ['local-test'],
      servicePricing: {
        'local-test': {
          inputUsdPerMillion: 0.05,
          outputUsdPerMillion: 0.1,
        },
      },
    });

    const handler = makeSellerRequestHandler({
      providers: [anthropic, openai],
      sellerPaymentManager: null,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });

    const request: SerializedHttpRequest = {
      requestId: 'req-pricing',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'x-antseed-provider': 'openai',
      },
      body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
    };

    const matched = handler.matchProvider(request);
    const pricing = matched ? handler.resolveProviderPricing(matched, request) : undefined;

    expect(matched?.name).toBe('openai');
    expect(pricing).toEqual({ inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.1 });
  });

  it.each(['venice-video'] as const)('never replaces an explicitly selected %s provider that lost its service', (protocol) => {
    const recorded = makeProvider(0, 0, { name: 'recorded', services: ['other'] });
    const replacement = makeProvider(0, 0, { name: 'replacement', services: ['video-model'], serviceApiProtocols: { 'video-model': [protocol] } });
    const handler = makeSellerRequestHandler({ providers: [recorded, replacement], sellerPaymentManager: null, sessionTracker: null, channelsClient: null, announcer: null, emit: () => false });
    const request: SerializedHttpRequest = { requestId: 'video', method: 'POST', path: '/api/v1/video/retrieve', headers: { 'x-antseed-provider': 'recorded', 'x-antseed-service': 'video-model' }, body: Buffer.from('{"model":"video-model","queue_id":"job"}') };
    expect(handler.matchProvider(request)).toBeUndefined();
    recorded.services = ['video-model'];
    expect(handler.matchProvider(request)).toBeUndefined();
    request.headers['x-antseed-provider'] = 'missing';
    expect(handler.matchProvider(request)).toBeUndefined();
    delete request.headers['x-antseed-provider'];
    expect(handler.matchProvider(request)).toBe(replacement);
    request.path = '/v1/chat/completions';
    request.method = 'POST';
    request.headers['x-antseed-provider'] = 'missing';
    request.body = Buffer.from('{"model":"video-model"}');
    expect(handler.matchProvider(request)).toBe(recorded);
  });

  it('routes by the provider ID it announces, keeps the provider name working, and reports load under the ID', () => {
    const venice = makeProvider(0, 0, { name: 'venice', services: ['m'] });
    const other = makeProvider(0, 0, { name: 'other', services: ['m'] });
    const updateLoad = vi.fn();
    const handler = makeSellerRequestHandler({ providers: [venice, other], sellerPaymentManager: null, sessionTracker: null, channelsClient: null, announcer: { updateLoad } as any, announceProviderIds: true, emit: () => false });
    const otherId = handler.announcedProviderId('other');
    expect(otherId).toMatch(/^[0-9a-f]{12}$/);
    expect(otherId).not.toBe(handler.announcedProviderId('venice'));
    const request: SerializedHttpRequest = { requestId: 'r', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', 'x-antseed-provider': otherId }, body: Buffer.from('{"model":"m"}') };
    expect(handler.matchProvider(request)).toBe(other);
    request.headers['x-antseed-provider'] = 'OTHER';
    expect(handler.matchProvider(request)).toBe(other);
    handler.adjustProviderLoad('other', 1);
    expect(updateLoad).toHaveBeenCalledWith(otherId, 1);
  });

  it('announces and reports load under the provider name unless provider IDs are on', () => {
    const updateLoad = vi.fn();
    const handler = makeSellerRequestHandler({ providers: [makeProvider(0, 0, { name: 'venice', services: ['m'] })], sellerPaymentManager: null, sessionTracker: null, channelsClient: null, announcer: { updateLoad } as any, emit: () => false });
    expect(handler.announcedProviderName('venice')).toBe('venice');
    handler.adjustProviderLoad('venice', 1);
    expect(updateLoad).toHaveBeenCalledWith('venice', 1);
  });

  it('does not touch payment state for free responses even when a paid session exists', async () => {
    const provider = makeProvider(0, 0, { name: 'free-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      })),
    }));

    const sendNeedAuth = vi.fn();
    const recordSpend = vi.fn();
    const reportUsageRequest = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ recordSpend, getPaymentRequirements: () => ({ minBudgetPerRequest: '0', suggestedAmount: '0' }) }),
      sellerFreeUsageManager: { reportUsageRequest } as any,
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired: vi.fn() } as any;

    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);
    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-zero-cost', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(sentFrames.length).toBeGreaterThan(0);
    expect(recordSpend).not.toHaveBeenCalled();
    expect(sendNeedAuth).not.toHaveBeenCalled();
    expect(reportUsageRequest).toHaveBeenCalledOnce();
    expect(reportUsageRequest).toHaveBeenCalledWith('b'.repeat(40), paymentMux, {
      requestId: 'req-zero-cost',
      inputTokens: 0,
      outputTokens: 0,
      service: 'local-test',
    });
  });

  it('uses cumulative spend as NeedAuth required amount without double-counting the latest request', async () => {
    const provider = makeProvider(1, 1, {
      name: 'openai-responses',
      services: ['gpt-5.3-codex-spark'],
      servicePricing: {
        'gpt-5.3-codex-spark': { inputUsdPerMillion: 5, outputUsdPerMillion: 30, cachedInputUsdPerMillion: 1 },
      },
    });
    provider.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 30426, completion_tokens: 108, prompt_tokens_details: { cached_tokens: 1920 } } })),
    }));

    const costUsdc = 147_690n;
    let cumulativeSpend = 0n;
    const sendNeedAuth = vi.fn();
    const recordSpend = vi.fn((_sessionId: string, cost: bigint) => { cumulativeSpend += cost; });
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ recordSpend, getCumulativeSpend: () => cumulativeSpend, awaitAcceptedAtLeast: async () => true }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired: vi.fn() } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-codex-cost', method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-5.3-codex-spark' })) }) });

    expect(sentFrames.length).toBeGreaterThan(0);
    expect(recordSpend).toHaveBeenCalledWith('session-1', costUsdc);
    expect(sendNeedAuth).toHaveBeenCalledOnce();
    expect(sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-codex-cost', lastRequestCost: costUsdc.toString(), requiredCumulativeAmount: costUsdc.toString(), inputTokens: '30426', cachedInputTokens: '1920', freshInputTokens: '28506', outputTokens: '108' }));
  });

  it('rejects a billable request with 503 while the channel is closing', async () => {
    const provider = makeProvider(1, 1, {
      name: 'openai-responses',
      services: ['gpt-5.3-codex-spark'],
    });
    provider.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 } })),
    }));

    const recordSpend = vi.fn();
    const beginBillableRequest = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ recordSpend, beginBillableRequest, hasClosingChannel: () => true }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-closing', method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-5.3-codex-spark' })) }) });

    const decoded = decodeFrame(sentFrames[0]!);
    const response = decodeHttpResponse(decoded!.message.payload);
    expect(response.statusCode).toBe(503);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(body.error).toBe('channel_closing');
    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(beginBillableRequest).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('lets a closing channel finish closing, then asks the buyer for a new one instead of failing the request', async () => {
    const provider = makeProvider(1, 1, { name: 'openai', services: ['test-model'] });
    const handleRequest = vi.spyOn(provider, 'handleRequest');
    let open = true;
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        hasSession: () => open,
        hasClosingChannel: () => open,
        waitForClosingChannel: async () => { open = false; return true; },
      }),
      sessionTracker: null, channelsClient: {} as any, announcer: null, emit: () => false,
    });
    const frames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
      requestId: 'req-after-close', method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
    }) });

    const response = decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload);
    expect(response.statusCode).toBe(402);
    expect(JSON.parse(new TextDecoder().decode(response.body)).error).toBe('payment_required');
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it('adds image unit billing on top of existing token pricing', async () => {
    const provider = makeProvider(1, 1, {
      name: 'openai',
      services: ['gpt-image-1'],
      servicePricing: {
        'gpt-image-1': { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
      },
      serviceApiProtocols: {
        'gpt-image-1': ['openai-images'],
      },
      serviceUnitBillingModels: {
        'gpt-image-1': {
          'openai-images': {
            version: 1,
            components: [
              { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
            ],
          },
        },
      },
    });
    provider.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        usage: { input_tokens: 1000, output_tokens: 500 },
        data: [{ b64_json: 'a' }, { b64_json: 'b' }],
      })),
    }));

    const tokenCostUsdc = 4_000n;
    const unitCostUsdc = 80_000n;
    const totalCostUsdc = tokenCostUsdc + unitCostUsdc;
    let cumulativeSpend = 0n;
    const sendNeedAuth = vi.fn();
    const recordSpend = vi.fn((_sessionId: string, cost: bigint) => { cumulativeSpend += cost; });
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ recordSpend, getCumulativeSpend: () => cumulativeSpend, awaitAcceptedAtLeast: async () => true }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired: vi.fn() } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId: 'req-image-hybrid',
        method: 'POST',
        path: '/v1/images/generations',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-image-1', prompt: 'cube', size: '1024x1024', n: 2 })),
      }),
    });

    expect(recordSpend).toHaveBeenCalledWith('session-1', totalCostUsdc);
    expect(sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-image-hybrid',
      lastRequestCost: totalCostUsdc.toString(),
      requiredCumulativeAmount: totalCostUsdc.toString(),
      inputTokens: '1000',
      outputTokens: '500',
      freshInputTokens: '1000',
      billingUsage: expect.objectContaining({
        units: { output_images: '2' },
      }),
    }));
  });

  it('keeps post-response NeedAuth below the reserve ceiling when cumulative spend is still covered', async () => {
    const provider = makeProvider(1, 1, {
      name: 'openai-responses',
      services: ['gpt-5.3-codex-spark'],
      servicePricing: {
        'gpt-5.3-codex-spark': { inputUsdPerMillion: 5, outputUsdPerMillion: 30, cachedInputUsdPerMillion: 1 },
      },
    });
    provider.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 32048, completion_tokens: 136, prompt_tokens_details: { cached_tokens: 1920 } } })),
    }));

    const existingSpend = 835_714n;
    const costUsdc = 156_640n;
    const cumulativeAfterRequest = existingSpend + costUsdc;
    const reserveMax = 1_000_000n;
    let cumulativeSpend = existingSpend;
    const sendNeedAuth = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        getChannelByPeer: () => ({ sessionId: 'session-1', authMax: reserveMax.toString() }),
        recordSpend: vi.fn((_sessionId: string, cost: bigint) => { cumulativeSpend += cost; }),
        getCumulativeSpend: () => cumulativeSpend,
        getAcceptedCumulative: () => existingSpend + 1n,
        getReserveMax: () => reserveMax,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '10000', suggestedAmount: reserveMax.toString() }),
        awaitAcceptedAtLeast: async () => true,
      }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired: vi.fn() } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-near-reserve', method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-5.3-codex-spark' })) }) });

    expect(cumulativeAfterRequest).toBeLessThan(reserveMax);
    expect(sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ lastRequestCost: costUsdc.toString(), requiredCumulativeAmount: cumulativeAfterRequest.toString() }));
    expect(BigInt(sendNeedAuth.mock.calls[0]![0].requiredCumulativeAmount)).toBeLessThanOrEqual(reserveMax);
  });

  it('does not crash when PaymentRequired cannot be sent to a disconnected first-time buyer', async () => {
    const provider = makeProvider(10, 20, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn(() => {
      throw new Error('Cannot send to buyer: no writable transport');
    });
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ hasSession: () => false, getChannelByPeer: () => undefined }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await expect(mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-closed-payment-required', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) })).resolves.toBeUndefined();

    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendPaymentRequired).toHaveBeenCalledOnce();
    const response = decodeHttpResponse(decodeFrame(sentFrames[0]!)!.message.payload);
    expect(response.statusCode).toBe(402);
  });

  it('skips the 402 / ReserveAuth handshake when a first-time buyer requests a free service', async () => {
    const provider = makeProvider(0, 0, { name: 'free-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const sendNeedAuth = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ hasSession: () => false, getChannelByPeer: () => undefined, getPaymentRequirements: () => ({ minBudgetPerRequest: '0', suggestedAmount: '0' }) }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-free-service', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(sendPaymentRequired).not.toHaveBeenCalled();
    expect(sendNeedAuth).not.toHaveBeenCalled();
    const responseFrames = sentFrames.map((f) => decodeFrame(f)).filter((d) => d?.message.type === MessageType.HttpResponse);
    expect(responseFrames).toHaveLength(1);
    const response = decodeHttpResponse(responseFrames[0]!.message.payload);
    expect(response.statusCode).toBe(200);
  });

  it('enforces the configured free tier before forwarding another free request', async () => {
    const provider = makeProvider(0, 0, { name: 'free-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));
    const stakeTiers = [{ minPower: 520_000, multiplier: 5 }];
    const program = { base: { maxRequestsPerAddress: 1, maxRequestsPerIp: 3, windowMs: 60_000 }, stakeTiers };
    const consume = vi.fn()
      .mockReturnValueOnce({ allowed: true, remaining: 0, retryAfterMs: 0, limitedBy: null, buyerAddress: `0x${'b'.repeat(40)}`, remoteIp: '203.0.113.7', standing: null, tier: null, limit: 1, program })
      .mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 12_500, limitedBy: 'ip', buyerAddress: `0x${'b'.repeat(40)}`, remoteIp: '203.0.113.7', standing: null, tier: null, limit: 3, program });
    const resolveStanding = vi.fn(async () => null);
    const appliesTo = vi.fn(() => true);
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: null,
      sellerFreeTierLimiter: { appliesTo, consume, resolveStanding } as any,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(
      makeConn(sentFrames),
      'b'.repeat(40),
      { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any,
    );
    for (const requestId of ['free-1', 'free-2']) {
      await mux.handleFrame({
        type: MessageType.HttpRequest,
        messageId: sentFrames.length + 1,
        payload: encodeHttpRequest({
          requestId,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json', 'X-Antseed-Free-Tier-Delegations': 'delegations' },
          body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
        }),
      });
    }

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(appliesTo).toHaveBeenCalledWith('local-test');
    expect(resolveStanding).toHaveBeenCalledWith('b'.repeat(40), 'delegations');
    const forwarded = vi.mocked(provider.handleRequest).mock.calls[0]![0] as { headers: Record<string, string> };
    expect(Object.keys(forwarded.headers).map((name) => name.toLowerCase())).not.toContain('x-antseed-free-tier-delegations');
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledWith({ buyerPeerId: 'b'.repeat(40), service: 'local-test', remoteIp: '203.0.113.7', standing: null });
    const responses = sentFrames.map((frame) => decodeHttpResponse(decodeFrame(frame)!.message.payload));
    expect(responses.map((response) => response.statusCode)).toEqual([200, 429]);
    expect(responses[1]!.headers['retry-after']).toBe('13');
    expect(JSON.parse(new TextDecoder().decode(responses[1]!.body))).toMatchObject({
      error: { code: 'free_tier_exhausted', message: expect.stringContaining('Stake ANTS on this seller') },
      limitedBy: 'ip',
      limit: 3,
      windowMs: 60_000,
      retryAfterSeconds: 13,
      stakeTiers,
      stakePower: 0,
    });
  });

  it('refuses a buyer without stake on a stakers-only model with the program to stake for', async () => {
    const provider = makeProvider(0, 0, { name: 'free-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn();
    const stakeTiers = [{ minPower: 520_000, multiplier: 5 }];
    const program = { base: { maxRequestsPerAddress: 10, maxRequestsPerIp: null, windowMs: 86_400_000, stakersOnly: true }, stakeTiers };
    const consume = vi.fn(() => ({ allowed: false, remaining: 0, retryAfterMs: 0, limitedBy: 'stake_required', buyerAddress: `0x${'b'.repeat(40)}`, remoteIp: '203.0.113.7', standing: null, tier: null, limit: 0, program }));
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: null,
      sellerFreeTierLimiter: { appliesTo: () => true, consume, resolveStanding: async () => null } as any,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(
      makeConn(sentFrames),
      'b'.repeat(40),
      { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any,
    );
    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId: 'stakers-only-1',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
      }),
    });

    expect(provider.handleRequest).not.toHaveBeenCalled();
    const response = decodeHttpResponse(decodeFrame(sentFrames[0]!)!.message.payload);
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('86400');
    expect(JSON.parse(new TextDecoder().decode(response.body))).toMatchObject({
      error: { code: 'free_tier_exhausted', message: 'This model is free only for buyers staked on this seller.' },
      limitedBy: 'stake_required',
      limit: 0,
      stakersOnly: true,
      baseLimit: 10,
      stakeTiers,
      stakePower: 0,
    });
  });

  it('serves a free model no free-tier program applies to without counting it', async () => {
    const provider = makeProvider(0, 0, { name: 'free-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));
    const consume = vi.fn();
    const resolveStanding = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: null,
      sellerFreeTierLimiter: { appliesTo: () => false, consume, resolveStanding } as any,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(
      makeConn(sentFrames),
      'b'.repeat(40),
      { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any,
    );
    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId: 'unlimited-1',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
      }),
    });

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
    expect(resolveStanding).not.toHaveBeenCalled();
  });

  it('does not apply the free-tier allowance to paid requests, and drops a provider-sent allowance marker', async () => {
    const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['local-test'] });
    // Only the seller may say a request was free; an upstream copy of the marker must not reach the buyer.
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json', 'X-Antseed-Free-Tier': 'covered' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));
    const consume = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock(),
      // The seller-wide program never applies to a priced service.
      sellerFreeTierLimiter: { appliesTo: (_service: string, options?: { paid?: boolean }) => !options?.paid, consume } as any,
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(
      makeConn(sentFrames),
      'b'.repeat(40),
      { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any,
    );
    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId: 'paid-1',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
      }),
    });

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
    const frame = sentFrames.map((f) => decodeFrame(f)).find((d) => d?.message.type === MessageType.HttpResponse);
    const headers = decodeHttpResponse(frame!.message.payload).headers;
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('x-antseed-free-tier');
  });

  describe('free allowance on a priced service', () => {
    const send = async (covered: boolean) => {
      const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['k3'] });
      provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));
      const appliesTo = vi.fn((_service: string, options?: { paid?: boolean }) => options?.paid === true);
      const consume = vi.fn(() => ({ allowed: covered, limitedBy: covered ? undefined : 'stake_required', buyerAddress: '0xb' }));
      const sendPaymentRequired = vi.fn();
      const sendNeedAuth = vi.fn();
      const handler = makeSellerRequestHandler({
        providers: [provider],
        sellerPaymentManager: makeSpmMock({ hasSession: () => false, getChannelByPeer: () => undefined, getPaymentRequirements: () => ({ minBudgetPerRequest: '1', suggestedAmount: '1' }) }),
        sellerFreeTierLimiter: { appliesTo, consume, resolveStanding: async () => null } as any,
        sessionTracker: null,
        channelsClient: {} as any,
        announcer: null,
        emit: () => false,
      });
      const sentFrames: Uint8Array[] = [];
      const { mux } = handler.handleConnection(makeConn(sentFrames), 'b'.repeat(40), { sendNeedAuth, sendPaymentRequired } as any);
      await mux.handleFrame({
        type: MessageType.HttpRequest,
        messageId: 1,
        payload: encodeHttpRequest({
          requestId: 'allowance-1',
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ model: 'k3' })),
        }),
      });
      const frame = sentFrames.map((f) => decodeFrame(f)).find((d) => d?.message.type === MessageType.HttpResponse);
      return { provider, appliesTo, consume, sendNeedAuth, response: decodeHttpResponse(frame!.message.payload) };
    };

    it('serves a covered request free, without a payment channel, and says so', async () => {
      const { provider, appliesTo, consume, sendNeedAuth, response } = await send(true);
      expect(appliesTo).toHaveBeenCalledWith('k3', { paid: true });
      expect(consume).toHaveBeenCalledWith(expect.objectContaining({ service: 'k3', paid: true }));
      expect(provider.handleRequest).toHaveBeenCalledOnce();
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-antseed-free-tier']).toBe('covered');
      expect(sendNeedAuth).not.toHaveBeenCalled();
    });

    it('asks for payment, not a 429, once the allowance does not cover the buyer', async () => {
      const { provider, response } = await send(false);
      expect(provider.handleRequest).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(402);
      expect(response.headers['x-antseed-free-tier']).toBeUndefined();
    });
  });

  it('skips the first-time buyer 402 when the requested service has a free override on a paid provider', async () => {
    const provider = makeProvider(10, 20, {
      name: 'mixed-tier',
      services: ['free-model'],
      servicePricing: { 'free-model': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ hasSession: () => false, getChannelByPeer: () => undefined }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-free-override', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'free-model' })) }) });

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(sendPaymentRequired).not.toHaveBeenCalled();
    const response = decodeHttpResponse(decodeFrame(sentFrames[0]!)!.message.payload);
    expect(response.statusCode).toBe(200);
  });

  it('continues serving a free service even when an existing paid channel is exhausted', async () => {
    const provider = makeProvider(0, 0, { name: 'free-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const sendNeedAuth = vi.fn();
    const settleSession = vi.fn(async () => {});
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        getCumulativeSpend: () => 1_000_000n,
        getAcceptedCumulative: () => 1_000_000n,
        getReserveMax: () => 1_000_000n,
        settleSession,
      }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-free-exhausted-channel', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(sendPaymentRequired).not.toHaveBeenCalled();
    expect(sendNeedAuth).not.toHaveBeenCalled();
    expect(settleSession).not.toHaveBeenCalled();
    const responseFrames = sentFrames.map((f) => decodeFrame(f)).filter((d) => d?.message.type === MessageType.HttpResponse);
    expect(responseFrames).toHaveLength(1);
    const response = decodeHttpResponse(responseFrames[0]!.message.payload);
    expect(response.statusCode).toBe(200);
  });

  it('continues serving when delivered spend exactly matches the last accepted auth and reserve covers the next estimate', async () => {
    const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const sendNeedAuth = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ getCumulativeSpend: () => 2_184n, getAcceptedCumulative: () => 2_184n, getReserveMax: () => 1_000_000n }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-exactly-covered', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(sendPaymentRequired).not.toHaveBeenCalled();
    expect(sendNeedAuth).toHaveBeenCalledOnce();
    const responseFrames = sentFrames.map((f) => decodeFrame(f)).filter((d) => d?.message.type === MessageType.HttpResponse);
    expect(responseFrames).toHaveLength(1);
    const response = decodeHttpResponse(responseFrames[0]!.message.payload);
    expect(response.statusCode).toBe(200);
  });

  it('continues serving when the next estimate exceeds locked reserve by default', async () => {
    const provider = makeProvider(0, 1_000_000, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const sendNeedAuth = vi.fn();
    const settleSession = vi.fn(async () => {});
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        getCumulativeSpend: () => 100_000n,
        getAcceptedCumulative: () => 100_000n,
        getReserveMax: () => 1_000_000n,
        settleSession,
      }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-estimate-within-overdraft', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test', max_tokens: 1 })) }) });

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(sendPaymentRequired).not.toHaveBeenCalled();
    expect(settleSession).not.toHaveBeenCalled();
    const response = decodeHttpResponse(decodeFrame(sentFrames[0]!)!.message.payload);
    expect(response.statusCode).toBe(200);
  });

  it('closes below-threshold channels when the next estimate exceeds locked reserve', async () => {
    const provider = makeProvider(0, 1_000_000, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const sendNeedAuth = vi.fn();
    const settleSession = vi.fn(async () => {});
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        getCumulativeSpend: () => 500_000n,
        getAcceptedCumulative: () => 500_000n,
        getReserveMax: () => 1_000_000n,
        settleSession,
      }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      reserveEstimateOverdraftUsdc: 0n,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-estimate-exceeds-reserve', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test', max_tokens: 1 })) }) });

    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendNeedAuth).not.toHaveBeenCalled();
    expect(settleSession).toHaveBeenCalledWith('b'.repeat(40));
    expect(sendPaymentRequired).toHaveBeenCalledWith(expect.objectContaining({ code: PAYMENT_CODE_CHANNEL_EXHAUSTED, requiredCumulativeAmount: '500000', reserveMaxAmount: '1000000' }));
    const response = decodeHttpResponse(decodeFrame(sentFrames[0]!)!.message.payload);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(response.statusCode).toBe(402);
    expect(body).toMatchObject({
      code: PAYMENT_CODE_CHANNEL_EXHAUSTED,
      requiredCumulativeAmount: '500000',
      reserveMaxAmount: '1000000',
      estimatedRequestCost: '1000000',
      remainingLockedReserve: '500000',
      estimatedMaxOutputTokens: '1',
    });
    expect(BigInt(body.estimatedInputTokens)).toBeGreaterThan(0n);
  });

  it('checks the chain before closing a channel whose estimate only exceeds a stale stored ceiling', async () => {
    const provider = makeProvider(0, 1_000_000, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));
    let reserveMax = 1_000_000n;
    const settleSession = vi.fn(async () => {});
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        getCumulativeSpend: () => 500_000n,
        getAcceptedCumulative: () => 500_000n,
        getReserveMax: () => reserveMax,
        // A top-up to 3M confirmed on-chain but is not in the store.
        refreshReserveMaxFromChain: vi.fn(async () => { reserveMax = 3_000_000n; return reserveMax; }),
        settleSession,
      }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      reserveEstimateOverdraftUsdc: 0n,
      emit: () => false,
    });
    const sentFrames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(makeConn(sentFrames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-estimate-stale-ceiling', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test', max_tokens: 1 })) }) });

    expect(settleSession).not.toHaveBeenCalled();
    expect(provider.handleRequest).toHaveBeenCalledTimes(1);
  });

  it('stops serving when delivered spend is already at the reserve ceiling', async () => {
    const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const settleSession = vi.fn(async () => {});
    const sendPaymentRequired = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ getCumulativeSpend: () => 1_000_000n, getAcceptedCumulative: () => 1_000_000n, settleSession }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-ceiling', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendPaymentRequired).toHaveBeenCalledOnce();
    expect(settleSession).toHaveBeenCalledOnce();
    const response = decodeHttpResponse(decodeFrame(sentFrames[0]!)!.message.payload);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(response.statusCode).toBe(402);
    expect(body).toMatchObject({ code: PAYMENT_CODE_CHANNEL_EXHAUSTED, requiredCumulativeAmount: '1000000', reserveMaxAmount: '1000000' });
  });

  it('stops serving once delivered spend is ahead of the last accepted auth', async () => {
    const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({ getCumulativeSpend: () => 2_184n, getAcceptedCumulative: () => 0n }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-exhausted-budget', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendPaymentRequired).toHaveBeenCalledOnce();
    expect(sentFrames).toHaveLength(1);
    const decoded = decodeFrame(sentFrames[0]!);
    expect(decoded?.message.type).toBe(MessageType.HttpResponse);
    const response = decodeHttpResponse(decoded!.message.payload);
    expect(response.statusCode).toBe(402);
  });

  it('closes and flags the channel when unsigned delivered spend exceeds the reserve ceiling', async () => {
    const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const sendNeedAuth = vi.fn();
    const settleSession = vi.fn(async () => {});
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        getChannelByPeer: () => ({ sessionId: 'session-1', authMax: '950001' }),
        getCumulativeSpend: () => 1_000_001n,
        getAcceptedCumulative: () => 950_001n,
        settleSession,
      }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-near-ceiling', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendNeedAuth).not.toHaveBeenCalled();
    expect(settleSession).toHaveBeenCalledOnce();
    expect(settleSession.mock.calls[0]?.[0]).toBe('b'.repeat(40));
    expect(settleSession.mock.calls[0]?.[1]?.settleOnly).not.toBe(true);
    expect(sendPaymentRequired).toHaveBeenCalledWith(expect.objectContaining({ code: PAYMENT_CODE_CHANNEL_EXHAUSTED, requiredCumulativeAmount: '1000001', reserveMaxAmount: '1000000' }));
    const decoded = decodeFrame(sentFrames[0]!);
    expect(decoded?.message.type).toBe(MessageType.HttpResponse);
    const response = decodeHttpResponse(decoded!.message.payload);
    expect(response.statusCode).toBe(402);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(body).toMatchObject({ code: PAYMENT_CODE_CHANNEL_EXHAUSTED, requiredCumulativeAmount: '1000001', reserveMaxAmount: '1000000' });
  });

  it('does not route a blocked channel after permanent top-up failure', async () => {
    const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const settleSession = vi.fn(async () => {});
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        getCumulativeSpend: () => 900_000n,
        getAcceptedCumulative: () => 900_000n,
        getReserveMax: () => 1_000_000n,
        getEffectiveReserveMax: () => 1_000_000n,
        isChannelBlocked: () => true,
        settleSession,
      }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-blocked-topup', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendPaymentRequired).toHaveBeenCalledWith(expect.objectContaining({ code: PAYMENT_CODE_CHANNEL_EXHAUSTED, requiredCumulativeAmount: '900000', reserveMaxAmount: '1000000' }));
    expect(settleSession).toHaveBeenCalledOnce();
    const response = decodeHttpResponse(decodeFrame(sentFrames[0]!)!.message.payload);
    expect(response.statusCode).toBe(402);
  });

  it('stops serving when spend reached the on-chain ceiling even if a higher topUp is pending', async () => {
    const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));

    const sendPaymentRequired = vi.fn();
    const sendNeedAuth = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock({
        getCumulativeSpend: () => 1_000_000n,
        getAcceptedCumulative: () => 1_000_000n,
        getReserveMax: () => 1_000_000n,
      }),
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = makeConn(sentFrames);
    const paymentMux = { sendNeedAuth, sendPaymentRequired } as any;
    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-pending-topup', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })) }) });

    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendPaymentRequired).toHaveBeenCalledWith(expect.objectContaining({ code: PAYMENT_CODE_CHANNEL_EXHAUSTED, reserveMaxAmount: '1000000' }));
    expect(sendNeedAuth).not.toHaveBeenCalled();
    const response = decodeHttpResponse(decodeFrame(sentFrames[0]!)!.message.payload);
    expect(response.statusCode).toBe(402);
  });
});

it('asks the buyer for the unsigned spend before parking a request on it, once per spend level', async () => {
  let accepted = 100_000n;
  const sendNeedAuth = vi.fn();
  const promptedBeforeWait: boolean[] = [];
  const handler = makeSellerRequestHandler({
    providers: [makeProvider(1, 1, { name: 'openai', services: ['test-model'] })],
    sellerPaymentManager: makeSpmMock({
      getCumulativeSpend: () => 300_000n,
      getAcceptedCumulative: () => accepted,
      getReserveMax: () => 1_000_000n,
      awaitAcceptedAtLeast: async (_channelId: string, target: bigint) => {
        promptedBeforeWait.push(sendNeedAuth.mock.calls.some(([payload]) => payload.requiredCumulativeAmount === target.toString()));
        accepted = target;
        return true;
      },
    }),
    channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
  });
  const frames: Uint8Array[] = [];
  const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth, sendPaymentRequired: vi.fn() } as any);
  for (const messageId of [1, 2]) {
    accepted = 100_000n;
    await mux.handleFrame({ type: MessageType.HttpRequest, messageId, payload: encodeHttpRequest({
      requestId: `r-${messageId}`, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
    }) });
  }

  expect(promptedBeforeWait).toEqual([true, true]);
  const prompts = sendNeedAuth.mock.calls.filter(([payload]) => payload.lastRequestCost == null);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]![0]).toMatchObject({ requiredCumulativeAmount: '300000', currentAcceptedCumulative: '100000' });
});

it('re-reads the spend after a parked catch-up: an auth for the earlier spend never releases newer unpaid work', async () => {
  for (const coversNewSpend of [false, true]) {
    let spent = 300_000n;
    let accepted = 100_000n;
    const targets: bigint[] = [];
    const handler = makeSellerRequestHandler({
      providers: [makeProvider(1, 1, { name: 'openai', services: ['test-model'] })],
      sellerPaymentManager: makeSpmMock({
        getCumulativeSpend: () => spent,
        getAcceptedCumulative: () => accepted,
        getReserveMax: () => 1_000_000n,
        awaitAcceptedAtLeast: async (_channelId: string, target: bigint) => {
          targets.push(target);
          if (targets.length === 1) {
            // The auth for 300k lands, but another request finished meanwhile.
            spent = 400_000n;
            accepted = target;
            return true;
          }
          if (!coversNewSpend) return false;
          accepted = target;
          return true;
        },
      }),
      channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
    });
    const frames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
      requestId: 'parked', method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
    }) });

    expect(targets).toEqual([300_000n, 400_000n]);
    const status = decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode;
    expect(status).toBe(coversNewSpend ? 200 : 402);
  }
});

it('never serves a request parked on a catch-up when its channel is evicted during the wait', async () => {
  let spent = 300_000n;
  let accepted = 100_000n;
  let channel: { sessionId: string; authMax: string } | null = { sessionId: 'session-1', authMax: '1000000' };
  const provider = makeProvider(1, 1, { name: 'openai', services: ['test-model'] });
  const handleRequest = vi.spyOn(provider, 'handleRequest');
  const handler = makeSellerRequestHandler({
    providers: [provider],
    sellerPaymentManager: makeSpmMock({
      getChannelByPeer: () => channel,
      getCumulativeSpend: () => spent,
      getAcceptedCumulative: () => accepted,
      getReserveMax: () => 1_000_000n,
      awaitAcceptedAtLeast: async () => {
        // Eviction forgets the counters and releases waiters with false.
        channel = null;
        spent = 0n;
        accepted = 0n;
        return false;
      },
    }),
    channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
  });
  const frames: Uint8Array[] = [];
  const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
  await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
    requestId: 'parked-evicted', method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
  }) });

  expect(handleRequest).not.toHaveBeenCalled();
  expect(decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode).toBe(402);
});

it('judges exhaustion on the reserve ceiling after a parked catch-up, so a top-up that landed meanwhile keeps the channel open', async () => {
  let spent = 2_500_000n;
  let accepted = 1_900_000n;
  let reserveMax = 2_000_000n;
  const settleSession = vi.fn(async () => {});
  const handler = makeSellerRequestHandler({
    providers: [makeProvider(1, 1, { name: 'openai', services: ['test-model'] })],
    sellerPaymentManager: makeSpmMock({
      getCumulativeSpend: () => spent,
      getAcceptedCumulative: () => accepted,
      getReserveMax: () => reserveMax,
      settleSession,
      awaitAcceptedAtLeast: async (_channelId: string, target: bigint) => {
        // The top-up to 4M confirms, then the buyer's auth for the spend lands.
        reserveMax = 4_000_000n;
        accepted = target;
        return true;
      },
    }),
    channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
  });
  const frames: Uint8Array[] = [];
  const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
  await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
    requestId: 'parked-topped-up', method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
  }) });

  expect(decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode).toBe(200);
  expect(settleSession).not.toHaveBeenCalled();
});

it('checks a stale stored ceiling against the chain before closing a channel as exhausted', async () => {
  // After a restart the store says 7M, but a top-up to 8M confirmed on-chain.
  let reserveMax = 7_000_000n;
  const settleSession = vi.fn(async () => {});
  const refreshReserveMaxFromChain = vi.fn(async () => {
    reserveMax = 8_000_000n;
    return reserveMax;
  });
  const handler = makeSellerRequestHandler({
    providers: [makeProvider(1, 1, { name: 'openai', services: ['test-model'] })],
    sellerPaymentManager: makeSpmMock({
      getCumulativeSpend: () => 7_459_839n,
      getAcceptedCumulative: () => 6_509_280n,
      getReserveMax: () => reserveMax,
      refreshReserveMaxFromChain,
      settleSession,
    }),
    channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
  });
  const frames: Uint8Array[] = [];
  const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
  await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
    requestId: 'after-restart', method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
  }) });

  const response = decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload);
  expect(refreshReserveMaxFromChain).toHaveBeenCalled();
  // Still a catch-up 402 for the unsigned spend, but not an exhausted one.
  expect(response.statusCode).toBe(402);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  expect(body.code).toBeUndefined();
  expect(body.reserveMaxAmount).toBe('8000000');
  expect(settleSession).not.toHaveBeenCalled();
});

it('never serves a request whose channel closed during the reserve ceiling check', async () => {
  let channel: { sessionId: string; authMax: string } | null = { sessionId: 'session-1', authMax: '1000000' };
  let spent = 1_000_000n;
  let accepted = 1_000_000n;
  let reserveMax = 1_000_000n;
  const provider = makeProvider(1, 1, { name: 'openai', services: ['test-model'] });
  const handleRequest = vi.spyOn(provider, 'handleRequest');
  const handler = makeSellerRequestHandler({
    providers: [provider],
    sellerPaymentManager: makeSpmMock({
      getChannelByPeer: () => channel,
      getCumulativeSpend: () => spent,
      getAcceptedCumulative: () => accepted,
      getReserveMax: () => reserveMax,
      refreshReserveMaxFromChain: async () => {
        // A cooperative close lands meanwhile and forgets the channel.
        channel = null;
        spent = 0n;
        accepted = 0n;
        reserveMax = 0n;
        return 0n;
      },
    }),
    channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
  });
  const frames: Uint8Array[] = [];
  const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
  await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
    requestId: 'closed-during-refresh', method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
  }) });

  expect(handleRequest).not.toHaveBeenCalled();
  expect(decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode).toBe(402);
});

it('waits for a running top-up before treating a channel at its ceiling as exhausted', async () => {
  for (const lands of [true, false]) {
    let reserveMax = 1_000_000n;
    const settleSession = vi.fn(async () => {});
    const handler = makeSellerRequestHandler({
      providers: [makeProvider(1, 1, { name: 'openai', services: ['test-model'] })],
      sellerPaymentManager: makeSpmMock({
        getCumulativeSpend: () => 1_000_000n,
        getAcceptedCumulative: () => 1_000_000n,
        getReserveMax: () => reserveMax,
        settleSession,
        isTopUpRunning: () => true,
        waitForTopUp: async () => {
          if (lands) reserveMax = 2_000_000n;
          return lands;
        },
      }),
      channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
    });
    const frames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
      requestId: `at-ceiling-${lands}`, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
    }) });

    const response = decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload);
    // Landed: served on the raised ceiling. Still mining: a retryable answer, never a close.
    expect(response.statusCode).toBe(lands ? 200 : 503);
    if (!lands) expect(JSON.parse(new TextDecoder().decode(response.body)).error).toBe('top_up_pending');
    expect(settleSession).not.toHaveBeenCalled();
  }
});

it('waits for a pending top-up to start, between two top-ups, before treating the channel as exhausted', async () => {
  let reserveMax = 1_000_000n;
  const settleSession = vi.fn(async () => {});
  const waitForTopUp = vi.fn(async () => {
    // The next top-up starts and lands.
    reserveMax = 2_000_000n;
    return true;
  });
  const handler = makeSellerRequestHandler({
    providers: [makeProvider(1, 1, { name: 'openai', services: ['test-model'] })],
    sellerPaymentManager: makeSpmMock({
      getCumulativeSpend: () => 1_500_000n,
      getAcceptedCumulative: () => 1_500_000n,
      getReserveMax: () => reserveMax,
      settleSession,
      // The last top-up just landed; the one covering this spend is queued.
      isTopUpRunning: () => false,
      isTopUpPendingFor: (_channelId: string, amount: bigint) => amount > reserveMax && amount <= 2_000_000n,
      waitForTopUp,
    }),
    channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
  });
  const frames: Uint8Array[] = [];
  const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
  await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
    requestId: 'between-top-ups', method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
  }) });

  expect({
    status: decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload).statusCode,
    covering: waitForTopUp.mock.calls[0]?.[2],
    closed: settleSession.mock.calls.length,
  }).toEqual({ status: 200, covering: 1_500_000n, closed: 0 });
});

describe('a channel at its ceiling while top-ups follow each other', () => {
  /** One request against a seller whose payment manager is the given mock; returns what the buyer got. */
  async function requestAtCeiling(requestId: string, spm: Record<string, unknown>) {
    const settleSession = vi.fn(async () => {});
    const handler = makeSellerRequestHandler({
      providers: [makeProvider(1, 1, { name: 'openai', services: ['test-model'] })],
      sellerPaymentManager: makeSpmMock({ settleSession, ...spm }),
      channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
    });
    const frames: Uint8Array[] = [];
    const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any);
    await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
      requestId, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'test-model', messages: [] })),
    }) });
    const response = decodeHttpResponse(decodeFrame(frames.at(-1)!)!.message.payload);
    const body = response.statusCode === 200 ? {} : JSON.parse(new TextDecoder().decode(response.body));
    return { status: response.statusCode, answer: body.code ?? body.error ?? null, closed: settleSession.mock.calls.length };
  }

  it('keeps the channel open when the next top-up starts mining while the ceiling is re-read after one lands', async () => {
    // Parallel load over a slow RPC: the awaited top-up lands, and during the chain read that follows,
    // requests that finish push the spend past the new ceiling while the next top-up, which covers it, starts.
    let reserveMax = 1_000_000n;
    let spent = 1_000_000n;
    let running = true;
    const waitForTopUp = vi.fn(async () => {
      reserveMax += 1_000_000n;
      running = false;
      return true;
    });
    const result = await requestAtCeiling('next-top-up-mining', {
      getCumulativeSpend: () => spent,
      getAcceptedCumulative: () => (spent < reserveMax ? spent : reserveMax),
      getReserveMax: () => reserveMax,
      isTopUpRunning: () => running,
      waitForTopUp,
      async refreshReserveMaxFromChain() {
        if (reserveMax === 2_000_000n && spent === 1_000_000n) {
          spent = 2_300_000n;
          running = true;
        }
        return reserveMax;
      },
    });

    expect({ ...result, waits: waitForTopUp.mock.calls.length }).toEqual({ status: 200, answer: null, closed: 0, waits: 2 });
  });

  it('serves, not 402, when the catch-up auth was parked behind a top-up that lands during the wait', async () => {
    // The buyer signed past the old ceiling, so its auth waits for the top-up. On a slow chain the
    // top-up lands just as the catch-up wait runs out, and the parked auth applies a moment later.
    let reserveMax = 1_000_000n;
    let accepted = 1_000_000n;
    let running = true;
    const awaitAcceptedAtLeast = vi.fn(async () => {
      if (awaitAcceptedAtLeast.mock.calls.length === 1) {
        reserveMax = 2_000_000n;
        running = false;
        return false;
      }
      accepted = 1_300_000n;
      return true;
    });
    const result = await requestAtCeiling('auth-parked-behind-top-up', {
      getCumulativeSpend: () => 1_300_000n,
      getAcceptedCumulative: () => accepted,
      getReserveMax: () => reserveMax,
      isTopUpRunning: () => running,
      awaitAcceptedAtLeast,
    });

    expect({ ...result, waits: awaitAcceptedAtLeast.mock.calls.length }).toEqual({ status: 200, answer: null, closed: 0, waits: 2 });
  });

  it('still answers 402 when the catch-up never arrives and no top-up raised the ceiling', async () => {
    const awaitAcceptedAtLeast = vi.fn(async () => false);
    const result = await requestAtCeiling('no-catch-up', {
      getCumulativeSpend: () => 1_300_000n,
      getAcceptedCumulative: () => 1_000_000n,
      getReserveMax: () => 2_000_000n,
      awaitAcceptedAtLeast,
    });

    expect({ status: result.status, closed: result.closed, waits: awaitAcceptedAtLeast.mock.calls.length }).toEqual({ status: 402, closed: 0, waits: 1 });
  });

  it('waits for a top-up that starts during the ceiling read when none was running on entry', async () => {
    // Nothing is mining or queued when the request reaches the ceiling. During the chain read the buyer's
    // next ReserveAuth arrives, its top-up starts, and requests that finish push the spend past the ceiling.
    let reserveMax = 1_000_000n;
    let spent = 1_000_000n;
    let running = false;
    const waitForTopUp = vi.fn(async () => {
      reserveMax = 2_000_000n;
      running = false;
      return true;
    });
    const result = await requestAtCeiling('top-up-starts-during-read', {
      getCumulativeSpend: () => spent,
      getAcceptedCumulative: () => (spent < reserveMax ? spent : reserveMax),
      getReserveMax: () => reserveMax,
      isTopUpRunning: () => running,
      waitForTopUp,
      async refreshReserveMaxFromChain() {
        if (spent === 1_000_000n) {
          spent = 1_300_000n;
          running = true;
        }
        return reserveMax;
      },
    });

    expect({ ...result, waits: waitForTopUp.mock.calls.length }).toEqual({ status: 200, answer: null, closed: 0, waits: 1 });
  });

  it('answers a retryable 503, never exhausted, when a top-up is still mining at the end of the wait budget', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let reserveMax = 1_000_000n;
      let spent = 1_000_000n;
      // Each top-up takes 8 s to land, the spend is past the new ceiling by then, and the next one is mining.
      const waitForTopUp = vi.fn(async () => {
        now += 8_000;
        reserveMax += 1_000_000n;
        spent = reserveMax + 300_000n;
        return true;
      });
      const result = await requestAtCeiling('top-ups-keep-mining', {
        getCumulativeSpend: () => spent,
        getAcceptedCumulative: () => (spent < reserveMax ? spent : reserveMax),
        getReserveMax: () => reserveMax,
        isTopUpRunning: () => true,
        waitForTopUp,
      });

      expect({ ...result, waits: waitForTopUp.mock.calls.length }).toEqual({ status: 503, answer: 'top_up_pending', closed: 0, waits: 2 });
    } finally {
      clock.mockRestore();
    }
  });

  it('closes as exhausted after one wait when the spend is past the new ceiling and no top-up covers it', async () => {
    let reserveMax = 1_000_000n;
    let spent = 1_000_000n;
    let running = true;
    const waitForTopUp = vi.fn(async () => {
      reserveMax = 2_000_000n;
      spent = 2_300_000n;
      running = false;
      return true;
    });
    const result = await requestAtCeiling('nothing-covers-the-spend', {
      getCumulativeSpend: () => spent,
      getAcceptedCumulative: () => (spent < reserveMax ? spent : reserveMax),
      getReserveMax: () => reserveMax,
      isTopUpRunning: () => running,
      waitForTopUp,
    });

    expect({ ...result, waits: waitForTopUp.mock.calls.length }).toEqual({ status: 402, answer: PAYMENT_CODE_CHANNEL_EXHAUSTED, closed: 1, waits: 1 });
  });

  it('waits once, not for the whole budget, for a queued top-up that never starts', async () => {
    const waitForTopUp = vi.fn(async () => true);
    const result = await requestAtCeiling('queued-top-up-never-starts', {
      getCumulativeSpend: () => 1_500_000n,
      getAcceptedCumulative: () => 1_000_000n,
      getReserveMax: () => 1_000_000n,
      isTopUpRunning: () => false,
      isTopUpPendingFor: () => true,
      waitForTopUp,
    });

    expect({ ...result, waits: waitForTopUp.mock.calls.length }).toEqual({ status: 402, answer: PAYMENT_CODE_CHANNEL_EXHAUSTED, closed: 1, waits: 1 });
  });
});


/** A speech answer: three 417-byte MPEG-1 layer III frames (128 kbps, 44.1 kHz). */
const SPEECH_MP3 = new Uint8Array(417 * 3);
for (const offset of [0, 417, 834]) SPEECH_MP3.set([0xff, 0xfb, 0x90, 0x00], offset);

describe('speech seller payments', () => {
  function setup(providerResponse?: { statusCode: number; contentType: string; body: Uint8Array }) {
    let spend = 0n;
    const provider = makeProvider(0.1, 0.45, { name: 'openai', services: ['tts-kokoro'] });
    provider.serviceApiProtocols = { 'tts-kokoro': ['openai-audio-speech'] };
    // $62.50 per million characters.
    provider.serviceUnitBillingModels = { 'tts-kokoro': { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd: 0.0000625 }] } } };
    provider.serviceCapabilities = { 'tts-kokoro': { inputs: ['text'], outputs: ['audio'], speech: { voices: ['af_sky', 'am_adam'] } } };
    const answer = providerResponse ?? { statusCode: 200, contentType: 'audio/mpeg', body: SPEECH_MP3 };
    provider.handleRequest = vi.fn(async request => ({ requestId: request.requestId, statusCode: answer.statusCode, headers: { 'content-type': answer.contentType }, body: answer.body }));
    delete (provider as Partial<Provider>).handleRequestStream;
    const spm = makeSpmMock({
      recordSpend: vi.fn((_channel: string, amount: bigint) => { spend += amount; }),
      getCumulativeSpend: () => spend, getAcceptedCumulative: () => spend,
    });
    const frames: Uint8Array[] = [];
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() };
    const handler = makeSellerRequestHandler({ providers: [provider], sellerPaymentManager: spm, sessionTracker: null, channelsClient: {} as any, announcer: null, emit: () => false });
    const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), paymentMux as any);
    const send = async (body: Record<string, unknown>, requestId = 'speech') => {
      await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
        requestId, method: 'POST', path: '/v1/audio/speech',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      }) });
      return frames.map(frame => decodeHttpResponse(decodeFrame(frame).message!.payload)).reverse().find(response => response.requestId === requestId)!;
    };
    return { provider, spm, paymentMux, send };
  }

  it('charges the characters of a delivered speech and passes the audio through', async () => {
    const harness = setup();
    const response = await harness.send({ model: 'tts-kokoro', input: 'a'.repeat(1000), voice: 'af_sky' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(Array.from(response.body)).toEqual(Array.from(SPEECH_MP3));
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 62_500n);
    expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ lastRequestCost: '62500', billingUsage: { version: 1, units: { input_characters: '1000' } } }));
  });

  it('refuses a voice the service does not offer before reaching the upstream or charging', async () => {
    const harness = setup();
    const response = await harness.send({ model: 'tts-kokoro', input: 'Hello', voice: 'alloy' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
      error: { code: 'unsupported_voice', message: 'Voice "alloy" is not offered by this service. Available voices: af_sky, am_adam' },
    });
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
    expect(harness.spm.recordSpend).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([['a number', 5], ['a list', ['Hello']]])('refuses speech input sent as %s before reaching the upstream or asking for payment', async (_name, input) => {
    const harness = setup();
    const response = await harness.send({ model: 'tts-kokoro', input, voice: 'af_sky' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(response.body)).error.code).toBe('invalid_billing_request');
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendNeedAuth).not.toHaveBeenCalled();
    expect(harness.spm.recordSpend).not.toHaveBeenCalled();
  });

  it('charges nothing when the upstream refuses, even with an audio content type', async () => {
    const harness = setup({ statusCode: 400, contentType: 'audio/mpeg; charset=utf-8', body: new TextEncoder().encode('{"error":"Voice is not supported"}') });
    expect((await harness.send({ model: 'tts-kokoro', input: 'Hello', voice: 'af_sky' })).statusCode).toBe(400);
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 0n);
  });
});

describe('data service seller payments', () => {
  const answer = { flights: [{ id: 'LY1' }] };
  function setup(overrides: Record<string, unknown> = {}, handlerOptions: Record<string, unknown> = {}) {
    let spend = 0n;
    const provider = makeProvider(10, 10, { name: 'openapi', services: ['flights', 'chat'] });
    provider.serviceApiProtocols = { flights: ['openapi-data'] };
    provider.serviceUnitBillingModels = { flights: { 'openapi-data': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.005 }] } } };
    provider.pricing = { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 }, services: { flights: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } };
    provider.handleRequest = vi.fn(async request => ({ requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(answer)) }));
    delete (provider as Partial<Provider>).handleRequestStream;
    const spm = makeSpmMock({
      recordSpend: vi.fn((_channel: string, amount: bigint) => { spend += amount; }),
      getCumulativeSpend: () => spend, getAcceptedCumulative: () => spend, ...overrides,
    });
    const frames: Uint8Array[] = [];
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() };
    const handler = makeSellerRequestHandler({ providers: [provider], sellerPaymentManager: spm, sessionTracker: null, channelsClient: {} as any, announcer: null, emit: () => false, ...handlerOptions });
    const { mux } = handler.handleConnection(makeConn(frames), 'b'.repeat(40), paymentMux as any);
    const send = async (requestId = 'fixed', patch: Partial<SerializedHttpRequest> = {}) => {
      await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({
        requestId, method: 'POST', path: '/v1/data/flights/search?limit=5',
        headers: { 'content-type': 'application/json' },
        // The body is the operation's own: a `model` field in it names nothing here.
        body: new TextEncoder().encode(JSON.stringify({ from: 'TLV', to: 'LIS', model: 'chat' })), ...patch,
      }) });
      return frames.map(frame => decodeHttpResponse(decodeFrame(frame).message!.payload)).reverse().find(response => response.requestId === requestId)!;
    };
    return { provider, spm, paymentMux, send };
  }

  it('charges the per-request price for a delivered answer, with zero tokens', async () => {
    const harness = setup();
    const response = await harness.send();
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual(answer);
    expect(vi.mocked(harness.provider.handleRequest).mock.calls[0]![0].path).toBe('/v1/data/flights/search?limit=5');
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 5000n);
    expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ lastRequestCost: '5000', inputTokens: '0', outputTokens: '0', billingUsage: { version: 1, units: { completed_requests: '1' } } }));
  });

  it('serves the service description for free, before any payment step', async () => {
    const harness = setup({ hasSession: () => false });
    const headers = { 'X-Antseed-Buyer-Peer-Id': 'f'.repeat(40) };
    expect((await harness.send('describe', { method: 'GET', path: '/v1/data/flights/openapi.json', headers, body: new Uint8Array() })).statusCode).toBe(200);
    const forwarded = vi.mocked(harness.provider.handleRequest).mock.calls[0]![0];
    expect(forwarded.path).toBe('/v1/data/flights/openapi.json');
    expect(forwarded.headers['x-antseed-buyer-peer-id']).toBe('b'.repeat(40));
    expect(harness.spm.recordSpend).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
  });

  it('answers a description request for a service this seller does not offer with 404', async () => {
    const harness = setup();
    const response = await harness.send('missing', { method: 'GET', path: '/v1/data/hotels/openapi.json', headers: {}, body: new Uint8Array() });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toMatchObject({ error: { code: 'model_not_found' } });
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
  });

  it('negotiates payment before running an operation', async () => {
    let hasSession = false;
    const harness = setup({ hasSession: () => hasSession });
    expect((await harness.send()).statusCode).toBe(402);
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();
    hasSession = true;
    expect((await harness.send()).statusCode).toBe(200);
    expect(harness.provider.handleRequest).toHaveBeenCalledOnce();
  });

  it('does not charge an error or an empty answer', async () => {
    for (const [statusCode, body] of [[400, '{"error":"unknown airport"}'], [502, '{}'], [200, '']] as const) {
      const harness = setup();
      vi.mocked(harness.provider.handleRequest).mockImplementation(async request => ({ requestId: request.requestId, statusCode, headers: {}, body: new TextEncoder().encode(body) }));
      expect((await harness.send()).statusCode).toBe(statusCode);
      expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 0n);
      expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ lastRequestCost: '0', billingUsage: { version: 1, units: { completed_requests: '0' } } }));
    }
  });

  it('lets the provider refuse an operation it does not serve, before any payment step', async () => {
    const harness = setup({ hasSession: () => false });
    harness.provider.checkRequest = vi.fn(request => request.path.startsWith('/v1/data/flights/search')
      ? null
      : { statusCode: 404, code: 'unknown_operation', message: 'flights has no operation at /book' });
    const refused = await harness.send('refused', { path: '/v1/data/flights/book' });
    expect(refused.statusCode).toBe(404);
    expect(JSON.parse(new TextDecoder().decode(refused.body))).toEqual({ error: { code: 'unknown_operation', message: 'flights has no operation at /book' } });
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
    expect(harness.spm.recordSpend).not.toHaveBeenCalled();
    // The description is answered before the provider's check runs.
    expect((await harness.send('describe', { method: 'GET', path: '/v1/data/flights/openapi.json', body: new Uint8Array() })).statusCode).toBe(200);
    expect(harness.provider.checkRequest).toHaveBeenCalledTimes(1);
  });

  it('serves one service on chat and on data, each billed its own way', async () => {
    const harness = setup();
    harness.provider.serviceApiProtocols = { flights: ['openai-chat-completions', 'openapi-data'] };
    const chat = await harness.send('chat', {
      path: '/v1/chat/completions',
      body: new TextEncoder().encode(JSON.stringify({ model: 'flights', messages: [{ role: 'user', content: 'TLV to LIS' }] })),
    });
    expect(chat.statusCode).toBe(200);
    expect(harness.spm.recordSpend).not.toHaveBeenCalledWith('session-1', 5000n);
    const data = await harness.send('data');
    expect(data.statusCode).toBe(200);
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 5000n);
    expect(vi.mocked(harness.provider.handleRequest).mock.calls.map(call => call[0].path)).toEqual(['/v1/chat/completions', '/v1/data/flights/search?limit=5']);
  });

  it('refuses an operation whose price does not fit in what is left of the reserve, when the seller checks estimates', async () => {
    const harness = setup({ getReserveMax: () => 8_000n }, { reserveEstimateOverdraftUsdc: 0n });
    expect((await harness.send('first')).statusCode).toBe(200);
    // 5,000 of 8,000 is spent. The estimate of a data call is its price, so a second one does not fit and is not run.
    const second = await harness.send('second');
    expect(second.statusCode).toBe(402);
    expect(JSON.parse(new TextDecoder().decode(second.body))).toMatchObject({ estimatedRequestCost: '5000', remainingLockedReserve: '3000' });
    expect(harness.provider.handleRequest).toHaveBeenCalledTimes(1);
    expect(harness.spm.recordSpend).toHaveBeenCalledTimes(1);
  });

  it("passes a data API's own 401, 402, 403 and 429 answers on unchanged", async () => {
    for (const statusCode of [401, 402, 403, 429]) {
      const harness = setup();
      const body = JSON.stringify({ error: { code: `flights_${statusCode}`, detail: 'from the flights API' } });
      vi.mocked(harness.provider.handleRequest).mockImplementation(async request => ({
        requestId: request.requestId, statusCode, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(body),
      }));
      const response = await harness.send(`s${statusCode}`);
      expect(response.statusCode).toBe(statusCode);
      expect(new TextDecoder().decode(response.body)).toBe(body);
    }
  });

  it("marks a data provider's answers as its own and keeps a data API's 4xx out of the seller's health", async () => {
    const events: Array<{ statusCode: number }> = [];
    const emit = vi.fn((event: string, payload: { statusCode: number }) => { if (event === 'provider:response') events.push(payload); return true; });
    const harness = setup({}, { emit });
    vi.mocked(harness.provider.handleRequest).mockImplementation(async request => ({
      requestId: request.requestId, statusCode: 401, headers: { 'content-type': 'application/json', 'x-antseed-data-response': 'forged' }, body: new TextEncoder().encode('{"error":"bad key"}'),
    }));
    for (const id of ['a', 'b', 'c']) {
      const response = await harness.send(id);
      expect(response.statusCode).toBe(401);
      expect(response.headers['x-antseed-data-response']).toBe('provider');
    }
    expect(events).toEqual([]);
    // A seller refusal before the operation runs carries no mark.
    const refused = await harness.send('other', { path: '/v1/data/hotels/search' });
    expect(refused.headers['x-antseed-data-response']).toBeUndefined();
  });

  it('runs a data call buffered even on a provider that can stream, and marks its answer', async () => {
    const harness = setup();
    const contract = '{"error":"payment_required","minBudgetPerRequest":"10000"}';
    harness.provider.handleRequestStream = vi.fn(async () => { throw new Error('a data call must not stream'); });
    vi.mocked(harness.provider.handleRequest).mockImplementation(async request => ({
      requestId: request.requestId, statusCode: 402, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(contract),
    }));
    const response = await harness.send('streamable', { headers: { 'content-type': 'application/json', accept: 'text/event-stream' } });
    expect(response.statusCode).toBe(402);
    expect(response.headers['x-antseed-data-response']).toBe('provider');
    expect(new TextDecoder().decode(response.body)).toBe(contract);
    expect(harness.provider.handleRequestStream).not.toHaveBeenCalled();
  });

  it('decodes stacked encodings, and passes an encoding it cannot undo on with its header', async () => {
    const { gzipSync, brotliCompressSync } = await import('node:zlib');
    const json = '{"flights":[]}';
    const harness = setup();
    vi.mocked(harness.provider.handleRequest).mockImplementationOnce(async request => ({
      requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip, br' },
      body: new Uint8Array(brotliCompressSync(gzipSync(Buffer.from(json)))),
    }));
    const stacked = await harness.send('stacked');
    expect(new TextDecoder().decode(stacked.body)).toBe(json);
    expect(stacked.headers['content-encoding']).toBeUndefined();

    vi.mocked(harness.provider.handleRequest).mockImplementationOnce(async request => ({
      requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: new Uint8Array([1, 2, 3]),
    }));
    const unknown = await harness.send('zstd');
    expect(unknown.headers['content-encoding']).toBe('zstd');
    expect([...unknown.body]).toEqual([1, 2, 3]);
  });

  it('checks a data call against the reserve by its price, never by its body read as tokens', async () => {
    const harness = setup({ getReserveMax: () => 8_000n }, { reserveEstimateOverdraftUsdc: 0n });
    harness.provider.serviceApiProtocols = { flights: ['openai-chat-completions', 'openapi-data'] };
    harness.provider.pricing = { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 }, services: { flights: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } } };
    const body = new TextEncoder().encode(JSON.stringify({ from: 'TLV', max_tokens: 1_000_000, notes: 'x'.repeat(20_000) }));
    const response = await harness.send('big', { body });
    expect(response.statusCode).toBe(200);
    expect(harness.spm.recordSpend).toHaveBeenCalledWith('session-1', 5000n);
  });

  it('decodes a compressed data answer, since the encoding header is not forwarded', async () => {
    const harness = setup();
    const { gzipSync } = await import('node:zlib');
    vi.mocked(harness.provider.handleRequest).mockImplementation(async request => ({
      requestId: request.requestId, statusCode: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '999' },
      body: new Uint8Array(gzipSync(Buffer.from('{"flights":[{"id":"LY1"}]}'))),
    }));
    const response = await harness.send('gzip');
    expect(response.statusCode).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('{"flights":[{"id":"LY1"}]}');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['content-length']).toBeUndefined();
  });

  it('sends a chat request that names no provider to the chat provider, never to a data-only one', async () => {
    const harness = setup();
    const chat = makeProvider(0, 0, { name: 'chat-provider', services: ['flights'] });
    chat.serviceApiProtocols = { flights: ['openai-chat-completions'] };
    chat.handleRequest = vi.fn(async request => ({ requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"choices":[]}') }));
    delete (chat as Partial<Provider>).handleRequestStream;
    const mixed = setup({}, { providers: [harness.provider, chat] });
    const response = await mixed.send('chat', {
      path: '/v1/chat/completions',
      body: new TextEncoder().encode(JSON.stringify({ model: 'flights', messages: [{ role: 'user', content: 'TLV to LIS' }] })),
    });
    expect(response.statusCode).toBe(200);
    expect(chat.handleRequest).toHaveBeenCalledOnce();
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
  });

  it('serves the description and the operation from the provider the buyer names', async () => {
    const harness = setup();
    const second = makeProvider(10, 10, { name: 'openapi-b', services: ['flights'] });
    second.serviceApiProtocols = { flights: ['openapi-data'] };
    second.serviceUnitBillingModels = harness.provider.serviceUnitBillingModels;
    second.pricing = harness.provider.pricing;
    second.handleRequest = vi.fn(async request => ({ requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"from":"b"}') }));
    delete (second as Partial<Provider>).handleRequestStream;
    const named = setup({}, { providers: [harness.provider, second] });
    const headers = { 'content-type': 'application/json', 'x-antseed-provider': 'openapi-b' };
    expect((await named.send('describe-b', { method: 'GET', path: '/v1/data/flights/openapi.json', headers, body: new Uint8Array() })).statusCode).toBe(200);
    expect((await named.send('call-b', { headers })).statusCode).toBe(200);
    expect(vi.mocked(second.handleRequest).mock.calls.map(call => call[0].path)).toEqual(['/v1/data/flights/openapi.json', '/v1/data/flights/search?limit=5']);
    // The first provider of the same service answered neither.
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
  });

  it('refuses a request for a data service this seller does not offer before any payment step', async () => {
    const harness = setup();
    const response = await harness.send('other', { path: '/v1/data/hotels/search' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toMatchObject({ error: { code: 'model_not_found' } });
    expect(harness.provider.handleRequest).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
  });
});
