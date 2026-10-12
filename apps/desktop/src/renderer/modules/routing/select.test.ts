import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { DiscoverRow, VprRoutingPreferences } from '../../core/state';
import { bestFreeVprRouteReputation, chooseBestVprRoute, filterRoutableVprRoutes, isPeerRoutable, isRouteEligibleForAutoSelection, isRowCoolingDown, scoreVprRoute } from './select.js';
import { projectRowsToVprModelCatalog } from '../catalog/model-catalog.js';

const preferences: VprRoutingPreferences = {
  autoRouting: true,
  preferFreePeers: false,
  maxInputUsdPerMillion: 10,
  minTrustScore: 50,
  allowedPeerIds: [],
  blockedPeerIds: [],
};

function discoverRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const peerId = overrides.peerId ?? 'p1';
  const serviceId = overrides.serviceId ?? 's1';
  const provider = overrides.provider ?? 'openai';
  return {
    rowKey: `${peerId}:${serviceId}`,
    serviceId,
    serviceLabel: serviceId,
    categories: [],
    provider,
    protocol: 'openai-chat-completions',
    peerId,
    peerEvmAddress: '',
    sellerContract: null,
    verificationLinks: [],
    peerIconUrl: null,
    peerDisplayName: null,
    peerLabel: '',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cachedInputUsdPerMillion: null,
    lifetimeSessions: 0,
    lifetimeRequests: 0,
    lifetimeInputTokens: 0,
    lifetimeOutputTokens: 0,
    lifetimeFirstSessionAt: null,
    lifetimeLastSessionAt: null,
    onChainChannelCount: null,
    agentId: 1,
    poolStakeAnts: 0,
    onChainActiveChannelCount: 0,
    onChainGhostCount: 0,
    onChainTotalVolumeUsdc: '0',
    onChainLastSettledAt: 0,
    effectiveReputationScore: 75,
    onChainReputationScore: null,
    washFlagged: null,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    peerCooldownUntil: null,
    peerFailureStreak: 0,
    peerLastFailureReason: null,
    selectionValue: `${provider}\u0001${serviceId}\u0001${peerId}`,
    ...overrides,
  };
}

test('free peer wins when preferFreePeers is true', () => {
  const best = chooseBestVprRoute(
    [
      discoverRow({ peerId: 'paid', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }),
      discoverRow({ peerId: 'free', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }),
    ],
    { ...preferences, preferFreePeers: true },
  );

  assert.equal(best?.peerId, 'free');
});

test('peer over max input price is penalized', () => {
  const cheap = discoverRow({ peerId: 'cheap', inputUsdPerMillion: 9, outputUsdPerMillion: 0 });
  const expensive = discoverRow({ peerId: 'expensive', inputUsdPerMillion: 11, outputUsdPerMillion: 0 });

  assert.equal(chooseBestVprRoute([expensive, cheap], preferences)?.peerId, 'cheap');
  assert.ok(scoreVprRoute(expensive, preferences).score < scoreVprRoute(cheap, preferences).score);
});

test('peer below minimum reputation is ineligible even when much cheaper', () => {
  const trusted = discoverRow({
    peerId: 'trusted',
    effectiveReputationScore: 60,
    inputUsdPerMillion: 20,
    outputUsdPerMillion: 20,
  });
  const lowTrust = discoverRow({
    peerId: 'low-trust',
    effectiveReputationScore: 59.9,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  });
  const prefs = { ...preferences, minTrustScore: 60 };

  assert.equal(isRouteEligibleForAutoSelection(lowTrust, prefs), false);
  assert.equal(chooseBestVprRoute([lowTrust, trusted], prefs)?.peerId, 'trusted');
});

test('unknown reputation cannot bypass a positive minimum with cheap pricing', () => {
  const unknown = discoverRow({
    peerId: 'unknown',
    effectiveReputationScore: null,
    onChainReputationScore: null,
    washFlagged: null,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  });

  assert.equal(isRouteEligibleForAutoSelection(unknown, { ...preferences, minTrustScore: 60 }), false);
  assert.equal(chooseBestVprRoute([unknown], { ...preferences, minTrustScore: 60 }), null);
});

test('a trust breakdown alone does not stand in for the displayed score', () => {
  const unscored = discoverRow({
    effectiveReputationScore: null,
    onChainReputationScore: null,
    trust: { score: 100, history: { score: 50, channelCount: 100, totalVolumeUsdcMicros: 100_000_000 }, usage: { score: 20, shareBps: 10_000, epoch: 11 }, power: { score: 10, shareBps: 10_000, epoch: 11 }, identity: { score: 20, kind: 'github', claim: 'portfolio' }, washFlagged: false },
  });

  assert.equal(isRouteEligibleForAutoSelection(unscored, { ...preferences, minTrustScore: 60 }), false);
  assert.ok(scoreVprRoute(unscored, preferences).score < 120);
});

test('tie breaker uses lower price', () => {
  const cheaper = discoverRow({
    peerId: 'cheaper',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    effectiveReputationScore: 60,
  });
  const pricier = discoverRow({
    peerId: 'pricier',
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 3,
    effectiveReputationScore: 80,
  });

  assert.equal(scoreVprRoute(cheaper, preferences).score, scoreVprRoute(pricier, preferences).score);
  assert.equal(chooseBestVprRoute([pricier, cheaper], preferences)?.peerId, 'cheaper');
});

test('empty rows returns null', () => {
  assert.equal(chooseBestVprRoute([], preferences), null);
});

test('missing price and trust values are handled without mutating rows', () => {
  const row = discoverRow({
    peerId: 'missing-values',
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    effectiveReputationScore: null,
    onChainReputationScore: null,
    washFlagged: null,
  });
  const other = discoverRow({ peerId: 'other' });
  const rows = [row, other];
  const originalRow = structuredClone(row);
  const originalOrder = rows.map((candidate) => candidate.peerId);

  // 100 base - 10 unknown-price penalty; unknown price must not score as free.
  assert.equal(scoreVprRoute(row, preferences).score, 90);
  assert.ok(scoreVprRoute(row, preferences).reasons.includes('price unknown'));
  assert.equal(chooseBestVprRoute(rows, preferences)?.peerId, 'other');
  assert.deepEqual(row, originalRow);
  assert.deepEqual(rows.map((candidate) => candidate.peerId), originalOrder);
});

test('cheap priced route beats unknown-priced route at equal trust', () => {
  const unpriced = discoverRow({
    peerId: 'unpriced',
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
  });
  const cheap = discoverRow({ peerId: 'cheap', inputUsdPerMillion: 1, outputUsdPerMillion: 2 });

  assert.equal(chooseBestVprRoute([unpriced, cheap], preferences)?.peerId, 'cheap');
});

test('known priced route beats unknown route even when trust is lower', () => {
  const unpriced = discoverRow({
    peerId: 'unpriced',
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    effectiveReputationScore: 100,
  });
  const cheap = discoverRow({
    peerId: 'cheap',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    effectiveReputationScore: 50,
  });

  assert.equal(scoreVprRoute(unpriced, preferences).score, 110);
  assert.equal(scoreVprRoute(cheap, preferences).score, 107);
  assert.equal(chooseBestVprRoute([unpriced, cheap], preferences)?.peerId, 'cheap');
});

test('blocked peers are never chosen, even when they score best', () => {
  const blocked = discoverRow({ peerId: 'blocked', inputUsdPerMillion: 0, outputUsdPerMillion: 0, effectiveReputationScore: 100 });
  const other = discoverRow({ peerId: 'other', inputUsdPerMillion: 5, outputUsdPerMillion: 5 });
  const prefs = { ...preferences, blockedPeerIds: ['blocked'] };

  assert.equal(chooseBestVprRoute([blocked, other], prefs)?.peerId, 'other');
  assert.equal(isPeerRoutable('blocked', prefs), false);
  assert.equal(chooseBestVprRoute([blocked], prefs), null);
});

test('a non-empty allowlist restricts routing to its peers', () => {
  const allowed = discoverRow({ peerId: 'allowed', inputUsdPerMillion: 9, outputUsdPerMillion: 9 });
  const cheaper = discoverRow({ peerId: 'cheaper', inputUsdPerMillion: 1, outputUsdPerMillion: 1 });
  const prefs = { ...preferences, allowedPeerIds: ['allowed'] };

  assert.equal(chooseBestVprRoute([cheaper, allowed], prefs)?.peerId, 'allowed');
  assert.equal(isPeerRoutable('cheaper', prefs), false);
});

test('an empty allowlist means no restriction', () => {
  const rows = [discoverRow({ peerId: 'a' }), discoverRow({ peerId: 'b' })];

  assert.deepEqual(filterRoutableVprRoutes(rows, preferences).map((row) => row.peerId), ['a', 'b']);
});

test('the blocklist wins over the allowlist for the same peer', () => {
  const prefs = { ...preferences, allowedPeerIds: ['peer-1'], blockedPeerIds: ['peer-1'] };

  assert.equal(isPeerRoutable('peer-1', prefs), false);
});

test('the catalog built from routable rows drops models only excluded sellers offer', () => {
  const rows = [
    discoverRow({ peerId: 'allowed', serviceId: 'shared' }),
    discoverRow({ peerId: 'other', serviceId: 'shared' }),
    discoverRow({ peerId: 'other', serviceId: 'other-only' }),
  ];
  const prefs = { ...preferences, allowedPeerIds: ['allowed'] };

  const catalog = projectRowsToVprModelCatalog(filterRoutableVprRoutes(rows, prefs));
  assert.deepEqual(catalog.map((entry) => entry.serviceId), ['shared']);
  assert.equal(catalog[0].peerCount, 1);
});

test('blocking the only seller of a model removes it from the catalog', () => {
  const rows = [discoverRow({ peerId: 'solo', serviceId: 'solo-model' })];
  const prefs = { ...preferences, blockedPeerIds: ['solo'] };

  assert.deepEqual(projectRowsToVprModelCatalog(filterRoutableVprRoutes(rows, prefs)), []);
});

const NOW = 1_700_000_000_000;

test('a cooling-down peer loses even when it is cheaper and more trusted', () => {
  const best = chooseBestVprRoute(
    [
      discoverRow({
        peerId: 'cooling',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.1,
        effectiveReputationScore: 99,
        peerCooldownUntil: NOW + 30_000,
      }),
      discoverRow({ peerId: 'healthy', inputUsdPerMillion: 5, outputUsdPerMillion: 5, effectiveReputationScore: 60 }),
    ],
    preferences,
    NOW,
  );

  assert.equal(best?.peerId, 'healthy');
});

test('a cooling-down priced peer loses to a healthy unknown-price peer', () => {
  // Guards the compare-order fix: the known-price tier used to be evaluated
  // before the score, so no cooldown penalty could ever outrank it.
  const best = chooseBestVprRoute(
    [
      discoverRow({ peerId: 'cooling', inputUsdPerMillion: 1, outputUsdPerMillion: 1, peerCooldownUntil: NOW + 30_000 }),
      discoverRow({ peerId: 'unpriced', inputUsdPerMillion: null, outputUsdPerMillion: null }),
    ],
    preferences,
    NOW,
  );

  assert.equal(best?.peerId, 'unpriced');
});

test('routing still returns a peer when every candidate is cooling down', () => {
  const best = chooseBestVprRoute(
    [
      discoverRow({ peerId: 'a', inputUsdPerMillion: 5, outputUsdPerMillion: 5, peerCooldownUntil: NOW + 30_000 }),
      discoverRow({ peerId: 'b', inputUsdPerMillion: 1, outputUsdPerMillion: 1, peerCooldownUntil: NOW + 30_000 }),
    ],
    preferences,
    NOW,
  );

  // Cooldown is a penalty, never a filter — the cheapest of a bad set wins.
  assert.equal(best?.peerId, 'b');
});

test('an expired or absent cooldown is ignored', () => {
  assert.equal(isRowCoolingDown(discoverRow({ peerCooldownUntil: NOW - 1 }), NOW), false);
  assert.equal(isRowCoolingDown(discoverRow({ peerCooldownUntil: null }), NOW), false);
  assert.equal(isRowCoolingDown(discoverRow({ peerCooldownUntil: NOW + 1_000 }), NOW), true);
});

test('an impossibly distant cooldown is treated as no cooldown', () => {
  assert.equal(isRowCoolingDown(discoverRow({ peerCooldownUntil: NOW + 86_400_000 }), NOW), false);
});

test('failure streak breaks a tie between otherwise identical peers', () => {
  const best = chooseBestVprRoute(
    [
      discoverRow({ peerId: 'flaky', peerFailureStreak: 2 }),
      discoverRow({ peerId: 'clean', peerFailureStreak: 0 }),
    ],
    preferences,
    NOW,
  );

  assert.equal(best?.peerId, 'clean');
});

test('the blocklist still wins over a healthy peer', () => {
  const best = chooseBestVprRoute(
    [
      discoverRow({ peerId: 'blocked' }),
      discoverRow({ peerId: 'cooling', peerCooldownUntil: NOW + 30_000 }),
    ],
    { ...preferences, blockedPeerIds: ['blocked'] },
    NOW,
  );

  // Blocked is absolute; cooling down is only a preference.
  assert.equal(best?.peerId, 'cooling');
});

test('scoreVprRoute explains why a cooling-down peer was deprioritized', () => {
  const scored = scoreVprRoute(discoverRow({ peerCooldownUntil: NOW + 30_000 }), preferences, NOW);
  assert.ok(scored.reasons.includes('peer cooling down'));
  assert.ok(scored.score < 0);
});

test('bestFreeVprRouteReputation requires a $0 route that passes the eligibility gate', () => {
  const freeRated = discoverRow({ peerId: 'free-rated', inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const freeUnrated = discoverRow({
    peerId: 'free-unrated',
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    effectiveReputationScore: null,
  });
  const paid = discoverRow({ peerId: 'paid' });

  assert.equal(bestFreeVprRouteReputation([freeRated, paid], preferences), 75);
  // A free seller with no reputation fails the trust gate; a paid seller never counts.
  assert.equal(bestFreeVprRouteReputation([freeUnrated, paid], preferences), null);
  assert.equal(bestFreeVprRouteReputation([freeRated], { ...preferences, blockedPeerIds: ['free-rated'] }), null);
});

test('bestFreeVprRouteReputation returns the highest trust score among eligible free routes', () => {
  const lowRep = discoverRow({
    peerId: 'free-low',
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    effectiveReputationScore: 63,
  });
  const highRep = discoverRow({
    peerId: 'free-high',
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    effectiveReputationScore: 92,
  });

  assert.equal(bestFreeVprRouteReputation([lowRep, highRep], preferences), 92);
});
