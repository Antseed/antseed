import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  matchesSearch, matchesMaxInputPrice, matchesMaxOutputPrice,
  matchesMinStake,
  matchesMinReputationScore, rowChannelCount, rowReputationScore,
  hasValidCachedInputPrice,
  applyFilters, applySort, paginate, totalPagesFor,
  MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD,
} from './discover-filter-util';
import type { DiscoverRow } from '../../../core/state';

function mkRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  return {
    rowKey: 'p:s',
    serviceId: 's', serviceLabel: 'Service', categories: [],
    provider: 'openai', protocol: 'openai-chat-completions',
    peerId: 'p', peerEvmAddress: '0xp', sellerContract: null, verificationLinks: [], peerDisplayName: 'Peer', peerLabel: 'Peer',
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: null,
    lifetimeSessions: 0, lifetimeRequests: 0, lifetimeInputTokens: 0, lifetimeOutputTokens: 0,
    lifetimeFirstSessionAt: null, lifetimeLastSessionAt: null,
    onChainChannelCount: null,
    agentId: 1, poolStakeAnts: 0,
    onChainActiveChannelCount: 0, onChainGhostCount: 0, onChainTotalVolumeUsdc: '0', onChainLastSettledAt: 0,
    onChainReputationScore: null,
    networkRequests: null, networkInputTokens: null, networkOutputTokens: null,
    selectionValue: '',
    ...overrides,
  };
}

test('matchesSearch finds query in service, peer, categories', () => {
  const r = mkRow({ serviceLabel: 'GPT-5', peerLabel: 'Test Peer', categories: ['chat', 'math'] });
  assert.ok(matchesSearch(r, 'gpt'));
  assert.ok(matchesSearch(r, 'test'));
  assert.ok(matchesSearch(r, 'math'));
  assert.ok(!matchesSearch(r, 'zzz'));
});

test('matchesMaxInputPrice filters rows by the input slider ceiling', () => {
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 5 }), MAX_INPUT_PRICE_SLIDER_USD));
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: null }), MAX_INPUT_PRICE_SLIDER_USD));
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0.3 }), 0.5));
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0.5 }), 0.5));
  assert.ok(!matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0.6 }), 0.5));
  assert.ok(!matchesMaxInputPrice(mkRow({ inputUsdPerMillion: null }), 0.5));
  assert.ok(matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0 }), 0));
  assert.ok(!matchesMaxInputPrice(mkRow({ inputUsdPerMillion: 0.05 }), 0));
});

test('matchesMaxOutputPrice filters rows by the output slider ceiling', () => {
  assert.ok(matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: 20 }), MAX_OUTPUT_PRICE_SLIDER_USD));
  assert.ok(matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: null }), MAX_OUTPUT_PRICE_SLIDER_USD));
  assert.ok(matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: 0.4 }), 0.6));
  assert.ok(!matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: 0.7 }), 0.6));
  assert.ok(!matchesMaxOutputPrice(mkRow({ outputUsdPerMillion: null }), 0.6));
});

test('hasValidCachedInputPrice rejects cached input above input', () => {
  assert.ok(hasValidCachedInputPrice(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: null })));
  assert.ok(hasValidCachedInputPrice(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5 })));
  assert.ok(hasValidCachedInputPrice(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1 })));
  assert.ok(!hasValidCachedInputPrice(mkRow({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1.1 })));
  assert.ok(!hasValidCachedInputPrice(mkRow({ inputUsdPerMillion: null, cachedInputUsdPerMillion: 0.5 })));
});

test('matchesMinStake compares pool stake in whole ANTS to slider value', () => {
  assert.ok(matchesMinStake(mkRow({ poolStakeAnts: 10 }), 10));
  assert.ok(!matchesMinStake(mkRow({ poolStakeAnts: 9 }), 10));
  assert.ok(matchesMinStake(mkRow({ poolStakeAnts: 0 }), 0));
});

test('applySort stakeDesc orders by pool stake in ANTS', () => {
  const rows = [
    mkRow({ serviceLabel: 'A', poolStakeAnts: 5 }),
    mkRow({ serviceLabel: 'B', poolStakeAnts: 500 }),
    mkRow({ serviceLabel: 'C', poolStakeAnts: 50 }),
  ];
  const sorted = applySort(rows, 'stakeDesc', 'desc');
  assert.deepEqual(sorted.map((r) => r.serviceLabel), ['B', 'C', 'A']);
});

test('rowChannelCount uses the larger of active vs metadata channel count', () => {
  assert.equal(rowChannelCount(mkRow({ onChainActiveChannelCount: 20 })), 20);
  assert.equal(rowChannelCount(mkRow({ onChainActiveChannelCount: 0, onChainChannelCount: 25 })), 25);
  assert.equal(rowChannelCount(mkRow({ onChainActiveChannelCount: 5, onChainChannelCount: 8 })), 8);
  assert.equal(rowChannelCount(mkRow({ onChainActiveChannelCount: 0, onChainChannelCount: null })), 0);
});

test('matchesMinReputationScore gates rows by reputation threshold', () => {
  assert.ok(matchesMinReputationScore(mkRow({ onChainReputationScore: 0, effectiveReputationScore: 70 }), 60));
  assert.ok(matchesMinReputationScore(mkRow({ onChainReputationScore: 75 }), 50));
  assert.ok(matchesMinReputationScore(mkRow({ onChainReputationScore: 50 }), 50));
  assert.ok(!matchesMinReputationScore(mkRow({ onChainReputationScore: 49 }), 50));
  assert.ok(!matchesMinReputationScore(mkRow({ onChainReputationScore: null }), 50));
  // A threshold of zero always passes, including peers whose score has not loaded.
  assert.ok(matchesMinReputationScore(mkRow({ onChainReputationScore: null }), 0));
});

test('applyFilters composes all predicates', () => {
  const rows = [
    mkRow({ serviceLabel: 'A', inputUsdPerMillion: 0 }),
    mkRow({ serviceLabel: 'B', inputUsdPerMillion: 10, categories: ['coding'] }),
  ];
  const filtered = applyFilters(rows, {
    search: '', categorySet: new Set(['coding']), peerSet: new Set(),
    maxInputPrice: MAX_INPUT_PRICE_SLIDER_USD,
    maxOutputPrice: MAX_OUTPUT_PRICE_SLIDER_USD,
    minStakeAnts: 0,
    minReputationScore: 0,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.serviceLabel, 'B');
});

test('rowReputationScore returns score or -1 for missing values', () => {
  assert.equal(rowReputationScore(mkRow({ onChainReputationScore: 72.5 })), 72.5);
  assert.equal(rowReputationScore(mkRow({ onChainReputationScore: null })), -1);
});

test('applySort reputationDesc orders by reputation score then channel count', () => {
  const rows = [
    mkRow({ serviceLabel: 'A', onChainReputationScore: 20, onChainActiveChannelCount: 100 }),
    mkRow({ serviceLabel: 'B', onChainReputationScore: 80, onChainActiveChannelCount: 1 }),
    mkRow({ serviceLabel: 'C', onChainReputationScore: 20, onChainActiveChannelCount: 50 }),
  ];
  const sorted = applySort(rows, 'reputationDesc', 'desc');
  assert.deepEqual(sorted.map((r) => r.serviceLabel), ['B', 'A', 'C']);
});

test('applySort channelsDesc orders by channel count', () => {
  const rows = [
    mkRow({ serviceLabel: 'A', onChainActiveChannelCount: 5 }),
    mkRow({ serviceLabel: 'B', onChainActiveChannelCount: 50 }),
    mkRow({ serviceLabel: 'C', onChainActiveChannelCount: 20 }),
  ];
  const sorted = applySort(rows, 'channelsDesc', 'desc');
  assert.deepEqual(sorted.map((r) => r.serviceLabel), ['B', 'C', 'A']);
});

test('applySort recentlyUsed floats chatted-with rows, then by lastSession desc', () => {
  const rows = [
    mkRow({ serviceLabel: 'Zeta', lifetimeSessions: 0 }),
    mkRow({ serviceLabel: 'Alpha', lifetimeSessions: 1, lifetimeLastSessionAt: 100 }),
    mkRow({ serviceLabel: 'Beta', lifetimeSessions: 2, lifetimeLastSessionAt: 200 }),
  ];
  const sorted = applySort(rows, 'recentlyUsed', 'desc');
  assert.deepEqual(sorted.map((r) => r.serviceLabel), ['Beta', 'Alpha', 'Zeta']);
});

test('applySort serviceAsc sorts alphabetically', () => {
  const rows = [mkRow({ serviceLabel: 'C' }), mkRow({ serviceLabel: 'A' }), mkRow({ serviceLabel: 'B' })];
  const sorted = applySort(rows, 'serviceAsc', 'asc');
  assert.deepEqual(sorted.map((r) => r.serviceLabel), ['A', 'B', 'C']);
});

test('applySort priceAsc sorts by combined input+output price ascending', () => {
  const rows = [
    mkRow({ inputUsdPerMillion: 1, outputUsdPerMillion: 4 }), // 5
    mkRow({ inputUsdPerMillion: 2, outputUsdPerMillion: 1 }), // 3
    mkRow({ inputUsdPerMillion: 3, outputUsdPerMillion: 5 }), // 8
  ];
  const sorted = applySort(rows, 'priceAsc', 'asc');
  assert.deepEqual(sorted.map((r) => (r.inputUsdPerMillion ?? 0) + (r.outputUsdPerMillion ?? 0)), [3, 5, 8]);
});

test('applySort priceDesc sorts by combined price descending', () => {
  const rows = [
    mkRow({ inputUsdPerMillion: 1, outputUsdPerMillion: 4 }), // 5
    mkRow({ inputUsdPerMillion: 2, outputUsdPerMillion: 1 }), // 3
    mkRow({ inputUsdPerMillion: 3, outputUsdPerMillion: 5 }), // 8
  ];
  const sorted = applySort(rows, 'priceDesc', 'desc');
  assert.deepEqual(sorted.map((r) => (r.inputUsdPerMillion ?? 0) + (r.outputUsdPerMillion ?? 0)), [8, 5, 3]);
});

test('paginate returns the right slice and totalPagesFor rounds up', () => {
  const items = Array.from({ length: 23 }, (_, i) => i);
  assert.deepEqual(paginate(items, 1, 10), Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(paginate(items, 3, 10), [20, 21, 22]);
  assert.equal(totalPagesFor(23, 10), 3);
  assert.equal(totalPagesFor(0, 10), 1);
});
