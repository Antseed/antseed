import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { SellerBuyerLimiter } from '../src/payments/seller-buyer-limiter.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-11-05T10:00:00Z');

function clock(at = START) {
  const state = { now: at };
  return { now: () => state.now, advance: (ms: number) => { state.now += ms; } };
}

/** Admits a request and finishes it at once with the tokens it used. */
function use(limiter: SellerBuyerLimiter, buyer: string, provider: string, tokens: number): void {
  const admission = limiter.admit(buyer, provider, 0);
  if (!admission.admitted) throw new Error(`${buyer} was not admitted`);
  admission.reservation.finish(tokens);
}

describe('SellerBuyerLimiter', () => {
  it('lets a buyer use up to its limit in the window, then names when to retry', () => {
    const time = clock();
    const limiter = new SellerBuyerLimiter({ windowMinutes: 60, maxTokensPerBuyer: 1_000 }, () => null, time.now);
    use(limiter, 'a', 'codex', 600);
    expect(limiter.retryAfterSeconds('a', 'codex')).toBeNull();
    time.advance(10 * 60_000);
    use(limiter, 'a', 'codex', 500);
    // The first 600 tokens were counted in the minute starting at START: they stay a full window after it ends.
    expect(limiter.retryAfterSeconds('a', 'codex')).toBe(51 * 60);
    time.advance(51 * 60_000);
    expect(limiter.retryAfterSeconds('a', 'codex')).toBeNull();
  });

  it('never forgets usage before a full window has passed, also mid-minute and for short windows', () => {
    const time = clock(START + 45_000);
    const limiter = new SellerBuyerLimiter({ windowMinutes: 0.5, maxTokensPerBuyer: 1_000 }, () => null, time.now);
    use(limiter, 'a', 'codex', 1_000);
    expect(limiter.retryAfterSeconds('a', 'codex')).not.toBeNull();
    time.advance(29_000);
    expect(limiter.retryAfterSeconds('a', 'codex')).not.toBeNull();
  });

  it('counts each buyer and each provider on its own', () => {
    const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer: 1_000 }, () => null, clock().now);
    use(limiter, 'a', 'codex', 1_000);
    expect(limiter.retryAfterSeconds('a', 'codex')).not.toBeNull();
    expect(limiter.retryAfterSeconds('b', 'codex')).toBeNull();
    expect(limiter.retryAfterSeconds('a', 'claude')).toBeNull();
  });

  it('lets a request larger than the limit through alone', () => {
    const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer: 1_000 }, () => null, clock().now);
    expect(limiter.admit('a', 'codex', 5_000).admitted).toBe(true);
    expect(limiter.admit('a', 'codex', 10).admitted).toBe(false);
  });

  it('counts requests still in flight, so a burst cannot pass on the same usage', () => {
    const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer: 1_000, newBuyers: { maxTokensTotal: 1_200 } }, () => null, clock().now);
    const first = limiter.admit('a', 'codex', 600);
    expect(first.admitted).toBe(true);
    // A request must fit beside the ones in flight: 600 more would pass the limit, 400 fits.
    expect(limiter.admit('a', 'codex', 600).admitted).toBe(false);
    expect(limiter.admit('a', 'codex', 400).admitted).toBe(true);
    // 1,000 tokens are now reserved for 'a': its next request waits for one to finish.
    const held = limiter.admit('a', 'codex', 10);
    expect(held).toEqual({ admitted: false, retryAfterSeconds: 5 });
    // The shared new-buyer total counts the same reservations.
    expect(limiter.admit('b', 'codex', 400).admitted).toBe(false);
    // A finished request counts what it used, not what was reserved.
    if (first.admitted) first.reservation.finish(100);
    expect(limiter.admit('a', 'codex', 10).admitted).toBe(true);
  });

  it('holds buyers new to the seller to their own tighter limit', () => {
    const time = clock();
    const firstChannel = new Map([['old', START - 30 * 24 * HOUR], ['recent', START - HOUR]]);
    const limiter = new SellerBuyerLimiter(
      { maxTokensPerBuyer: 10_000, newBuyers: { forHours: 72, maxTokensPerBuyer: 1_000 } },
      (buyer) => firstChannel.get(buyer) ?? null,
      time.now,
    );
    for (const buyer of ['old', 'recent', 'unknown']) use(limiter, buyer, 'codex', 2_000);
    expect(limiter.retryAfterSeconds('old', 'codex')).toBeNull();
    expect(limiter.retryAfterSeconds('recent', 'codex')).not.toBeNull();
    expect(limiter.retryAfterSeconds('unknown', 'codex')).not.toBeNull();
  });

  it('shares one total between all new buyers, so more wallets do not buy more', () => {
    const limiter = new SellerBuyerLimiter(
      { newBuyers: { maxTokensPerBuyer: 1_000, maxTokensTotal: 2_500 } },
      (buyer) => (buyer === 'regular' ? START - 365 * 24 * HOUR : null),
      clock().now,
    );
    for (const buyer of ['w1', 'w2', 'w3']) {
      expect(limiter.retryAfterSeconds(buyer, 'codex')).toBeNull();
      use(limiter, buyer, 'codex', 900);
    }
    expect(limiter.retryAfterSeconds('w4', 'codex')).not.toBeNull();
    expect(limiter.retryAfterSeconds('regular', 'codex')).toBeNull();
  });

  it('counts a weighted service\'s tokens that many times, matching its id in any letter case', () => {
    const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer: 1_000, serviceWeights: { 'Heavy-Model': 10 } }, () => null, clock().now);
    const heavy = limiter.admit('a', 'codex', 0, 'heavy-model');
    if (!heavy.admitted) throw new Error('not admitted');
    heavy.reservation.finish(100);
    expect(limiter.retryAfterSeconds('a', 'codex')).not.toBeNull();
    // The same tokens on an unweighted service leave room.
    use(limiter, 'b', 'codex', 100);
    expect(limiter.retryAfterSeconds('b', 'codex')).toBeNull();
    // A weighted request's estimate is weighted too: 60 × 10 no longer fits beside 500 used.
    use(limiter, 'c', 'codex', 500);
    expect(limiter.admit('c', 'codex', 60, 'heavy-model').admitted).toBe(false);
    expect(limiter.admit('c', 'codex', 60, 'light-model').admitted).toBe(true);
  });

  it('stops counting a buyer as new once its first channel is old enough', () => {
    const time = clock();
    const limiter = new SellerBuyerLimiter(
      { newBuyers: { forHours: 1, maxTokensPerBuyer: 1_000 } },
      () => START,
      time.now,
    );
    use(limiter, 'a', 'codex', 5_000);
    expect(limiter.retryAfterSeconds('a', 'codex')).not.toBeNull();
    time.advance(HOUR);
    expect(limiter.retryAfterSeconds('a', 'codex')).toBeNull();
  });

  it('keeps the shared new-buyer total working after a request with an overflowing weighted estimate', () => {
    const limiter = new SellerBuyerLimiter(
      { newBuyers: { maxTokensTotal: 1_000 }, serviceWeights: { 'heavy-model': 10 } },
      () => null,
      clock().now,
    );
    const huge = limiter.admit('a', 'codex', 1e308, 'heavy-model');
    if (!huge.admitted) throw new Error('a lone request should be admitted');
    huge.reservation.finish(0);
    expect(limiter.admit('b', 'codex', 10).admitted).toBe(true);
  });
});

describe('seller buyer limits', () => {
  function provider(): Provider {
    return {
      name: 'codex',
      services: ['test-model'],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      maxConcurrency: 1,
      handleRequest: vi.fn(async (req) => ({
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ ok: true, usage: { prompt_tokens: 800, completion_tokens: 300 } })),
      })),
      getCapacity: () => ({ current: 0, max: 1 }),
    };
  }

  function connect(handlerProvider: Provider, limiter: SellerBuyerLimiter) {
    const handler = new SellerRequestHandler({
      identity: identityFromPrivateKeyHex('11'.repeat(32)),
      providers: [handlerProvider],
      sellerPaymentManager: null,
      sellerBuyerLimiter: limiter,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });
    const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
    const { mux } = handler.handleConnection(conn as any, '22'.repeat(20), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any, new VerificationMux(conn as any));
    return { mux, conn };
  }

  async function serve(handlerProvider: Provider, limiter: SellerBuyerLimiter, requestId: string) {
    const { mux, conn } = connect(handlerProvider, limiter);
    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId, method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'test-model' })),
      }),
    });
    const frame = conn.send.mock.calls.map(([raw]) => decodeFrame(raw)!.message).find((message) => message.type === MessageType.HttpResponse)!;
    return decodeHttpResponse(frame.payload);
  }

  it.each([
    { name: 'holds a concurrent burst on a free model to the limit while the first request is still running', maxTokensPerBuyer: 1_000, outputFields: { max_tokens: 600 } },
    { name: 'reserves output for a request that sets no maximum, so parallel long answers are held too', maxTokensPerBuyer: 10_000, outputFields: {} },
  ])('$name', async ({ maxTokensPerBuyer, outputFields }) => {
    const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer }, () => null);
    const upstream = provider();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    upstream.handleRequest = vi.fn(async (req) => {
      await held;
      return { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"ok":true}') };
    });
    const { mux, conn } = connect(upstream, limiter);
    // Each request reserves its output maximum (or the default): the second no longer fits beside the first.
    const send = (requestId: string) => mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId, method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'test-model', ...outputFields })),
      }),
    });
    const burst = Promise.all(['b1', 'b2', 'b3'].map(send));
    await vi.waitFor(() => expect(upstream.handleRequest).toHaveBeenCalledTimes(1));
    release();
    await burst;
    const statuses = conn.send.mock.calls.map(([raw]) => decodeFrame(raw)!.message)
      .filter((message) => message.type === MessageType.HttpResponse)
      .map((message) => decodeHttpResponse(message.payload).statusCode);
    expect(statuses.sort()).toEqual([200, 429, 429]);
    expect(upstream.handleRequest).toHaveBeenCalledTimes(1);
  });

  it('counts a served answer without a usage report as its estimate', async () => {
    const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer: 20_000 }, () => null);
    const upstream = provider();
    upstream.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"ok":true}'),
    }));
    // No usage comes back, so each answer counts as its estimate (a few input tokens plus the 8,192-token
    // default output reservation): two fill most of the 20,000 tokens and a third no longer fits.
    const statuses = [];
    for (const id of ['n1', 'n2', 'n3']) statuses.push((await serve(upstream, limiter, id)).statusCode);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('counts served tokens and answers 429 with retry-after before reaching the provider', async () => {
    const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer: 1_000 }, () => null);
    const upstream = provider();
    expect((await serve(upstream, limiter, 'r1')).statusCode).toBe(200);
    const limited = await serve(upstream, limiter, 'r2');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(new TextDecoder().decode(limited.body)).error.code).toBe('buyer_usage_limited');
    expect(upstream.handleRequest).toHaveBeenCalledTimes(1);
  });
});
