import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createInitialUiState, type DiscoverRow, type VprRouteSelection } from '../../core/state.js';
import { buyerDefaultRoutePayload, syncBuyerDefaultRoute, type VprRouteTarget } from './proxy-sync.js';

const model = {
  provider: 'openai',
  serviceId: 'gpt-5.6-sol',
  label: 'GPT 5.6 Sol',
  categories: [],
};

const target: VprRouteTarget = {
  peerId: 'a'.repeat(40),
  model: 'openai-gpt-56-sol',
  servedModels: ['openai-gpt-56-sol'],
};

test('desktop Auto syncs a model-only buyer route', () => {
  const selection: VprRouteSelection = { model, mode: 'auto', peerId: null };
  assert.deepEqual(buyerDefaultRoutePayload(selection, target), {
    service: 'openai-gpt-56-sol',
  });
});

test('desktop pinned mode syncs the selected peer and its advertised service id', () => {
  const selection: VprRouteSelection = { model, mode: 'pinned-peer', peerId: target.peerId };
  assert.deepEqual(buyerDefaultRoutePayload(selection, target), {
    peerId: target.peerId,
    service: 'openai-gpt-56-sol',
  });
});

test('desktop Auto replaces a stale coding-only selection with an unrestricted route', async () => {
  const uiState = createInitialUiState();
  const row = (serviceId: string, peerId: string, effectiveReputationScore: number): DiscoverRow => ({
    rowKey: `${peerId}:${serviceId}`,
    serviceId,
    serviceLabel: serviceId,
    categories: [],
    provider: 'openai',
    protocol: 'openai-chat-completions',
    peerId,
    peerEvmAddress: '',
    sellerContract: null,
    verificationLinks: [],
    peerIconUrl: null,
    peerDisplayName: null,
    peerLabel: peerId,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
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
    effectiveReputationScore,
    onChainReputationScore: effectiveReputationScore,
    washFlagged: null,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    peerCooldownUntil: null,
    peerFailureStreak: 0,
    peerLastFailureReason: null,
    selectionValue: `openai\u0001${serviceId}\u0001${peerId}`,
  });
  uiState.vprRouteSelection = {
    model: { provider: 'openai', serviceId: 'fable-5-coding-only', label: 'Claude Fable 5', categories: [] },
    mode: 'auto',
    peerId: null,
  };
  uiState.vprModelCatalog = [{
    provider: 'openai',
    serviceId: 'claude-fable-5',
    label: 'Claude Fable 5',
    peerCount: 2,
    categories: [],
    kind: 'text',
    protocols: ['openai-chat-completions'],
    minInputUsdPerMillion: 1,
    maxInputUsdPerMillion: 1,
    minOutputUsdPerMillion: 1,
    maxOutputUsdPerMillion: 1,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    expectedSavingsPct: null,
    bestPeerId: 'full-peer',
  }];
  uiState.vprRoutableRows = [
    row('fable-5-coding-only', 'restricted-peer', 99),
    row('claude-fable-5', 'full-peer', 75),
  ];
  const payloads: unknown[] = [];

  await syncBuyerDefaultRoute({
    chatSetBuyerDefaultRoute: async (payload) => {
      payloads.push(payload);
      return { ok: true };
    },
  }, uiState);

  assert.deepEqual(payloads, [{ service: 'claude-fable-5' }]);
});
