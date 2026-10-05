import { expect, test } from 'vitest';
import {
  applyFilters, applySort, paginate, totalPagesFor,
  MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD,
} from '../components/chat/discover-filter-util';
import type { DiscoverRow } from '../../core/state';

function mkRow(i: number, chat: boolean): DiscoverRow {
  return {
    rowKey: `p${i}:s${i}`,
    serviceId: `s${i}`, serviceLabel: `Svc${i}`, categories: [i % 2 === 0 ? 'math' : 'coding'],
    provider: 'openai', protocol: 'openai-chat-completions',
    peerId: `p${i}`, peerEvmAddress: `0xp${i}`, sellerContract: null, verificationLinks: [], peerDisplayName: `P${i}`, peerLabel: `P${i}`,
    inputUsdPerMillion: i, outputUsdPerMillion: i * 2, cachedInputUsdPerMillion: null,
    lifetimeSessions: chat ? i : 0, lifetimeRequests: 0, lifetimeInputTokens: 0, lifetimeOutputTokens: 0,
    lifetimeFirstSessionAt: null, lifetimeLastSessionAt: chat ? i * 1000 : null,
    onChainChannelCount: null,
    agentId: 1, poolStakeAnts: i,
    onChainActiveChannelCount: 0, onChainGhostCount: 0, onChainTotalVolumeUsdc: '0', onChainLastSettledAt: 0,
    onChainReputationScore: null,
    networkRequests: null, networkInputTokens: null, networkOutputTokens: null,
    selectionValue: '',
  };
}

test('pipeline: filter → sort → paginate on 25 rows', () => {
  const rows = Array.from({ length: 25 }, (_, i) => mkRow(i + 1, i % 3 === 0));
  const filtered = applyFilters(rows, {
    search: '', categorySet: new Set(), peerSet: new Set(),
    maxInputPrice: MAX_INPUT_PRICE_SLIDER_USD,
    maxOutputPrice: MAX_OUTPUT_PRICE_SLIDER_USD,
    minStakeAnts: 0,
    minReputationScore: 0,
  });
  expect(filtered).toHaveLength(25);
  const sorted = applySort(filtered, 'recentlyUsed', 'desc');
  expect(sorted[0]!.serviceLabel).toBe('Svc25');
  const paged = paginate(sorted, 1, 5);
  expect(paged).toHaveLength(5);
  expect(totalPagesFor(sorted.length, 5)).toBe(5);
});

test('pipeline: stake + reputation filters', () => {
  const rows = [
    { ...mkRow(1, true), onChainReputationScore: 80 },
    { ...mkRow(50, true), onChainReputationScore: 40 },
    { ...mkRow(100, false), onChainReputationScore: 90 },
  ];
  const filtered = applyFilters(rows, {
    search: '', categorySet: new Set(), peerSet: new Set(),
    maxInputPrice: MAX_INPUT_PRICE_SLIDER_USD,
    maxOutputPrice: MAX_OUTPUT_PRICE_SLIDER_USD,
    minStakeAnts: 50,
    minReputationScore: 50,
  });
  expect(filtered).toHaveLength(1);
  expect(filtered[0]!.serviceLabel).toBe('Svc100');
});
