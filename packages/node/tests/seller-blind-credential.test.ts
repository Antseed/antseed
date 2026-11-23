import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';
import { BLIND_RELAY_CREDENTIAL_PATH } from '@antseed/protocol/blind-relay';

const BUYER = '33'.repeat(20);

// The route serves only on a host with the sidecar installed. Minting never starts it, so any existing file stands in.
const SIDECAR_ENV = 'ANTSEED_KEYED_RELAY_BIN';
const sidecarBefore = process.env[SIDECAR_ENV];
beforeAll(() => { process.env[SIDECAR_ENV] = process.execPath; });
afterAll(() => {
  if (sidecarBefore === undefined) delete process.env[SIDECAR_ENV];
  else process.env[SIDECAR_ENV] = sidecarBefore;
});

function makeProvider(): Provider {
  return {
    name: 'test-provider',
    services: ['blind-model', 'plain-model'],
    serviceCategories: { 'blind-model': ['chat', 'seller-blind'], 'plain-model': ['chat'] },
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 1,
    handleRequest: vi.fn(),
    getCapacity: () => ({ current: 0, max: 1 }),
    keyedRelayTarget: () => ({
      host: 'api.example.com',
      port: 443,
      baseUrl: 'https://api.example.com/v1',
      path: '/v1/chat/completions',
      model: 'org/blind-model',
      headers: [['Authorization', 'Bearer sk-seller-secret']],
      request: { maxTokensField: 'max_tokens' },
    }),
  };
}

function spm(state: { session: boolean; accepted?: bigint; spent?: bigint; reserveMax?: bigint; closing?: 'closes' | 'stays'; topUpRunning?: boolean; prices?: Record<string, number> }) {
  return {
    hasSession: vi.fn(() => state.session),
    hasClosingChannel: vi.fn(() => state.closing !== undefined),
    waitForClosingChannel: vi.fn(async () => {
      if (state.closing !== 'closes') return false;
      state.session = false;
      return true;
    }),
    getEffectiveReserveMax: vi.fn(() => state.reserveMax ?? 0n),
    isChannelBlocked: vi.fn(() => false),
    isTopUpRunning: vi.fn(() => state.topUpRunning ?? false),
    isTopUpPendingFor: vi.fn(() => false),
    closeSessionWhenIdle: vi.fn(async () => {}),
    getChannelByPeer: vi.fn(() => (state.session ? { sessionId: '0xchannel', authMax: '1000000' } : null)),
    getAcceptedCumulative: vi.fn(() => state.accepted ?? 0n),
    getCumulativeSpend: vi.fn(() => state.spent ?? 0n),
    getPaymentRequirements: vi.fn(() => ({ minBudgetPerRequest: '10000', suggestedAmount: '100000', requestId: 'r', ...state.prices })),
    waitForPendingAuths: vi.fn(async () => {}),
    awaitAcceptedAtLeast: vi.fn(async () => (state.accepted ?? 0n) >= (state.spent ?? 0n)),
    recordSpend: vi.fn(),
  };
}

/** Asks `handler` for a credential as the buyer, on a connection of its own. */
async function mintOn(handler: SellerRequestHandler, model: string, method = 'POST') {
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
  const { mux } = handler.handleConnection(conn as any, BUYER, paymentMux, new VerificationMux(conn as any));
  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({
      requestId: 'req-1',
      method,
      path: BLIND_RELAY_CREDENTIAL_PATH,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model })),
    }),
  });
  const response = conn.send.mock.calls
    .map(([raw]) => decodeFrame(raw)!.message)
    .filter((message) => message.type === MessageType.HttpResponse)
    .map((frame) => decodeHttpResponse(frame.payload))[0]!;
  return { response, json: JSON.parse(new TextDecoder().decode(response.body)), paymentMux };
}

async function ask(model: string, options: { payments?: ReturnType<typeof spm> | null; method?: string } = {}) {
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [makeProvider()],
    sellerPaymentManager: (options.payments === undefined ? spm({ session: true }) : options.payments) as any,
    sessionTracker: null,
    channelsClient: options.payments === null ? null : ({} as any),
    announcer: null,
    emit: vi.fn(() => true),
  });
  return mintOn(handler, model, options.method);
}

describe('seller blind relay credential route', () => {
  it('mints for a buyer with a paid-up channel, and says the mint itself costs nothing', async () => {
    const { response, json } = await ask('blind-model');
    expect(response.statusCode).toBe(200);
    expect(json).toMatchObject({ upstream: { model: 'org/blind-model', path: '/v1/chat/completions' }, request: { maxTokensField: 'max_tokens' }, usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(json.credentialId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(json)).not.toContain('sk-seller-secret');
  });

  it('refuses a service that is not blind-relayed', async () => {
    const { response, json } = await ask('plain-model');
    expect(response.statusCode).toBe(404);
    expect(json.error.code).toBe('blind_relay_not_supported');
  });

  it('asks a buyer with no channel to open one', async () => {
    const { response, paymentMux } = await ask('blind-model', { payments: spm({ session: false }) });
    expect(response.statusCode).toBe(402);
    expect(paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();
  });

  it('refuses a buyer that has not signed for relayed requests yet', async () => {
    const { response, json } = await ask('blind-model', { payments: spm({ session: true, accepted: 100n, spent: 500n }) });
    expect(response.statusCode).toBe(409);
    expect(json.error.code).toBe('blind_relay_unpaid');
  });

  it('closes a channel whose relayed spend passed its reserve, and asks the buyer to open a new one', async () => {
    // Spend past the reserve cannot be signed for: "sign first" would leave the buyer stuck.
    const payments = spm({ session: true, accepted: 1000n, spent: 1200n, reserveMax: 1000n });
    const { response, json, paymentMux } = await ask('blind-model', { payments });
    expect(response.statusCode).toBe(402);
    expect(json).toMatchObject({ error: 'payment_required', code: 'channel_exhausted', channelId: '0xchannel', requiredCumulativeAmount: '1200', currentAcceptedCumulative: '1000', reserveMaxAmount: '1000' });
    expect(paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();
    expect(payments.closeSessionWhenIdle).toHaveBeenCalledOnce();

    // With a top-up on its way the channel is kept, and the buyer signs once it lands.
    const toppingUp = spm({ session: true, accepted: 1000n, spent: 1200n, reserveMax: 1000n, topUpRunning: true });
    const waiting = await ask('blind-model', { payments: toppingUp });
    expect(waiting.response.statusCode).toBe(409);
    expect(toppingUp.closeSessionWhenIdle).not.toHaveBeenCalled();
  });

  it('states the same terms in each 402: the amounts, and the prices only when the seller has them', async () => {
    const all = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 1.2, cachedInputUsdPerMillion: 0.06 };
    for (const prices of [undefined, { inputUsdPerMillion: 0.6, outputUsdPerMillion: 1.2 }, all]) {
      const terms = { error: 'payment_required', minBudgetPerRequest: '10000', suggestedAmount: '100000', ...prices };
      expect((await ask('blind-model', { payments: spm({ session: false, prices }) })).json).toEqual(terms);
      const exhausted = await ask('blind-model', { payments: spm({ session: true, accepted: 1000n, spent: 1200n, reserveMax: 1000n, prices }) });
      expect(exhausted.json).toEqual({
        ...terms, code: 'channel_exhausted', channelId: '0xchannel',
        requiredCumulativeAmount: '1200', currentSpent: '1200', currentAcceptedCumulative: '1000', reserveMaxAmount: '1000',
      });
    }
  });

  it('waits for a channel that is closing: a new channel once it closed, a short retry while it has not', async () => {
    const closed = await ask('blind-model', { payments: spm({ session: true, closing: 'closes' }) });
    expect(closed.response.statusCode).toBe(402);
    expect(closed.json).not.toHaveProperty('code');
    expect(closed.paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();

    const closing = await ask('blind-model', { payments: spm({ session: true, closing: 'stays' }) });
    expect(closing.response.statusCode).toBe(503);
    expect(closing.response.headers['retry-after']).toBe('2');
    expect(closing.json.error.code).toBe('channel_closing');
  });

  it('mints nothing on a seller that takes no payments', async () => {
    const { response } = await ask('blind-model', { payments: null });
    expect(response.statusCode).toBe(503);
  });

  it('serves nothing on a host without the sidecar', async () => {
    process.env[SIDECAR_ENV] = '/nonexistent/antseed-keyed-relay';
    try {
      const { response, json } = await ask('blind-model');
      expect(response.statusCode).toBe(404);
      expect(json.error.code).toBe('blind_relay_not_supported');
    } finally {
      process.env[SIDECAR_ENV] = process.execPath;
    }
  });
});

describe('keyed relay request admission', () => {
  interface ChannelState {
    session?: boolean; channel?: string; accepted: bigint; spent: bigint; reserveMax?: bigint; blocked?: boolean; catchUpTo?: bigint; closing?: boolean;
    /** A top-up is mining; `topUp` is what waiting for it does to the channel, and whether it landed. */
    topUpRunning?: boolean; topUp?: () => boolean;
  }

  function admitWith(state: ChannelState, deps: Record<string, unknown> = {}) {
    const payments = {
      hasClosingChannel: vi.fn(() => state.closing ?? false),
      waitForClosingChannel: vi.fn(async () => false),
      beginBillableRequest: vi.fn(),
      endBillableRequest: vi.fn(),
      waitForPendingAuths: vi.fn(async () => {}),
      hasSession: vi.fn(() => state.session !== false),
      getChannelByPeer: vi.fn(() => (state.session === false ? null : { sessionId: state.channel ?? '0xchannel', authMax: '1000000' })),
      getPaymentRequirements: vi.fn(() => ({ minBudgetPerRequest: '10000', suggestedAmount: '100000', requestId: 'r' })),
      closeSessionWhenIdle: vi.fn(async () => {}),
      isTopUpRunning: vi.fn(() => state.topUpRunning ?? false),
      isTopUpPendingFor: vi.fn(() => false),
      waitForTopUp: vi.fn(async () => state.topUp?.() ?? true),
      refreshReserveMaxFromChain: vi.fn(async () => state.reserveMax ?? 0n),
      getAcceptedCumulative: vi.fn(() => state.accepted),
      getCumulativeSpend: vi.fn(() => state.spent),
      getEffectiveReserveMax: vi.fn(() => state.reserveMax ?? 0n),
      isChannelBlocked: vi.fn(() => state.blocked ?? false),
      awaitAcceptedAtLeast: vi.fn(async () => {
        if (state.catchUpTo !== undefined) state.accepted = state.catchUpTo;
        return state.accepted >= state.spent;
      }),
    };
    const handler = new SellerRequestHandler({
      identity: identityFromPrivateKeyHex('11'.repeat(32)),
      providers: [makeProvider()],
      sellerPaymentManager: payments as any,
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: vi.fn(() => true),
      ...deps,
    } as any);
    const admit = (maxOutputTokens: number | null = 1000) => (handler as any)._admitKeyedRequest({
      buyerPeerId: BUYER, provider: makeProvider(), service: 'blind-model', inputTokens: 1000, maxOutputTokens,
    });
    return Object.assign(admit, { payments, mint: () => mintOn(handler, 'blind-model') });
  }

  /** An admission names the channel it checked and holds a billable request on it until `finish`. */
  const ADMITTED = { admitted: true, channelId: '0xchannel', finish: expect.any(Function) };

  it('admits a paid-up buyer, waiting for a signature that is on its way', async () => {
    await expect(admitWith({ accepted: 100n, spent: 100n })()).resolves.toEqual(ADMITTED);
    await expect(admitWith({ accepted: 100n, spent: 500n, catchUpTo: 500n })()).resolves.toEqual(ADMITTED);
  });

  it('mints for a buyer whose signature for the last answer is on its way, and refuses one whose signature does not come', async () => {
    const catchingUp = admitWith({ accepted: 100n, spent: 500n, catchUpTo: 500n });
    const minted = await catchingUp.mint();
    expect(minted.response.statusCode).toBe(200);
    expect(minted.json.credentialId).toMatch(/^[0-9a-f]{32}$/);
    expect(catchingUp.payments.waitForPendingAuths).toHaveBeenCalledWith(BUYER);
    expect(catchingUp.payments.awaitAcceptedAtLeast).toHaveBeenCalledWith('0xchannel', 500n, 5_000);

    // One bounded wait, then the refusal a buyer that owes gets.
    const unpaid = admitWith({ accepted: 100n, spent: 500n });
    const refused = await unpaid.mint();
    expect(refused.response.statusCode).toBe(409);
    expect(refused.json.error.code).toBe('blind_relay_unpaid');
    expect(unpaid.payments.awaitAcceptedAtLeast).toHaveBeenCalledOnce();
  });

  it('judges the channel as it is after the wait for a signature: closed, or replaced by a new one', async () => {
    const closed: ChannelState = { accepted: 100n, spent: 500n };
    const closing = admitWith(closed);
    closing.payments.awaitAcceptedAtLeast.mockImplementation(async () => { closed.session = false; return false; });
    const reopened = await closing.mint();
    expect(reopened.response.statusCode).toBe(402);
    expect(reopened.paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();

    const replaced: ChannelState = { accepted: 100n, spent: 500n };
    const replacing = admitWith(replaced);
    replacing.payments.awaitAcceptedAtLeast.mockImplementation(async () => { Object.assign(replaced, { channel: '0xnext', accepted: 0n, spent: 0n }); return false; });
    expect((await replacing.mint()).response.statusCode).toBe(200);
  });

  it('refuses no channel, unsigned spend, a blocked or exhausted channel', async () => {
    await expect(admitWith({ session: false, accepted: 0n, spent: 0n })()).resolves.toMatchObject({ admitted: false, reason: expect.stringContaining('no payment channel') });
    await expect(admitWith({ accepted: 100n, spent: 500n })()).resolves.toMatchObject({ admitted: false, reason: expect.stringContaining('sign for') });
    await expect(admitWith({ accepted: 0n, spent: 0n, blocked: true })()).resolves.toMatchObject({ admitted: false, reason: expect.stringContaining('blocked') });
    await expect(admitWith({ accepted: 1000n, spent: 1000n, reserveMax: 1000n })()).resolves.toMatchObject({ admitted: false, reason: expect.stringContaining('exhausted') });
  });

  it('refuses a request whose estimated cost exceeds the reserve left, with the overdraft set', async () => {
    // 1000 in + 1000 out at $1/M each = 2000 USDC base units.
    const admit = admitWith({ accepted: 0n, spent: 0n, reserveMax: 1500n }, { reserveEstimateOverdraftUsdc: 0n });
    await expect(admit(1000)).resolves.toMatchObject({ admitted: false, reason: expect.stringContaining('may cost 2000') });
    await expect(admit(100)).resolves.toEqual(ADMITTED);
  });

  it('closes a signed-up channel with too little reserve left for the request, and tells the buyer at its next mint to open a new one', async () => {
    const state: ChannelState = { accepted: 0n, spent: 0n, reserveMax: 1500n };
    const admit = admitWith(state, { reserveEstimateOverdraftUsdc: 0n });
    await expect(admit(1000)).resolves.toEqual({ admitted: false, reason: 'channel_exhausted: the request may cost 2000 USDC base units; the locked reserve has 1500 left' });
    expect(admit.payments.closeSessionWhenIdle).toHaveBeenCalledOnce();
    expect(admit.payments.closeSessionWhenIdle).toHaveBeenCalledWith(BUYER);
    expect(admit.payments.beginBillableRequest).not.toHaveBeenCalled();

    // The buyer mints again: the answer is the one a direct request gets on an exhausted channel.
    const refused = await admit.mint();
    expect(refused.response.statusCode).toBe(402);
    expect(refused.json).toMatchObject({ error: 'payment_required', code: 'channel_exhausted', channelId: '0xchannel', reserveMaxAmount: '1500', requiredCumulativeAmount: '0', minBudgetPerRequest: '10000', suggestedAmount: '100000' });
    expect(refused.paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();
    expect(refused.paymentMux.sendPaymentRequired).toHaveBeenCalledWith(expect.objectContaining({ code: 'channel_exhausted', channelId: '0xchannel', reserveMaxAmount: '1500' }));

    // On the channel that replaces it the buyer is served again.
    state.channel = '0xnew';
    state.reserveMax = 100_000n;
    expect((await admit.mint()).response.statusCode).toBe(200);
    await expect(admit(1000)).resolves.toEqual({ ...ADMITTED, channelId: '0xnew' });
  });

  it('closes an exhausted or a blocked channel the same way', async () => {
    for (const state of [{ accepted: 1000n, spent: 1000n, reserveMax: 1000n }, { accepted: 0n, spent: 0n, blocked: true }]) {
      const admit = admitWith(state);
      await expect(admit()).resolves.toMatchObject({ admitted: false, reason: expect.stringMatching(/^channel_exhausted: /) });
      expect(admit.payments.closeSessionWhenIdle).toHaveBeenCalledOnce();
      const { response, json } = await admit.mint();
      expect(response.statusCode).toBe(402);
      expect(json.code).toBe('channel_exhausted');
    }
  });

  it('closes a channel whose spend passed its reserve instead of asking for a signature it cannot get', async () => {
    const admit = admitWith({ accepted: 1000n, spent: 1200n, reserveMax: 1000n });
    await expect(admit()).resolves.toEqual({ admitted: false, reason: 'channel_exhausted: the payment channel is exhausted' });
    expect(admit.payments.awaitAcceptedAtLeast).not.toHaveBeenCalled();
    expect(admit.payments.closeSessionWhenIdle).toHaveBeenCalledOnce();
  });

  it('waits for a top-up that is mining instead of refusing a channel that is being extended', async () => {
    const state: ChannelState = { accepted: 1000n, spent: 1000n, reserveMax: 1000n, topUpRunning: true };
    state.topUp = () => {
      state.reserveMax = 5000n;
      state.topUpRunning = false;
      return true;
    };
    const admit = admitWith(state, { reserveEstimateOverdraftUsdc: 0n });
    await expect(admit(1000)).resolves.toEqual(ADMITTED);
    expect(admit.payments.waitForTopUp).toHaveBeenCalledOnce();
    expect(admit.payments.closeSessionWhenIdle).not.toHaveBeenCalled();
  });

  it('refuses for now, and closes nothing, while a top-up is still mining at the end of the wait', async () => {
    const admit = admitWith({ accepted: 1000n, spent: 1000n, reserveMax: 1000n, topUpRunning: true, topUp: () => false });
    await expect(admit()).resolves.toMatchObject({ admitted: false, reason: expect.stringMatching(/^top_up_pending: .*retry shortly/) });
    expect(admit.payments.closeSessionWhenIdle).not.toHaveBeenCalled();
    expect(admit.payments.beginBillableRequest).not.toHaveBeenCalled();
    // The channel stays in use: the buyer still mints on it.
    expect((await admit.mint()).response.statusCode).toBe(200);
  });

  it('keeps the channel from closing under an admitted request until the request is billed', async () => {
    const admit = admitWith({ accepted: 0n, spent: 0n });
    const decision = await admit();
    expect(admit.payments.beginBillableRequest).toHaveBeenCalledOnce();
    expect(admit.payments.beginBillableRequest).toHaveBeenCalledWith(BUYER);
    expect(admit.payments.endBillableRequest).not.toHaveBeenCalled();
    decision.finish(0);
    expect(admit.payments.endBillableRequest).toHaveBeenCalledOnce();
    expect(admit.payments.endBillableRequest).toHaveBeenCalledWith(BUYER);

    // A refused request holds nothing.
    const refused = admitWith({ accepted: 100n, spent: 500n });
    await refused();
    expect(refused.payments.beginBillableRequest).not.toHaveBeenCalled();
  });

  it('refuses a request while the channel is closing', async () => {
    const admit = admitWith({ accepted: 0n, spent: 0n, closing: true });
    await expect(admit()).resolves.toMatchObject({ admitted: false, reason: expect.stringContaining('closing') });
    expect(admit.payments.beginBillableRequest).not.toHaveBeenCalled();
  });

  it('holds the estimate against the buyer limits until the request is billed', async () => {
    const finish = vi.fn();
    const limiter = { admit: vi.fn(() => ({ admitted: true, reservation: { finish } })) };
    const decision = await admitWith({ accepted: 0n, spent: 0n }, { sellerBuyerLimiter: limiter })(null);
    expect(limiter.admit).toHaveBeenCalledWith(BUYER, 'test-provider', 1000 + 8192, 'blind-model');
    decision.finish(42);
    expect(finish).toHaveBeenCalledWith(42);
    const limited = { admit: vi.fn(() => ({ admitted: false, retryAfterSeconds: 30 })) };
    await expect(admitWith({ accepted: 0n, spent: 0n }, { sellerBuyerLimiter: limited })()).resolves.toMatchObject({ admitted: false, reason: expect.stringContaining('retry in 30 s') });
  });
});

describe('relayed request charge and metering', () => {
  const USAGE = { inputTokens: 120, freshInputTokens: 100, cachedInputTokens: 20, outputTokens: 30 };

  function relayHandler(state: { channel?: string | null; connectionsClosed?: boolean } = {}, sessionTracker: unknown = null) {
    const payments = {
      getChannelByPeer: vi.fn(() => (state.channel === null ? null : { sessionId: state.channel ?? '0xchannel', authMax: '1000000' })),
      recordSpend: vi.fn(),
      getCumulativeSpend: vi.fn(() => 700n),
      getAcceptedCumulative: vi.fn(() => 600n),
      get connectionsClosed() { return state.connectionsClosed ?? false; },
    };
    const handler = new SellerRequestHandler({
      identity: identityFromPrivateKeyHex('11'.repeat(32)),
      providers: [makeProvider()],
      sellerPaymentManager: payments as any,
      sessionTracker: sessionTracker as any,
      channelsClient: {} as any,
      announcer: null,
      emit: vi.fn(() => true),
    });
    const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() };
    handler.handleConnection(conn as any, BUYER, paymentMux as any, new VerificationMux(conn as any));
    const charge = (channelId?: string) => (handler as any)._chargeBlindRelay({
      buyerPeerId: BUYER, requestId: 'stream-1', service: 'blind-model', costUsdc: 100n, usage: USAGE, ...(channelId ? { channelId } : {}),
    });
    return { handler: handler as any, payments, paymentMux, charge };
  }

  it('charges the admitting channel and reports the usage it billed', () => {
    const { payments, paymentMux, charge } = relayHandler();
    charge('0xchannel');
    expect(payments.recordSpend).toHaveBeenCalledOnce();
    expect(payments.recordSpend).toHaveBeenCalledWith('0xchannel', 100n);
    expect(paymentMux.sendNeedAuth).toHaveBeenCalledOnce();
    expect(paymentMux.sendNeedAuth).toHaveBeenCalledWith({
      channelId: '0xchannel',
      requiredCumulativeAmount: '700',
      currentAcceptedCumulative: '600',
      deposit: '1000000',
      requestId: 'stream-1',
      lastRequestCost: '100',
      inputTokens: '120',
      outputTokens: '30',
      cachedInputTokens: '20',
      freshInputTokens: '100',
      service: 'blind-model',
    });
  });

  it('charges nothing to a channel that replaced the admitting one, or after the connections closed', () => {
    const replaced = relayHandler({ channel: '0xnew' });
    replaced.charge('0xchannel');
    expect(replaced.payments.recordSpend).not.toHaveBeenCalled();
    expect(replaced.paymentMux.sendNeedAuth).not.toHaveBeenCalled();

    const stopping = relayHandler({ connectionsClosed: true });
    stopping.charge('0xchannel');
    expect(stopping.payments.recordSpend).not.toHaveBeenCalled();
    expect(stopping.paymentMux.sendNeedAuth).not.toHaveBeenCalled();
  });

  it('meters a relayed request as it meters a direct one', async () => {
    const recordMetering = vi.fn(async () => {});
    const { handler } = relayHandler({}, { recordMetering });
    const provider = makeProvider();
    const record = {
      buyerPeerId: BUYER, requestId: 'stream-1', provider, service: 'blind-model', path: '/v1/chat/completions', stream: true,
      statusCode: 200 as number | null, usage: USAGE as typeof USAGE | null, estimated: false, costUsdc: 100n, bytesUp: 4000, bytesDown: 9000, latencyMs: 1500,
    };
    handler._recordBlindRelay(record);
    expect(recordMetering).toHaveBeenCalledOnce();
    expect(recordMetering).toHaveBeenCalledWith({
      buyerPeerId: BUYER,
      providerName: 'test-provider',
      pricing: provider.pricing.defaults,
      request: { requestId: 'stream-1', method: 'POST', path: '/v1/chat/completions', headers: { accept: 'text/event-stream' }, body: new Uint8Array(0) },
      statusCode: 200,
      latencyMs: 1500,
      inputBytes: 4000,
      outputBytes: 9000,
      responseBody: new Uint8Array(0),
      providerUsage: USAGE,
      service: 'blind-model',
    });

    // A failed answer keeps its status and counts no tokens; one that ended with no status shown says so.
    handler._recordBlindRelay({ ...record, stream: false, statusCode: 429, usage: null, costUsdc: 0n });
    expect(recordMetering.mock.calls[1]![0]).toMatchObject({ statusCode: 429, request: { headers: {} }, providerUsage: { inputTokens: 0, outputTokens: 0 } });
    expect(recordMetering.mock.calls[1]![0]).not.toHaveProperty('error');
    handler._recordBlindRelay({ ...record, statusCode: null, estimated: true });
    expect(recordMetering.mock.calls[2]![0]).toMatchObject({ statusCode: 0, providerUsage: USAGE, error: expect.stringContaining('no status') });
    handler._recordBlindRelay({ ...record, statusCode: null, usage: null, costUsdc: 0n });
    expect(recordMetering.mock.calls[3]![0]).toMatchObject({ statusCode: 0, error: expect.stringContaining('before an answer') });
  });
});
