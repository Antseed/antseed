import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopPaymentChannelSummary } from './buyer-channels.js';
import {
  buildLocalBuyerSpendHistory,
  unavailableLocalBuyerSpendHistory,
} from './buyer-spend-history.js';

const NOW_MS = Date.UTC(2026, 7, 10, 12);

function channel(overrides: Partial<DesktopPaymentChannelSummary>): DesktopPaymentChannelSummary {
  return {
    channelId: 'channel-1',
    peerId: 'peer-1',
    seller: '0xseller',
    sellerDisplayName: null,
    onChainStateKnown: false,
    reserveCeiling: null,
    cumulativeSigned: '0',
    onChainDeposit: '0',
    onChainSettled: '0',
    reservedAt: NOW_MS,
    updatedAt: NOW_MS,
    deadline: 0,
    status: 'active',
    requestCount: 0,
    inputTokens: '0',
    outputTokens: '0',
    cooperativeCloseSupported: false,
    ...overrides,
  };
}

test('buildLocalBuyerSpendHistory aggregates cumulative channel usage by local update day', () => {
  const result = buildLocalBuyerSpendHistory([
    channel({
      channelId: 'channel-1',
      cumulativeSigned: '125000',
      inputTokens: '100',
      outputTokens: '25',
      requestCount: 2,
      updatedAt: Date.UTC(2026, 7, 9, 10),
    }),
    channel({
      channelId: 'channel-2',
      cumulativeSigned: '70000',
      onChainSettled: '75000',
      inputTokens: '40',
      outputTokens: '10',
      requestCount: 1,
      updatedAt: Date.UTC(2026, 7, 9, 22),
      status: 'settled',
    }),
  ], NOW_MS);

  assert.deepEqual(result, {
    available: true,
    source: 'local',
    unavailableReason: null,
    days: [{
      day: '2026-08-09',
      dayStart: 1_786_233_600,
      spentUsdc: '200000',
      inputTokens: '140',
      outputTokens: '35',
    }],
  });
});

test('local history uses the larger locally settled amount when it exceeds the last signed snapshot', () => {
  const result = buildLocalBuyerSpendHistory([
    channel({ cumulativeSigned: '90000', onChainSettled: '125000', requestCount: 1, status: 'settled' }),
  ], NOW_MS);

  assert.equal(result.days[0]?.spentUsdc, '125000');
});

test('local history includes unsettled and ghosted channels with delivered usage', () => {
  const result = buildLocalBuyerSpendHistory([
    channel({ cumulativeSigned: '300000', inputTokens: '500', requestCount: 3, status: 'active' }),
    channel({ channelId: 'channel-2', cumulativeSigned: '200000', outputTokens: '50', requestCount: 1, status: 'ghost' }),
  ], NOW_MS);

  assert.equal(result.days[0]?.spentUsdc, '500000');
  assert.equal(result.days[0]?.inputTokens, '500');
  assert.equal(result.days[0]?.outputTokens, '50');
});

test('local history falls back to reservedAt and ignores empty, invalid, and old channels', () => {
  const result = buildLocalBuyerSpendHistory([
    channel({ cumulativeSigned: '100', requestCount: 1, updatedAt: 0, reservedAt: Date.UTC(2026, 7, 8, 8) }),
    channel({ channelId: 'empty', updatedAt: Date.UTC(2026, 7, 8, 8) }),
    channel({ channelId: 'invalid', cumulativeSigned: 'nope', requestCount: 1 }),
    channel({ channelId: 'old', cumulativeSigned: '900', requestCount: 1, updatedAt: Date.UTC(2026, 3, 1) }),
  ], NOW_MS);

  assert.deepEqual(result.days, [{
    day: '2026-08-08',
    dayStart: 1_786_147_200,
    spentUsdc: '100',
    inputTokens: '0',
    outputTokens: '0',
  }]);
});

test('unavailable local history identifies an unreachable buyer', () => {
  assert.deepEqual(unavailableLocalBuyerSpendHistory(), {
    available: false,
    source: 'local',
    unavailableReason: 'buyer-unreachable',
    days: [],
  });
});
