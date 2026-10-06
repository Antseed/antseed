import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createDesktopRouterSelection, isDesktopRouterSelection } from '../../../shared/routing-selection';
import { loadVprRouteSelection, saveVprRouteSelection, VPR_ROUTE_SELECTION_STORAGE_KEY } from './preferences';
import { createInitialUiState } from '../../core/state';

afterEach(() => vi.unstubAllGlobals());

test('router persistence round-trips IRP integer settings including both endpoints and the unset default', () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
  const offer = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route', label: 'Display only', priceMicroUsdc: '1000' };
  for (const preferences of [0, 5, 10, undefined]) {
    const router = createDesktopRouterSelection(offer, preferences, [{ provider: 'openai', serviceId: 'model-a' }]);
    assert.deepEqual(Object.keys(router.service).sort(), ['peerId', 'provider', 'serviceId']);
    const selection = { model: null, mode: 'auto' as const, peerId: null, router };
    saveVprRouteSelection(selection);
    assert.deepEqual(loadVprRouteSelection(createInitialUiState().vprRouteSelection), selection);
  }
  storage.set(VPR_ROUTE_SELECTION_STORAGE_KEY, JSON.stringify({ router: { service: offer, preferences: { strategy: 2 } } }));
  assert.deepEqual(loadVprRouteSelection(createInitialUiState().vprRouteSelection), createInitialUiState().vprRouteSelection);
});

test('desktop allowlists reject malformed entries and preserve an explicit empty list', () => {
  const router = createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' }, undefined, []);
  assert.equal(isDesktopRouterSelection(router), true);
  for (const allowedModels of [null, ['model-a'], [{ provider: 'openai' }], [{ provider: '', serviceId: 'model-a' }]]) {
    assert.equal(isDesktopRouterSelection({ ...router, allowedModels }), false);
  }
});

test('invalid IRP tradeoffs and legacy preferences cannot be restored', () => {
  const service = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' };
  for (const costQualityTradeoff of [-1, 11, 2.5, NaN, Infinity, '5', null]) {
    assert.equal(isDesktopRouterSelection({ service, costQualityTradeoff }), false);
  }
  assert.equal(isDesktopRouterSelection({ service, preferences: { tradeoff: '9' } }), false);
  assert.equal(isDesktopRouterSelection({ service }), true);
});

test('Malformed targets are not restored as paid router selections', () => {
  for (const value of [null, {}, [], { service: null }, { service: { peerId: 'bad', provider: 'levanto', serviceId: 'route' }, costQualityTradeoff: 5 }]) {
    assert.equal(isDesktopRouterSelection(value), false);
  }
});
