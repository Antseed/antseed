import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  ChatServiceOptionEntry,
  DiscoverRow,
  VprRouteSelection,
  VprRoutingPreferences,
} from '../../core/state';
import { findChatOptionForVprSelection, resolveVprChatOption } from './projection.js';

function option(overrides: Partial<ChatServiceOptionEntry> = {}): ChatServiceOptionEntry {
  return {
    id: 'gpt-test',
    label: 'GPT Test',
    provider: 'openai',
    protocol: 'openai-chat-completions',
    count: 1,
    value: 'openai\u0001gpt-test\u0001peer-1',
    peerId: 'peer-1',
    peerDisplayName: null,
    peerLabel: 'peer-1',
    peerIconUrl: null,
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    cachedInputUsdPerMillion: null,
    categories: [],
    description: '',
    ...overrides,
  };
}

const autoSelection: VprRouteSelection = {
  model: { provider: 'openai', serviceId: 'gpt-test', label: 'GPT Test', categories: [] },
  mode: 'auto',
  peerId: null,
};

test('returns null when AI VPN selection has no model', () => {
  assert.equal(findChatOptionForVprSelection([option()], { model: null, mode: 'auto', peerId: null }), null);
});

test('auto mode returns the first matching provider and service option', () => {
  const match = option({ peerId: 'peer-2', value: 'openai\u0001gpt-test\u0001peer-2' });

  assert.equal(findChatOptionForVprSelection([match], autoSelection), match);
});

test('pinned peer mismatch returns null', () => {
  assert.equal(
    findChatOptionForVprSelection([option({ peerId: 'peer-2' })], { ...autoSelection, mode: 'pinned-peer', peerId: 'peer-1' }),
    null,
  );
});

const preferences: VprRoutingPreferences = {
  autoRouting: true,
  preferFreePeers: false,
  maxInputUsdPerMillion: 10,
  minTrustScore: 50,
  allowedPeerIds: [],
  blockedPeerIds: [],
};

function discoverRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const peerId = overrides.peerId ?? 'peer-1';
  const serviceId = overrides.serviceId ?? 'gpt-test';
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
    selectionValue: `${provider}${serviceId}${peerId}`,
    ...overrides,
  };
}

test('auto mode resolves the preference-best peer, not the first option', () => {
  const expensiveFirst = option({ peerId: 'peer-expensive', value: 'openaigpt-testpeer-expensive' });
  const cheap = option({ peerId: 'peer-cheap', value: 'openaigpt-testpeer-cheap' });
  const rows = [
    discoverRow({ peerId: 'peer-expensive', inputUsdPerMillion: 8, outputUsdPerMillion: 8 }),
    discoverRow({ peerId: 'peer-cheap', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }),
  ];

  assert.equal(
    resolveVprChatOption([expensiveFirst, cheap], rows, autoSelection, preferences),
    cheap,
  );
});

test('auto mode falls back to the first matching option when no rows exist', () => {
  const only = option();

  assert.equal(resolveVprChatOption([only], [], autoSelection, preferences), only);
});

test('auto mode does not bypass the minimum reputation gate', () => {
  const lowReputation = option();
  const rows = [discoverRow({
    effectiveReputationScore: 49,
    onChainReputationScore: 49,
  })];

  assert.equal(
    resolveVprChatOption([lowReputation], rows, autoSelection, preferences),
    null,
  );
});

test('pinned mode still requires the exact peer', () => {
  const other = option({ peerId: 'peer-2', value: 'openaigpt-testpeer-2' });
  const rows = [discoverRow({ peerId: 'peer-2' })];

  assert.equal(
    resolveVprChatOption([other], rows, { ...autoSelection, mode: 'pinned-peer', peerId: 'peer-1' }, preferences),
    null,
  );
});

const NOW = 1_700_000_000_000;

test('auto mode skips an excluded peer', () => {
  const a = option({ peerId: 'peer-a', value: 'openaigpt-testpeer-a' });
  const b = option({ peerId: 'peer-b', value: 'openaigpt-testpeer-b' });
  const rows = [
    discoverRow({ peerId: 'peer-a', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }),
    discoverRow({ peerId: 'peer-b', inputUsdPerMillion: 5, outputUsdPerMillion: 5 }),
  ];

  // peer-a is cheaper and would normally win; excluding it moves us to peer-b.
  assert.equal(
    resolveVprChatOption([a, b], rows, autoSelection, preferences, { excludePeerIds: ['peer-a'], now: NOW }),
    b,
  );
});

test('auto mode falls back to the full candidate set when exclusion empties it', () => {
  const a = option({ peerId: 'peer-a', value: 'openaigpt-testpeer-a' });
  const rows = [discoverRow({ peerId: 'peer-a' })];

  // Better to retry the peer that just failed than to refuse to dispatch.
  assert.equal(
    resolveVprChatOption([a], rows, autoSelection, preferences, { excludePeerIds: ['peer-a'], now: NOW }),
    a,
  );
});

test('auto mode prefers a healthy peer over a cooling-down one', () => {
  const cooling = option({ peerId: 'peer-cooling', value: 'openaigpt-testpeer-cooling' });
  const healthy = option({ peerId: 'peer-healthy', value: 'openaigpt-testpeer-healthy' });
  const rows = [
    discoverRow({ peerId: 'peer-cooling', inputUsdPerMillion: 1, outputUsdPerMillion: 1, peerCooldownUntil: NOW + 30_000 }),
    discoverRow({ peerId: 'peer-healthy', inputUsdPerMillion: 9, outputUsdPerMillion: 9 }),
  ];

  assert.equal(
    resolveVprChatOption([cooling, healthy], rows, autoSelection, preferences, { now: NOW }),
    healthy,
  );
});

test('pinned mode ignores both exclusions and cooldowns', () => {
  const pinned = option({ peerId: 'peer-1' });
  const rows = [discoverRow({ peerId: 'peer-1', peerCooldownUntil: NOW + 30_000 })];

  // The user chose this peer. Failover must never quietly move them off it.
  assert.equal(
    resolveVprChatOption(
      [pinned], rows,
      { ...autoSelection, mode: 'pinned-peer', peerId: 'peer-1' },
      preferences,
      { excludePeerIds: ['peer-1'], now: NOW },
    ),
    pinned,
  );
});
