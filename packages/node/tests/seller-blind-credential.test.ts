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

function spm(state: { session: boolean; accepted?: bigint; spent?: bigint }) {
  return {
    hasSession: vi.fn(() => state.session),
    getChannelByPeer: vi.fn(() => (state.session ? { sessionId: '0xchannel', authMax: '1000000' } : null)),
    getAcceptedCumulative: vi.fn(() => state.accepted ?? 0n),
    getCumulativeSpend: vi.fn(() => state.spent ?? 0n),
    getPaymentRequirements: vi.fn(() => ({ minBudgetPerRequest: '10000', suggestedAmount: '100000', requestId: 'r' })),
    recordSpend: vi.fn(),
  };
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
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
  const { mux } = handler.handleConnection(conn as any, BUYER, paymentMux, new VerificationMux(conn as any));
  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({
      requestId: 'req-1',
      method: options.method ?? 'POST',
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
  function admitWith(state: { session?: boolean; accepted: bigint; spent: bigint; reserveMax?: bigint; blocked?: boolean; catchUpTo?: bigint }, deps: Record<string, unknown> = {}) {
    const payments = {
      waitForPendingAuths: vi.fn(async () => {}),
      getChannelByPeer: vi.fn(() => (state.session === false ? null : { sessionId: '0xchannel' })),
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
    return (maxOutputTokens: number | null = 1000) => (handler as any)._admitKeyedRequest({
      buyerPeerId: BUYER, provider: makeProvider(), service: 'blind-model', inputTokens: 1000, maxOutputTokens,
    });
  }

  it('admits a paid-up buyer, waiting for a signature that is on its way', async () => {
    await expect(admitWith({ accepted: 100n, spent: 100n })()).resolves.toEqual({ admitted: true });
    await expect(admitWith({ accepted: 100n, spent: 500n, catchUpTo: 500n })()).resolves.toEqual({ admitted: true });
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
    await expect(admit(100)).resolves.toEqual({ admitted: true });
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
