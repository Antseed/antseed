import { describe, expect, it, vi } from 'vitest';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
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
  return {
    hasSession: () => true,
    getChannelByPeer: () => ({ sessionId: 'session-1', authMax: '1000000' }),
    recordSpend: vi.fn(),
    getCumulativeSpend: () => 0n,
    getAcceptedCumulative: () => 0n,
    getEffectiveReserveMax() {
      return this.getReserveMax();
    },
    isChannelBlocked: () => false,
    getPaymentRequirements: () => ({ minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
    waitForPendingAuths: async () => {},
    awaitAcceptedAtLeast: async () => false,
    settleSession: vi.fn(async () => {}),
    beginBillableRequest: vi.fn(),
    endBillableRequest: vi.fn(),
    hasInFlightRequests: () => false,
    hasClosingChannel: () => false,
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
    registerOneOffPlan: vi.fn((buyer: string, requestId: string, plan: unknown) => { plans.set(key(buyer, requestId), plan); }),
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
    identity: { peerId: 's'.repeat(40) } as any,
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

function makeAttestHarness() {
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
    makeConn(sentFrames),
    'b'.repeat(40),
    { sendNeedAuth: vi.fn(), sendPaymentRequired } as any,
  );
  return {
    provider,
    prove,
    sendPaymentRequired,
    sendAttest: (i = 0, body = new Uint8Array([1])) => mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: i + 1,
      payload: encodeHttpRequest({
        requestId: `req-attest-${i}`,
        method: 'POST',
        path: ATTEST_ROUTE,
        headers: {},
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
    const consume = vi.fn()
      .mockReturnValueOnce({ allowed: true, remaining: 0, retryAfterMs: 0, limitedBy: null, buyerAddress: `0x${'b'.repeat(40)}`, remoteIp: '203.0.113.7' })
      .mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 12_500, limitedBy: 'ip', buyerAddress: `0x${'b'.repeat(40)}`, remoteIp: '203.0.113.7' });
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: null,
      sellerFreeTierLimiter: { maxRequestsPerAddress: 1, maxRequestsPerIp: 3, windowMs: 60_000, consume } as any,
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
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
        }),
      });
    }

    expect(provider.handleRequest).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledWith({ buyerPeerId: 'b'.repeat(40), service: 'local-test', remoteIp: '203.0.113.7' });
    const responses = sentFrames.map((frame) => decodeHttpResponse(decodeFrame(frame)!.message.payload));
    expect(responses.map((response) => response.statusCode)).toEqual([200, 429]);
    expect(responses[1]!.headers['retry-after']).toBe('13');
    expect(JSON.parse(new TextDecoder().decode(responses[1]!.body))).toMatchObject({
      error: { code: 'free_tier_exhausted' },
      limitedBy: 'ip',
      limit: 3,
      windowMs: 60_000,
      retryAfterSeconds: 13,
    });
  });

  it('does not apply the free-tier allowance to paid requests', async () => {
    const provider = makeProvider(1, 1, { name: 'paid-tier', services: ['local-test'] });
    provider.handleRequest = vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ok: true })) }));
    const consume = vi.fn();
    const handler = makeSellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: makeSpmMock(),
      sellerFreeTierLimiter: { maxRequestsPerAddress: 1, windowMs: 60_000, consume } as any,
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
