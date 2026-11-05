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

describe('SellerBuyerLimiter', () => {
  it('lets a buyer use up to its limit in the window, then names when to retry', () => {
    const time = clock();
    const limiter = new SellerBuyerLimiter({ windowMinutes: 60, maxTokensPerBuyer: 1_000 }, () => null, time.now);
    limiter.record('a', 'codex', 600);
    expect(limiter.retryAfterSeconds('a', 'codex')).toBeNull();
    time.advance(10 * 60_000);
    limiter.record('a', 'codex', 500);
    // Over the limit until the first 600 tokens leave the window, 50 minutes on.
    expect(limiter.retryAfterSeconds('a', 'codex')).toBe(50 * 60);
    time.advance(50 * 60_000);
    expect(limiter.retryAfterSeconds('a', 'codex')).toBeNull();
  });

  it('counts each buyer and each provider on its own', () => {
    const limiter = new SellerBuyerLimiter({ maxTokensPerBuyer: 1_000 }, () => null, clock().now);
    limiter.record('a', 'codex', 1_000);
    expect(limiter.retryAfterSeconds('a', 'codex')).not.toBeNull();
    expect(limiter.retryAfterSeconds('b', 'codex')).toBeNull();
    expect(limiter.retryAfterSeconds('a', 'claude')).toBeNull();
  });

  it('holds buyers new to the seller to their own tighter limit', () => {
    const time = clock();
    const firstChannel = new Map([['old', START - 30 * 24 * HOUR], ['recent', START - HOUR]]);
    const limiter = new SellerBuyerLimiter(
      { maxTokensPerBuyer: 10_000, newBuyers: { forHours: 72, maxTokensPerBuyer: 1_000 } },
      (buyer) => firstChannel.get(buyer) ?? null,
      time.now,
    );
    for (const buyer of ['old', 'recent', 'unknown']) limiter.record(buyer, 'codex', 2_000);
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
      limiter.record(buyer, 'codex', 900);
    }
    expect(limiter.retryAfterSeconds('w4', 'codex')).not.toBeNull();
    expect(limiter.retryAfterSeconds('regular', 'codex')).toBeNull();
  });

  it('stops counting a buyer as new once its first channel is old enough', () => {
    const time = clock();
    const limiter = new SellerBuyerLimiter(
      { newBuyers: { forHours: 1, maxTokensPerBuyer: 1_000 } },
      () => START,
      time.now,
    );
    limiter.record('a', 'codex', 5_000);
    expect(limiter.retryAfterSeconds('a', 'codex')).not.toBeNull();
    time.advance(HOUR);
    expect(limiter.retryAfterSeconds('a', 'codex')).toBeNull();
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

  async function serve(handlerProvider: Provider, limiter: SellerBuyerLimiter, requestId: string) {
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
