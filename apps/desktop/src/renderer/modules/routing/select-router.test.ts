import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createInitialUiState } from '../../core/state';
import { initStore } from '../../core/store';
import { createDesktopRouterSelection } from '../../../shared/routing-selection';
import { loadVprRouterSettings, loadVprRouteSelection } from './preferences';
import { selectVprRouter, updateVprRouterSettings } from './select-router';

const service = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' };
const model = { provider: 'openai', serviceId: 'model-a' };
const chat = { handleServiceChange: vi.fn(), endProvisionalDefaultModel: vi.fn() };

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

test.each([0, 10, undefined])('autosave and reselection preserve IRP tradeoff %s', (costQualityTradeoff) => {
  const state = createInitialUiState();
  initStore(state);
  updateVprRouterSettings(undefined, state, service, 5, [model]);
  updateVprRouterSettings(undefined, state, service, costQualityTradeoff, [model]);
  selectVprRouter(undefined, state, chat, service);
  assert.equal(state.vprRouteSelection.router?.costQualityTradeoff, costQualityTradeoff);
  assert.deepEqual(state.vprRouteSelection.router?.allowedModels, [model]);
});

test('inactive-router settings persist without selecting it and are used by the picker later', () => {
  const state = createInitialUiState();
  initStore(state);
  const previous = state.vprRouteSelection;
  const bridge = { chatSetBuyerDefaultRoute: vi.fn(async () => ({ ok: true })) };
  updateVprRouterSettings(bridge, state, service, 9, [model]);
  assert.equal(state.vprRouteSelection, previous);
  assert.equal(bridge.chatSetBuyerDefaultRoute.mock.calls.length, 0);
  assert.deepEqual(loadVprRouterSettings(service), createDesktopRouterSelection(service, 9, [model]));
  const restarted = createInitialUiState();
  initStore(restarted);
  selectVprRouter(bridge, restarted, chat, service);
  assert.deepEqual(restarted.vprRouteSelection.router, createDesktopRouterSelection(service, 9, [model]));
  assert.equal(chat.handleServiceChange.mock.calls.length, 0);
});

test('editing a different router does not replace the selected router or its settings', () => {
  const state = createInitialUiState();
  state.vprRouteSelection.router = createDesktopRouterSelection(service, 5);
  initStore(state);
  const previous = state.vprRouteSelection;
  const other = { ...service, peerId: 'e'.repeat(40) };
  updateVprRouterSettings(undefined, state, other, 1, []);
  assert.equal(state.vprRouteSelection, previous);
  assert.equal(loadVprRouterSettings(service), null);
  assert.equal(loadVprRouterSettings(other)?.allowedModels, undefined);
});

test('active edits sync automatically without reselecting chats or restarting connected profiles', async () => {
  const state = createInitialUiState();
  state.vprRouteSelection.router = createDesktopRouterSelection(service, 5);
  initStore(state);
  const bridge = { chatSetBuyerDefaultRoute: vi.fn(async () => ({ ok: true })), systemProxyStart: vi.fn() };
  updateVprRouterSettings(bridge, state, service, 7, [model]);
  await vi.waitFor(() => assert.equal(state.vprRouteError, null));
  assert.deepEqual(bridge.chatSetBuyerDefaultRoute.mock.calls[0], [{ selection: {
    kind: 'router', ...createDesktopRouterSelection(service, 7, [model]),
  } }]);
  assert.equal(bridge.systemProxyStart.mock.calls.length, 0);
  assert.equal(chat.handleServiceChange.mock.calls.length, 0);
  assert.deepEqual(loadVprRouteSelection(createInitialUiState().vprRouteSelection), state.vprRouteSelection);
});

test('empty selections reset to all models through autosave and reselection', () => {
  const state = createInitialUiState();
  initStore(state);
  updateVprRouterSettings(undefined, state, service, undefined, []);
  selectVprRouter(undefined, state, chat, service);
  assert.equal(state.vprRouteSelection.router?.allowedModels, undefined);
  updateVprRouterSettings(undefined, state, service, undefined, undefined);
  assert.equal(state.vprRouteSelection.router?.allowedModels, undefined);
  assert.equal(loadVprRouterSettings(service)?.allowedModels, undefined);
  selectVprRouter(undefined, state, chat, service);
  assert.equal(state.vprRouteSelection.router?.allowedModels, undefined);
});

test('failed autosave sync reports an error and the next edit can recover', async () => {
  const state = createInitialUiState();
  state.vprRouteSelection.router = createDesktopRouterSelection(service, 5);
  initStore(state);
  const bridge = { chatSetBuyerDefaultRoute: vi.fn()
    .mockResolvedValueOnce({ ok: false, error: 'Router unavailable' })
    .mockResolvedValueOnce({ ok: true }) };
  updateVprRouterSettings(bridge, state, service, 7);
  await vi.waitFor(() => assert.equal(state.vprRouteError, 'Router unavailable'));
  updateVprRouterSettings(bridge, state, service, 9);
  await vi.waitFor(() => assert.equal(state.vprRouteError, null));
  assert.deepEqual(loadVprRouterSettings(service)?.costQualityTradeoff, 9);
});

test('rapid edits ignore an older failed response after the newer selection succeeds', async () => {
  const state = createInitialUiState();
  state.vprRouteSelection.router = createDesktopRouterSelection(service, 5);
  initStore(state);
  let completeOld!: (result: { ok: boolean; error: string }) => void;
  const bridge = { chatSetBuyerDefaultRoute: vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve; }))
    .mockResolvedValueOnce({ ok: true }) };
  updateVprRouterSettings(bridge, state, service, 7, []);
  updateVprRouterSettings(bridge, state, service, 9, [model]);
  completeOld({ ok: false, error: 'Stale response' });
  await vi.waitFor(() => assert.equal(state.vprRouteError, null));
  assert.deepEqual(state.vprRouteSelection.router, createDesktopRouterSelection(service, 9, [model]));
});

test('storage failures do not silently apply unpersisted settings', () => {
  const state = createInitialUiState();
  state.vprRouteSelection.router = createDesktopRouterSelection(service, 5);
  initStore(state);
  const previous = state.vprRouteSelection;
  vi.stubGlobal('localStorage', { setItem: () => { throw new Error('Storage full'); } });
  assert.throws(() => updateVprRouterSettings(undefined, state, service, 9), /Storage full/);
  assert.equal(state.vprRouteSelection, previous);
});
