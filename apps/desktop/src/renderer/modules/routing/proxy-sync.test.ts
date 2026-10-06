import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createInitialUiState, type DiscoverRow, type VprRouteSelection } from '../../core/state.js';
import { buyerDefaultRoutePayload, connectVprProfile, syncBuyerDefaultRoute, type VprRouteTarget } from './proxy-sync.js';
import { createDesktopRouterSelection } from '../../../shared/routing-selection.js';

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
    selection: { kind: 'model', model: 'openai-gpt-56-sol' },
  });
});

test('desktop pinned mode syncs the selected peer and its advertised service id', () => {
  const selection: VprRouteSelection = { model, mode: 'pinned-peer', peerId: target.peerId };
  assert.deepEqual(buyerDefaultRoutePayload(selection, target), {
    selection: { kind: 'model', model: `${target.peerId}@openai-gpt-56-sol` },
  });
});

test('router sync retains the exact target and preferences across empty model polls', async () => {
  const state = createInitialUiState();
  const router = createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' }, 0);
  state.vprRouteSelection = { model: null, mode: 'auto', peerId: null, router };
  const payloads: unknown[] = [];
  const bridge = { chatSetBuyerDefaultRoute: async (payload: unknown) => { payloads.push(payload); return { ok: true }; } };
  await syncBuyerDefaultRoute(bridge, state);
  state.vprModelCatalog = [];
  state.vprRoutableRows = [];
  await syncBuyerDefaultRoute(bridge, state);
  assert.deepEqual(payloads, Array.from({ length: 2 }, () => ({ selection: { kind: 'router', ...router } })));
  assert.deepEqual(state.vprRouteSelection.router, router);
});

test('failed route updates surface errors and do not claim success', async () => {
  const state = createInitialUiState();
  state.vprRouteSelection = { model: null, mode: 'auto', peerId: null,
    router: createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' }) };
  assert.equal(await syncBuyerDefaultRoute({ chatSetBuyerDefaultRoute: async () => ({ ok: false, error: 'Router unavailable' }) }, state), false);
  assert.equal(state.vprRouteError, 'Router unavailable');
});

test('connecting an app hydrates a saved router before resolving its alias target', async () => {
  const state = createInitialUiState();
  const router = createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' });
  const events: string[] = [];
  const result = await connectVprProfile({
    chatGetBuyerDefaultRoute: async () => ({ ok: true, selection: { kind: 'router', service: router.service } }),
    chatSetBuyerDefaultRoute: async (payload) => {
      assert.deepEqual(payload, { selection: { kind: 'router', ...router } });
      events.push('route');
      return { ok: true };
    },
    systemProxyStart: async (payload) => {
      assert.equal(payload.peerId, router.service.peerId);
      assert.equal(payload.defaultModel, 'antseed');
      assert.deepEqual(payload.servedModels, ['antseed']);
      events.push('start');
      return { ok: true };
    },
  }, state, 'codex');
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['route', 'start']);
});

test('an unsupported saved router fails closed without writing a model default', async () => {
  const state = createInitialUiState();
  let writes = 0;
  const result = await syncBuyerDefaultRoute({
    chatGetBuyerDefaultRoute: async () => ({ ok: true, selection: { kind: 'router', service: { peerId: 'bad', provider: 'levanto', serviceId: 'route' } } }),
    chatSetBuyerDefaultRoute: async () => { writes++; return { ok: true }; },
  }, state);
  assert.equal(result, false);
  assert.equal(writes, 0);
  assert.match(state.vprRouteError!, /unsupported/);
});

test('first sync adopts the saved buyer router instead of overwriting it with a provisional model', async () => {
  const state = createInitialUiState();
  state.vprRouteSelection = { model, mode: 'auto', peerId: null };
  const router = createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' });
  const posted: unknown[] = [];
  await syncBuyerDefaultRoute({
    chatGetBuyerDefaultRoute: async () => ({ ok: true, selection: { kind: 'router', ...router } }),
    chatSetBuyerDefaultRoute: async (payload) => { posted.push(payload); return { ok: true }; },
  }, state);
  assert.deepEqual(state.vprRouteSelection.router, router);
  assert.deepEqual(posted, [{ selection: { kind: 'router', ...router } }]);
});

test('router allowlist survives startup hydration and subsequent proxy sync', async () => {
  const state = createInitialUiState();
  const router = createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' }, 0, [{ provider: 'openai', serviceId: 'model-a' }]);
  const posted: unknown[] = [];
  await syncBuyerDefaultRoute({
    chatGetBuyerDefaultRoute: async () => ({ ok: true, selection: { kind: 'router', ...router } }),
    chatSetBuyerDefaultRoute: async payload => { posted.push(payload); return { ok: true }; },
  }, state);
  assert.deepEqual(state.vprRouteSelection.router, router);
  assert.deepEqual(posted, [{ selection: { kind: 'router', ...router } }]);
});

test('an explicit selection wins over a late startup read', async () => {
  const state = createInitialUiState();
  const first = createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' });
  const second = createDesktopRouterSelection({ peerId: 'e'.repeat(40), provider: 'levanto', serviceId: 'other' }, 0);
  const posted: unknown[] = [];
  await syncBuyerDefaultRoute({
    chatGetBuyerDefaultRoute: async () => {
      state.vprRouteHydrated = true;
      state.vprRouteSelection = { model: null, mode: 'auto', peerId: null, router: second };
      return { ok: true, selection: { kind: 'router', ...first } };
    },
    chatSetBuyerDefaultRoute: async (payload) => { posted.push(payload); return { ok: true }; },
  }, state);
  assert.deepEqual(posted, [{ selection: { kind: 'router', ...second } }]);
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

  assert.deepEqual(payloads, [{ selection: { kind: 'model', model: 'claude-fable-5' } }]);
});
