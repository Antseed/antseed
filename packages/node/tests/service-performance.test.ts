import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';
import { ServicePerformanceTracker } from '../src/health/service-performance.js';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { mergeProviderAnnouncements, type PeerMetadata, type ProviderAnnouncement } from '../src/discovery/peer-metadata.js';
import { buildNetworkServiceOffers } from '../src/discovery/service-catalog.js';
import { MIN_REPORTED_REQUESTS, SELLER_SUCCESS_PRIOR, SellerHealthBook, orderAdaptiveRoutes, scoreAdaptiveRoute } from '../src/routing/seller-health.js';

const NOW = 1_800_000_000_000;

describe('ServicePerformanceTracker', () => {
  it('reports requests, success rate, first-token percentiles and speed over the last hour', () => {
    const tracker = new ServicePerformanceTracker();
    for (let i = 1; i <= 10; i += 1) {
      tracker.record('openai', 'm1', { ok: true, firstTokenMs: i * 100, streamMs: 2_000, outputTokens: 100 }, NOW - i * 1_000);
    }
    tracker.record('openai', 'm1', { ok: false }, NOW);
    tracker.record('openai', 'm1', { ok: true }, NOW - 2 * 60 * 60_000);

    expect(tracker.performance('openai', 'm1', NOW)).toEqual({
      requests: 11,
      successRate: 0.9091,
      firstTokenMsP50: 500,
      firstTokenMsP90: 900,
      tokensPerSecondP50: 50,
    });
  });

  it('leaves out speed it cannot judge: unstreamed answers, short answers and failures', () => {
    const tracker = new ServicePerformanceTracker();
    tracker.record('openai', 'm1', { ok: true, outputTokens: 500 }, NOW);
    tracker.record('openai', 'm1', { ok: true, firstTokenMs: 300, streamMs: 100, outputTokens: 5 }, NOW);
    tracker.record('openai', 'm1', { ok: false, firstTokenMs: 9_000, streamMs: 100, outputTokens: 500 }, NOW);

    expect(tracker.performance('openai', 'm1', NOW)).toEqual({ requests: 3, successRate: 0.6667, firstTokenMsP50: 300, firstTokenMsP90: 300 });
  });

  it('announces only listed services with traffic in the window, and forgets idle ones', () => {
    const tracker = new ServicePerformanceTracker();
    tracker.record('openai', 'm1', { ok: true }, NOW);
    tracker.record('openai', 'old', { ok: true }, NOW - 2 * 60 * 60_000);
    tracker.record('anthropic', 'm2', { ok: true }, NOW);

    expect(tracker.snapshot('openai', ['m1', 'm2', 'old'], NOW)).toEqual({ m1: { requests: 1, successRate: 1 } });
    expect(tracker.snapshot('openai', ['old'], NOW)).toBeUndefined();
  });
});

function metadata(version: number, servicePerformance?: ProviderAnnouncement['servicePerformance']): PeerMetadata {
  return {
    peerId: 'ab'.repeat(20) as PeerMetadata['peerId'],
    version,
    region: 'eu',
    timestamp: NOW,
    providers: [{
      provider: 'openai',
      services: ['m1', 'm2'],
      defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      serviceHealth: { m1: { status: 'healthy', checkedAt: NOW, source: 'traffic' } },
      ...(servicePerformance ? { servicePerformance } : {}),
      maxConcurrency: 4,
      currentLoad: 0,
    }],
    signature: 'ab'.repeat(65),
  };
}

describe('metadata v14 servicePerformance', () => {
  const performance = {
    m1: { requests: 312, successRate: 0.9712, firstTokenMsP50: 420, firstTokenMsP90: 1_250, tokensPerSecondP50: 78 },
    m2: { requests: 3, successRate: 1 },
  };

  it('round-trips through the signed bytes', () => {
    const latest = metadata(14, performance);
    const decoded = decodeMetadata(encodeMetadata(latest));
    expect(decoded.providers[0]!.servicePerformance).toEqual(performance);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(latest));
    expect(validateMetadata(decoded)).toEqual([]);
  });

  it('is left out of the v13 and v12 documents served to older buyers', () => {
    const latest = metadata(14, performance);
    for (const version of [13, 12]) {
      const older = getMetadataCodec(version).fromLatest(latest);
      expect(older.version).toBe(version);
      expect(older.providers[0]!.servicePerformance).toBeUndefined();
      expect(decodeMetadata(encodeMetadata(older)).providers[0]!.servicePerformance).toBeUndefined();
    }
  });

  it('is rejected on older versions, for unlisted services and with out-of-range figures', () => {
    expect(validateMetadata(metadata(13, performance)).map((error) => error.message)).toContain('Service performance requires metadata version 14');
    const unlisted = validateMetadata(metadata(14, { m9: { requests: 1, successRate: 1 } }));
    expect(unlisted.map((error) => error.message)).toContain('Service performance must reference a service listed in providers[].services');
    for (const bad of [{ requests: 1, successRate: 1.5 }, { requests: -1, successRate: 1 }, { requests: 1, successRate: 1, tokensPerSecondP50: 70_000 }]) {
      expect(validateMetadata(metadata(14, { m1: bad })).some((error) => error.field === 'providers[0].servicePerformance.m1')).toBe(true);
    }
  });

  it('reaches buyers through the merged matrices and the service catalog', () => {
    const { providerPricing, providerServicePerformance } = mergeProviderAnnouncements(metadata(14, performance).providers);
    expect(providerServicePerformance['openai']?.services['m1']).toEqual(performance.m1);
    const offers = buildNetworkServiceOffers([{ peerId: 'ab'.repeat(20), providers: ['openai'], providerPricing, providerServicePerformance }]);
    expect(offers.find((offer) => offer.serviceId === 'm1')?.performance).toEqual(performance.m1);
  });
});

describe('routing with seller-reported performance', () => {
  const shape = { inputTokens: 1_000, outputTokens: 500 };
  const network = { firstTokenMs: 4_000, tokensPerSecond: 50 };
  const base = { peerId: 'a'.repeat(40), serviceId: 'm1', inputUsdPerMillion: 1, outputUsdPerMillion: 2, coolingDown: false };

  it('starts from the reported success rate and speed when the buyer has no record', () => {
    const score = scoreAdaptiveRoute({ ...base, reported: { requests: 300, successRate: 0.3, firstTokenMsP50: 500, tokensPerSecondP50: 100 } }, null, shape, network, NOW);
    expect(score.successProbability).toBeCloseTo(0.3);
    expect(score.unhealthy).toBe(true);
    expect(score.expectedSeconds).toBeCloseTo(0.5 + 500 / 100);
  });

  it('caps a reported rate (sellers grade themselves) and ignores one from too few requests', () => {
    expect(scoreAdaptiveRoute({ ...base, reported: { requests: 300, successRate: 1 } }, null, shape, network, NOW).successProbability).toBeCloseTo(0.95);
    expect(scoreAdaptiveRoute({ ...base, reported: { requests: MIN_REPORTED_REQUESTS - 1, successRate: 0.1 } }, null, shape, network, NOW).successProbability)
      .toBeCloseTo(SELLER_SUCCESS_PRIOR);
  });

  it('lets the buyer\'s own record take over', () => {
    const book = new SellerHealthBook();
    for (let i = 0; i < 20; i += 1) book.recordSuccess(base.peerId, 'm1', NOW, { firstTokenMs: 2_000, streamed: true });
    const stats = book.stats(base.peerId, 'm1', NOW);
    const score = scoreAdaptiveRoute({ ...base, reported: { requests: 300, successRate: 0.3, firstTokenMsP50: 100 } }, stats, shape, network, NOW);
    expect(score.successProbability).toBeGreaterThan(0.9);
    expect(score.expectedSeconds).toBeCloseTo(2 + 500 / 50);
  });

  it('tries a seller reporting failures after one reporting success, at the same price', () => {
    const struggling = { ...base, peerId: 'b'.repeat(40), reported: { requests: 200, successRate: 0.4 } };
    const steady = { ...base, peerId: 'c'.repeat(40), reported: { requests: 200, successRate: 0.99 } };
    const { ordered } = orderAdaptiveRoutes([struggling, steady], (candidate) => candidate, new SellerHealthBook(), shape, { now: NOW, random: () => 0, explorationRate: 0 });
    expect(ordered.map((candidate) => candidate.peerId)).toEqual([steady.peerId, struggling.peerId]);
  });
});

describe('seller request handler', () => {
  async function serve(provider: Provider, tracker: ServicePerformanceTracker) {
    const handler = new SellerRequestHandler({
      identity: identityFromPrivateKeyHex('11'.repeat(32)),
      providers: [provider],
      sellerPaymentManager: null,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      servicePerformance: tracker,
      emit: () => false,
    });
    const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
    const { mux } = handler.handleConnection(conn as any, '22'.repeat(20), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any, new VerificationMux(conn as any));
    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest({
        requestId: 'req-1', method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'test-model', stream: true })),
      }),
    });
  }

  function provider(overrides: Partial<Provider>): Provider {
    return {
      name: 'openai',
      services: ['test-model'],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      maxConcurrency: 1,
      handleRequest: vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 502, headers: {}, body: new Uint8Array(0) })),
      getCapacity: () => ({ current: 0, max: 1 }),
      ...overrides,
    };
  }

  it('records a streamed answer\'s first-token time and an upstream failure', async () => {
    const tracker = new ServicePerformanceTracker();
    const encoder = new TextEncoder();
    await serve(provider({
      handleRequestStream: async (req, callbacks) => {
        const headers = { 'content-type': 'text/event-stream' };
        callbacks.onResponseStart({ requestId: req.requestId, statusCode: 200, headers, body: new Uint8Array(0) });
        await new Promise((resolve) => setTimeout(resolve, 30));
        const body = encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":40}}\n\ndata: [DONE]\n\n');
        await callbacks.onResponseChunk({ requestId: req.requestId, data: body, done: false });
        await callbacks.onResponseChunk({ requestId: req.requestId, data: new Uint8Array(0), done: true });
        return { requestId: req.requestId, statusCode: 200, headers, body };
      },
    }), tracker);
    await serve(provider({}), tracker);

    const performance = tracker.performance('openai', 'test-model')!;
    expect(performance).toMatchObject({ requests: 2, successRate: 0.5 });
    expect(performance.firstTokenMsP50).toBeGreaterThanOrEqual(25);
  });
});
