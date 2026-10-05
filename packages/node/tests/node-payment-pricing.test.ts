import { describe, expect, it, vi } from 'vitest';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { MessageType, PAYMENT_CODE_CHANNEL_EXHAUSTED } from '../src/types/protocol.js';
import { ANTSEED_ATTEST_PATH, type Prover, type SellerRequest } from '../src/interfaces/plugin.js';

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
    getReserveMax: () => 1_000_000n,
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
    ...overrides,
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
