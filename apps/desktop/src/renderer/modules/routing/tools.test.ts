import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow, PeerEntry } from '../../core/state';
import type { LogEvent, RuntimeProcessState, SystemProxyProfileSummary } from '../../types/bridge';
import {
  activeProfilesFromRuntimeState,
  buildVprPeerOptions,
  buildVprProfileTraffic,
  resolveVprToolRoute,
  resolveVprToolRouteForPeerOptions,
} from './tools.js';

function peer(overrides: Partial<PeerEntry> = {}): PeerEntry {
  return {
    peerId: 'peer-1',
    displayName: 'Peer One',
    host: '127.0.0.1',
    port: 8377,
    providers: [],
    services: ['gpt-a'],
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    capacityMsgPerHour: 0,
    reputation: 0,
    onChainReputationScore: null,
    lastSeen: 0,
    lastReachedAt: null,
    source: 'test',
    online: true,
    ...overrides,
  };
}

function row(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const peerId = overrides.peerId ?? 'peer-1';
  const serviceId = overrides.serviceId ?? 'gpt-b';
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
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
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
    onChainReputationScore: null,
    washFlagged: null,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    selectionValue: `${provider}\u0001${serviceId}\u0001${peerId}`,
    ...overrides,
  };
}

test('buildVprPeerOptions merges lastPeers and discoverRows service lists', () => {
  const [option] = buildVprPeerOptions([peer()], [row()]);

  assert.equal(option?.peerId, 'peer-1');
  assert.deepEqual(option?.services.sort(), ['gpt-a', 'gpt-b']);
});

test('buildVprProfileTraffic maps response lines by source profile name', () => {
  const profiles: SystemProxyProfileSummary[] = [{
    name: 'standard',
    displayName: 'Standard',
    kind: 'proxy',
    method: 'Proxy',
    domains: ['example.test'],
  }];
  const logs: LogEvent[] = [{
    mode: 'system-proxy',
    stream: 'stdout',
    line: '← 502 example.test | source:standard | request',
    timestamp: 123,
  }];

  assert.equal(buildVprProfileTraffic(logs, profiles).get('standard')?.lastStatus, 502);
});

test('activeProfilesFromRuntimeState returns null when metadata is missing', () => {
  const state: RuntimeProcessState = { mode: 'system-proxy', running: true };

  assert.equal(activeProfilesFromRuntimeState(state), null);
});

test('resolveVprToolRoute returns override values when present and defaults otherwise', () => {
  assert.deepEqual(
    resolveVprToolRoute({ profile: { peerId: 'override-peer', model: 'override-model' } }, 'profile', {
      peerId: 'default-peer',
      model: 'default-model',
    }),
    { peerId: 'override-peer', model: 'override-model' },
  );
  assert.deepEqual(
    resolveVprToolRoute({}, 'profile', { peerId: 'default-peer', model: 'default-model' }),
    { peerId: 'default-peer', model: 'default-model' },
  );
});

test('resolveVprToolRouteForPeerOptions does not mix a tool peer with an invalid default model', () => {
  assert.deepEqual(
    resolveVprToolRouteForPeerOptions(
      { profile: { peerId: 'peer-2', model: '' } },
      'profile',
      { peerId: 'peer-1', model: 'deepseek-v4-pro' },
      [
        { peerId: 'peer-1', label: 'Peer One', services: ['deepseek-v4-pro'], online: true },
        { peerId: 'peer-2', label: 'Peer Two', services: ['claude-sonnet'], online: true },
      ],
    ),
    { peerId: 'peer-2', model: 'claude-sonnet' },
  );
});

test('resolveVprToolRouteForPeerOptions keeps a valid explicit tool model', () => {
  assert.deepEqual(
    resolveVprToolRouteForPeerOptions(
      { profile: { peerId: 'peer-2', model: 'claude-haiku' } },
      'profile',
      { peerId: 'peer-1', model: 'deepseek-v4-pro' },
      [
        { peerId: 'peer-1', label: 'Peer One', services: ['deepseek-v4-pro'], online: true },
        { peerId: 'peer-2', label: 'Peer Two', services: ['claude-sonnet', 'claude-haiku'], online: true },
      ],
    ),
    { peerId: 'peer-2', model: 'claude-haiku' },
  );
});
