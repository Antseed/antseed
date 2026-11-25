import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpResponse } from '../src/types/http.js';
import { VerificationMux } from '../src/verification/index.js';

const BUYER = '33'.repeat(20);

// Relayed requests are admitted only on a host with the sidecar installed. Admission never starts it, so any existing file stands in.
const SIDECAR_ENV = 'ANTSEED_KEYED_RELAY_BIN';
const sidecarBefore = process.env[SIDECAR_ENV];
beforeAll(() => { process.env[SIDECAR_ENV] = process.execPath; });
afterAll(() => {
  if (sidecarBefore === undefined) delete process.env[SIDECAR_ENV];
  else process.env[SIDECAR_ENV] = sidecarBefore;
});

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/**
 * A provider that keeps its limit as the shared provider base does: a request
 * over it is answered 429, and a request counts until it ends. Its requests
 * stay in flight until `release`. Priced at nothing, so a direct request needs
 * no payment step.
 */
function makeProvider(max: number) {
  let active = 0;
  const inFlight: Array<() => void> = [];
  const provider: Provider = {
    name: 'test-provider',
    services: ['blind-model'],
    serviceCategories: { 'blind-model': ['chat', 'seller-blind'] },
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: max,
    handleRequest: vi.fn(async (req): Promise<SerializedHttpResponse> => {
      const headers = { 'content-type': 'application/json' };
      if (active >= max) return { requestId: req.requestId, statusCode: 429, headers, body: json({ error: 'Max concurrency reached' }) };
      active += 1;
      try {
        await new Promise<void>((resolve) => inFlight.push(resolve));
        return { requestId: req.requestId, statusCode: 200, headers, body: json({ ok: true }) };
      } finally {
        active -= 1;
      }
    }),
    getCapacity: () => ({ current: active, max }),
    keyedRelayTarget: () => ({
      host: 'api.example.com',
      port: 443,
      baseUrl: 'https://api.example.com/v1',
      path: '/v1/chat/completions',
      model: 'org/blind-model',
      headers: [['Authorization', 'Bearer sk-testbench-not-a-real-key']],
      request: { maxTokensField: 'max_tokens' },
    }),
  };
  return { provider, release: (): void => inFlight.shift()?.() };
}

function makeSeller(max: number, deps: Record<string, unknown> = {}) {
  const upstream = makeProvider(max);
  const payments = {
    hasClosingChannel: vi.fn(() => false),
    waitForClosingChannel: vi.fn(async () => false),
    beginBillableRequest: vi.fn(),
    endBillableRequest: vi.fn(),
    waitForPendingAuths: vi.fn(async () => {}),
    hasSession: vi.fn(() => true),
    getChannelByPeer: vi.fn(() => ({ sessionId: '0xchannel', authMax: '1000000' })),
    isTopUpRunning: vi.fn(() => false),
    isTopUpPendingFor: vi.fn(() => false),
    getAcceptedCumulative: vi.fn(() => 0n),
    getCumulativeSpend: vi.fn(() => 0n),
    getEffectiveReserveMax: vi.fn(() => 0n),
    isChannelBlocked: vi.fn(() => false),
    awaitAcceptedAtLeast: vi.fn(async () => true),
  };
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [upstream.provider],
    sellerPaymentManager: payments as any,
    sessionTracker: null,
    channelsClient: {} as any,
    announcer: null,
    emit: vi.fn(() => true),
    ...deps,
  } as any);
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const { mux } = handler.handleConnection(conn as any, BUYER, { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any, new VerificationMux(conn as any));
  let messageId = 0;
  return {
    ...upstream,
    handler,
    payments,
    /** Asks for a relayed request to be forwarded, as the relay does once the request passed its check. */
    relay: () => (handler as any)._admitKeyedRequest({
      buyerPeerId: BUYER, provider: upstream.provider, service: 'blind-model', inputTokens: 1000, maxOutputTokens: 1000,
    }),
    /** Sends a request the seller answers itself; resolves with the seller's answer. */
    direct: async (requestId: string) => {
      messageId += 1;
      await mux.handleFrame({
        type: MessageType.HttpRequest,
        messageId,
        payload: encodeHttpRequest({
          requestId, method: 'POST', path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: json({ model: 'blind-model' }),
        }),
      });
      const response = conn.send.mock.calls
        .map(([raw]) => decodeFrame(raw)!.message)
        .filter((message) => message.type === MessageType.HttpResponse)
        .map((frame) => decodeHttpResponse(frame.payload))
        .find((answer) => answer.requestId === requestId)!;
      return { statusCode: response.statusCode, headers: response.headers, body: JSON.parse(new TextDecoder().decode(response.body)) };
    },
  };
}

const ADMITTED = { admitted: true, channelId: '0xchannel', finish: expect.any(Function) };
const BUSY = { admitted: false, reason: expect.stringContaining('as many requests as it takes at once') };

describe('provider concurrency with relayed requests', () => {
  it('admits relayed requests that arrive together only up to the provider limit, and the next one once a slot is released', async () => {
    const seller = makeSeller(2);
    const decisions = await Promise.all([seller.relay(), seller.relay(), seller.relay()]);
    expect(decisions.filter((decision) => decision.admitted)).toEqual([ADMITTED, ADMITTED]);
    expect(decisions.filter((decision) => !decision.admitted)).toEqual([BUSY]);
    // The refused request holds nothing: no channel kept open for it.
    expect(seller.payments.beginBillableRequest).toHaveBeenCalledTimes(2);

    await expect(seller.relay()).resolves.toEqual(BUSY);
    decisions.find((decision) => decision.admitted).finish(0);
    await expect(seller.relay()).resolves.toEqual(ADMITTED);
    await expect(seller.relay()).resolves.toEqual(BUSY);
  });

  it('answers a direct request as busy while a relayed request holds the only slot, as when a direct request holds it', async () => {
    const seller = makeSeller(1);
    // What a direct request over the limit gets today: the provider's own answer.
    const first = seller.direct('direct-1');
    await vi.waitFor(() => expect(seller.provider.handleRequest).toHaveBeenCalledTimes(1));
    const overDirect = await seller.direct('direct-2');
    expect(overDirect.statusCode).toBe(429);
    seller.release();
    expect((await first).statusCode).toBe(200);
    expect(seller.provider.handleRequest).toHaveBeenCalledTimes(2);

    const relayed = await seller.relay();
    expect(relayed).toEqual(ADMITTED);
    const third = seller.direct('direct-3');
    // The provider is not asked: it would serve the request past its limit.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seller.provider.handleRequest).toHaveBeenCalledTimes(2);
    expect(await third).toEqual(overDirect);

    relayed.finish(0);
    const next = seller.direct('direct-4');
    await vi.waitFor(() => expect(seller.provider.handleRequest).toHaveBeenCalledTimes(3));
    seller.release();
    expect((await next).statusCode).toBe(200);
  });

  it('refuses a relayed request while a direct request holds the only slot', async () => {
    const seller = makeSeller(1);
    const first = seller.direct('direct-1');
    await vi.waitFor(() => expect(seller.provider.handleRequest).toHaveBeenCalledTimes(1));
    await expect(seller.relay()).resolves.toEqual(BUSY);
    expect(seller.payments.beginBillableRequest).not.toHaveBeenCalled();

    seller.release();
    expect((await first).statusCode).toBe(200);
    await expect(seller.relay()).resolves.toEqual(ADMITTED);
  });

  it('holds no buyer usage for a relayed request it refuses as busy', async () => {
    const limiter = { admit: vi.fn(() => ({ admitted: true, reservation: { finish: vi.fn() } })) };
    const seller = makeSeller(1, { sellerBuyerLimiter: limiter });
    await expect(seller.relay()).resolves.toEqual(ADMITTED);
    await expect(seller.relay()).resolves.toEqual(BUSY);
    expect(limiter.admit).toHaveBeenCalledTimes(1);
  });

  it('advertises relayed requests in flight as load', async () => {
    const updateLoad = vi.fn();
    const seller = makeSeller(2, { announcer: { updateLoad, refreshMetadata: vi.fn(async () => {}) } });
    try {
      const first = await seller.relay();
      expect(updateLoad).toHaveBeenLastCalledWith('test-provider', 1);
      const second = await seller.relay();
      expect(updateLoad).toHaveBeenLastCalledWith('test-provider', 2);
      // A refused request adds none.
      await expect(seller.relay()).resolves.toEqual(BUSY);
      expect(updateLoad).toHaveBeenCalledTimes(2);
      first.finish(0);
      expect(updateLoad).toHaveBeenLastCalledWith('test-provider', 1);
      second.finish(0);
      expect(updateLoad).toHaveBeenLastCalledWith('test-provider', 0);
    } finally {
      seller.handler.clearMetadataRefreshTimer();
    }
  });
});
