import { describe, expect, it, vi } from 'vitest';
import {
  computeTrustScore, historyCurve, trustScore, shareCurve, TRUST_IDENTITY_BONUS, TRUST_WEIGHTS,
} from '../src/reputation/trust-score.js';
import { DefaultRouter } from '../src/routing/default-router.js';
import type { PeerInfo } from '../src/types/peer.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import { peerWithGithub } from './helpers/identity-fixtures.js';

const NOW = Date.parse('2026-09-06T00:00:00Z');
const PEER_ID = 'a'.repeat(40) as PeerInfo['peerId'];
const FREE_PRICING: PeerInfo['providerPricing'] = {
  openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'free-model': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } },
};

function chainPeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: PEER_ID, providers: [], lastSeen: NOW,
    onChainUsageEpoch: 22, onChainUsageShareBps: 0, onChainPoolPowerShareBps: 0, onChainWashFlagged: false,
    ...overrides,
  };
}

describe('shareCurve', () => {
  it('maps basis points to 0-1, with full marks at a 50% share', () => {
    expect(shareCurve(0)).toBe(0);
    expect(shareCurve(50)).toBeCloseTo(0.347, 2);
    expect(shareCurve(500)).toBeCloseTo(0.667, 2);
    expect(shareCurve(5_000)).toBe(1);
    expect(shareCurve(10_000)).toBe(1);
    expect(shareCurve(NaN)).toBe(0);
  });

  it('keeps the power and usage weights summing to 100', () => {
    expect(TRUST_WEIGHTS.power + TRUST_WEIGHTS.usage).toBe(100);
  });

  it('keeps the deprecated weights for existing consumers', () => {
    expect(TRUST_WEIGHTS.history).toBe(0);
    expect(TRUST_WEIGHTS.identity).toBe(TRUST_IDENTITY_BONUS);
  });
});

describe('historyCurve', () => {
  it('stays exported with its behavior for existing consumers', () => {
    expect(historyCurve(0, 100)).toBe(0);
    expect(historyCurve(9, 100)).toBeCloseTo(0.499, 2);
    expect(historyCurve(100, 100)).toBe(1);
    expect(historyCurve(1_000, 100)).toBe(1);
    expect(historyCurve(NaN, 100)).toBe(0);
  });
});

describe('computeTrustScore', () => {
  it('is null when nothing about the peer is known', () => {
    expect(computeTrustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, reputationScore: 100 }, NOW)).toBeNull();
  });

  it('reports settled service history without scoring it', () => {
    const established = chainPeer({ onChainChannelCount: 1_000, onChainTotalVolumeUsdcMicros: 1_000_000_000 });
    expect(computeTrustScore(established, NOW)).toMatchObject({
      score: 0,
      // `history.score` stays for existing consumers of the published type.
      history: { score: 0, channelCount: 1_000, totalVolumeUsdcMicros: 1_000_000_000 },
    });
    // History alone still makes the peer known, so a seller-reported score cannot stand in for it.
    expect(computeTrustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, reputationScore: 100,
      onChainChannelCount: 1_000, onChainTotalVolumeUsdcMicros: 1_000_000_000 }, NOW)?.score).toBe(0);
  });

  it('weighs current-epoch power at 70 and last-epoch usage at 30', () => {
    const balanced = chainPeer({ onChainUsageShareBps: 500, onChainPoolPowerShareBps: 500 });
    expect(computeTrustScore(balanced, NOW)).toMatchObject({
      usage: { shareBps: 500, epoch: 21 }, power: { shareBps: 500, epoch: 22 }, identity: null, washFlagged: false,
    });
    expect(trustScore(balanced, NOW)).toBeCloseTo(100 * shareCurve(500));
    expect(trustScore(chainPeer({ onChainPoolPowerShareBps: 500 }), NOW)).toBeCloseTo(70 * shareCurve(500));
    expect(trustScore(chainPeer({ onChainUsageShareBps: 500 }), NOW)).toBeCloseTo(30 * shareCurve(500));
    expect(trustScore(chainPeer(), NOW)).toBe(0);
    expect(trustScore(chainPeer({ onChainUsageShareBps: 5_000, onChainPoolPowerShareBps: 5_000 }), NOW)).toBe(100);
  });

  it('keeps a seller with no stake at 0 whatever its usage history, and below the default gate on usage alone', () => {
    expect(trustScore(chainPeer({ onChainChannelCount: 500, onChainTotalVolumeUsdcMicros: 200_000_000 }), NOW)).toBe(0);
    expect(trustScore(chainPeer({ onChainUsageShareBps: 5_000 }), NOW)).toBeLessThan(60);
    // Real stake clears it.
    expect(trustScore(chainPeer({ onChainUsageShareBps: 500, onChainPoolPowerShareBps: 500 }), NOW)).toBeGreaterThan(60);
  });

  it('has no usage part in the first epoch and no power part without pool data', () => {
    expect(computeTrustScore(chainPeer({ onChainUsageEpoch: 0, onChainUsageShareBps: 5_000 }), NOW)?.usage).toBeNull();
    const noPools = computeTrustScore(chainPeer({ onChainUsageShareBps: 1_000, onChainPoolPowerShareBps: undefined }), NOW);
    expect(noPools?.power).toBeNull();
    expect(noPools?.score).toBeCloseTo(30 * shareCurve(1_000));
  });

  it('adds up to 20 points for a verified identity on top of the weighted parts', () => {
    const identityOnly = peerWithGithub();
    expect(computeTrustScore(identityOnly, NOW)).toMatchObject({ score: 20, history: null, usage: null, power: null, identity: { score: 20, kind: 'github', claim: 'portfolio' }, washFlagged: null });
    const strong = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 5_000, onChainPoolPowerShareBps: 5_000 }) };
    expect(trustScore(strong, NOW)).toBe(100);
    // The free-model bonus never pushes the total past 100.
    expect(trustScore({ ...strong, providerPricing: FREE_PRICING }, NOW)).toBe(100);
    const typical = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 100, onChainPoolPowerShareBps: 100 }) };
    expect(trustScore(typical, NOW)).toBeCloseTo(20 + 100 * shareCurve(100));
    const domainOnly = peerWithGithub([]);
    domainOnly.verificationResults!.identityHistory = { version: 1, identities: [{ kind: 'domain', claim: 'portfolio.example',
      status: 'available', identityId: 'domain:portfolio.example', fetchedAtMs: NOW, createdAtMs: NOW - 20 * 365.25 * 86_400_000 }] };
    expect(trustScore(domainOnly, NOW)).toBeCloseTo(20 * 12 / 70);
  });

  it('adds 5 points when the seller offers a free model', () => {
    expect(computeTrustScore(chainPeer({ providerPricing: FREE_PRICING }), NOW)).toMatchObject({
      score: 5, freeModels: { score: 5, service: 'free-model' },
    });
    // A provider whose defaults are $0 and that lists no services counts as free.
    const freeDefaults: PeerInfo['providerPricing'] = { local: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } };
    expect(computeTrustScore(chainPeer({ providerPricing: freeDefaults }), NOW)?.freeModels).toMatchObject({ score: 5 });
  });

  it('does not count paid, partly free or cached-priced models as free', () => {
    const notFree = (price: { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number }) =>
      computeTrustScore(chainPeer({ providerPricing: { openai: { defaults: price } } }), NOW)?.freeModels;
    expect(notFree({ inputUsdPerMillion: 0, outputUsdPerMillion: 0.1 })).toBeNull();
    expect(notFree({ inputUsdPerMillion: 0.1, outputUsdPerMillion: 0 })).toBeNull();
    expect(notFree({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.01 })).toBeNull();
    expect(computeTrustScore(chainPeer(), NOW)?.freeModels).toBeNull();
  });

  it('does not score an otherwise unknown seller for a free model alone', () => {
    expect(computeTrustScore({ peerId: PEER_ID, providers: [], lastSeen: NOW, providerPricing: FREE_PRICING }, NOW)).toBeNull();
  });

  it('zeroes a proven wash trader regardless of usage, power or identity', () => {
    const flagged = { ...peerWithGithub(), ...chainPeer({ onChainUsageShareBps: 10_000, onChainPoolPowerShareBps: 10_000, onChainWashFlagged: true }) };
    expect(computeTrustScore(flagged, NOW)).toMatchObject({ score: 0, washFlagged: true });
    expect(trustScore(chainPeer({ onChainWashFlagged: true }), NOW)).toBe(0);
  });

  it('ignores ghost count, stake amount and the local sybil heuristic', () => {
    const peer = chainPeer({ onChainUsageShareBps: 100, onChainPoolPowerShareBps: 100, onChainChannelCount: 0, onChainGhostCount: 500,
      onChainSybilRisk: 1, onChainTotalVolumeUsdcMicros: 0, onChainPoolStakeAnts: 1_000_000, onChainUsageLastEpochUsdcMicros: 5 });
    expect(trustScore(peer, NOW)).toBeCloseTo(100 * shareCurve(100));
  });

  it('feeds the default router: price-first among eligible peers, trust as the eligibility gate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const cheap: PeerInfo = { ...chainPeer(), peerId: 'b'.repeat(40) as PeerInfo['peerId'], onChainReputationScore: 0, defaultInputUsdPerMillion: 1 };
      const established: PeerInfo = { ...chainPeer({ onChainUsageShareBps: 2_000, onChainPoolPowerShareBps: 2_000 }), onChainReputationScore: 75, defaultInputUsdPerMillion: 2 };
      const request = {} as SerializedHttpRequest;
      expect(new DefaultRouter().selectPeer(request, [established, cheap])).toBe(cheap);
      expect(new DefaultRouter({ minReputation: 60 }).selectPeer(request, [cheap, established])).toBe(established);
    } finally { vi.useRealTimers(); }
  });
});
