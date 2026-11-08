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

  it('rotates equally priced, equally scored sellers instead of pinning the first peer id', () => {
    const alpha = route({ peerId: 'a'.repeat(40) });
    const beta = route({ peerId: 'b'.repeat(40) });
    const selected = Array.from({ length: 8 }, () => chooseBestModelRoute([beta, alpha], preferences)?.peerId);
    const tally = new Map<string, number>();
    for (const peerId of selected) tally.set(peerId ?? '', (tally.get(peerId ?? '') ?? 0) + 1);

    expect(tally.get(alpha.peerId)).toBe(4);
    expect(tally.get(beta.peerId)).toBe(4);
    for (let i = 1; i < selected.length; i += 1) expect(selected[i]).not.toBe(selected[i - 1]);
  });

  it('follows a new ranking when one tied seller pulls ahead', () => {
    const alpha = route({ peerId: 'c'.repeat(40) });
    const beta = route({ peerId: 'd'.repeat(40) });
    const whileTied = Array.from({ length: 4 }, () => chooseBestModelRoute([alpha, beta], preferences)?.peerId);
    expect(new Set(whileTied)).toEqual(new Set([alpha.peerId, beta.peerId]));

    const ahead = route({ peerId: alpha.peerId, effectiveReputationScore: 100 });
    const after = Array.from({ length: 6 }, () => chooseBestModelRoute([beta, ahead], preferences)?.peerId);
    expect(after).toEqual(Array(6).fill(ahead.peerId));
  });

  it('keeps selecting the only seller', () => {
    const only = route({ peerId: 'e'.repeat(40) });
    const selected = Array.from({ length: 5 }, () => chooseBestModelRoute([only], preferences)?.peerId);
    expect(selected).toEqual(Array(5).fill(only.peerId));
  });

  it('returns no seller for an empty list', () => {
    expect(chooseBestModelRoute([], preferences)).toBeNull();
    expect(rankModelRoutes([], preferences)).toEqual([]);
  });

  it('does not rotate a cooling seller ahead of a ready one at the same price', () => {
    const now = 1_700_000_000_000;
    const ready = route({ peerId: 'a'.repeat(40) });
    const cooling = route({ peerId: 'b'.repeat(40), peerCooldownUntil: now + 30_000 });
    const selected = Array.from({ length: 4 }, () => chooseBestModelRoute([cooling, ready], preferences, now)?.peerId);
    expect(selected).toEqual(Array(4).fill(ready.peerId));
  });
});
