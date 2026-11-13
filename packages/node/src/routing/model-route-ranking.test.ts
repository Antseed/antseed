import { describe, expect, it } from 'vitest';
import {
  chooseBestModelRoute,
  isModelRouteEligible,
  rankModelRoutes,
  scoreModelRoute,
  type ModelRouteCandidate,
  type ModelRoutingPreferences,
} from './model-route-ranking.js';

const preferences: ModelRoutingPreferences = {
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
};

function route(overrides: Partial<ModelRouteCandidate>): ModelRouteCandidate {
  return {
    peerId: 'a'.repeat(40),
    effectiveReputationScore: 80,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    peerCooldownUntil: null,
    peerFailureStreak: 0,
    ...overrides,
  };
}

describe('model route ranking', () => {
  it('balances price and trust like Desktop Auto routing', () => {
    const cobaltRelay = route({
      peerId: 'a'.repeat(40),
      effectiveReputationScore: 99,
      inputUsdPerMillion: 1.88,
      outputUsdPerMillion: 9.38,
    });
    const emberRoute = route({
      peerId: 'b'.repeat(40),
      effectiveReputationScore: 96,
      inputUsdPerMillion: 0.9,
      outputUsdPerMillion: 2.7,
    });

    expect(chooseBestModelRoute([cobaltRelay, emberRoute], preferences)?.peerId).toBe(emberRoute.peerId);
    expect(rankModelRoutes([cobaltRelay, emberRoute], preferences).map((candidate) => candidate.peerId))
      .toEqual([emberRoute.peerId, cobaltRelay.peerId]);
  });

  it('prefers price over reputation among peers above the trust gate', () => {
    // Trust is a gate, not a rank: a 9.9-reputation paid seller must not
    // beat an eligible 7.9-reputation free seller of the same model.
    const reputablePaid = route({
      peerId: 'a'.repeat(40),
      effectiveReputationScore: 99,
      inputUsdPerMillion: 0.19,
      outputUsdPerMillion: 0.75,
    });
    const eligibleFree = route({
      peerId: 'b'.repeat(40),
      effectiveReputationScore: 79,
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    });

    expect(chooseBestModelRoute([reputablePaid, eligibleFree], preferences)?.peerId).toBe(eligibleFree.peerId);
  });

  it('never auto-selects a peer below the minimum trust score', () => {
    const trusted = route({ peerId: 'a'.repeat(40), effectiveReputationScore: 60, inputUsdPerMillion: 20, outputUsdPerMillion: 20 });
    const cheap = route({ peerId: 'b'.repeat(40), effectiveReputationScore: 59.9, inputUsdPerMillion: 0, outputUsdPerMillion: 0 });

    expect(isModelRouteEligible(cheap, preferences)).toBe(false);
    expect(chooseBestModelRoute([cheap, trusted], preferences)?.peerId).toBe(trusted.peerId);
  });

  it('places cooling peers after healthy peers but still returns one when all are cooling', () => {
    const now = 1_700_000_000_000;
    const coolingCheap = route({
      peerId: 'a'.repeat(40),
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      peerCooldownUntil: now + 30_000,
    });
    const healthy = route({ peerId: 'b'.repeat(40), inputUsdPerMillion: 10, outputUsdPerMillion: 10 });

    expect(chooseBestModelRoute([coolingCheap, healthy], preferences, now)?.peerId).toBe(healthy.peerId);
    expect(chooseBestModelRoute([coolingCheap], preferences, now)?.peerId).toBe(coolingCheap.peerId);
    expect(scoreModelRoute(coolingCheap, preferences, now).reasons).toContain('peer cooling down');
  });

  it('applies allowlists and blocklists before scoring', () => {
    const allowed = route({ peerId: 'a'.repeat(40), inputUsdPerMillion: 10, outputUsdPerMillion: 10 });
    const cheaper = route({ peerId: 'b'.repeat(40), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
    const restricted = {
      ...preferences,
      allowedPeerIds: [`0x${allowed.peerId}`],
      blockedPeerIds: [cheaper.peerId],
    };

    expect(chooseBestModelRoute([cheaper, allowed], restricted)?.peerId).toBe(allowed.peerId);
  });
});
