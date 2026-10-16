import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createDesktopRouterSelection, isDesktopRouterSelection, normalizeRouterAllowedModels, routerAutoModelLabel, routerDisplayName, routerSellerName } from '../../../shared/routing-selection';
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

test('desktop allowlists reject malformed entries and reset empty lists to all models', () => {
  const router = createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' }, undefined, []);
  assert.equal(router.allowedModels, undefined);
  assert.equal(isDesktopRouterSelection(router), true);
  for (const allowedModels of [null, ['model-a'], [{ provider: 'openai' }], [{ provider: '', serviceId: 'model-a' }]]) {
    assert.equal(isDesktopRouterSelection({ ...router, allowedModels }), false);
  }
});

test('stale model selections are removed, resetting to all only when no valid selection remains', () => {
  const available = [{ provider: 'openai', serviceId: 'model-a' }];
  const stale = { provider: 'openai', serviceId: 'removed-model' };
  assert.deepEqual(normalizeRouterAllowedModels([...available, stale], available), available);
  assert.equal(normalizeRouterAllowedModels([stale], available), undefined);
  assert.equal(normalizeRouterAllowedModels([], available), undefined);
  assert.equal(normalizeRouterAllowedModels(undefined, available), undefined);
  assert.deepEqual(normalizeRouterAllowedModels([stale]), [stale]);
});

test('legacy empty saved selections restore as all models', () => {
  const service = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' };
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ router: { service, allowedModels: [] } }) });
  const restored = loadVprRouteSelection(createInitialUiState().vprRouteSelection);
  assert.deepEqual(restored.router, { service });
});

test('invalid IRP tradeoffs and legacy preferences cannot be restored', () => {
  const service = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' };
  for (const options of [[], 'cheap', { nested: {} }, { n: Number.NaN }, { n: Infinity }, { n: null }]) {
    assert.equal(isDesktopRouterSelection({ service, options }), false);
  }
  assert.equal(isDesktopRouterSelection({ service, costQualityTradeoff: 5 }), false);
  for (const options of [{ cost_quality_tradeoff: 0 }, { tier: 'fast', strict: true }]) {
    assert.equal(isDesktopRouterSelection({ service, options }), true);
  }
  assert.equal(isDesktopRouterSelection({ service, preferences: { tradeoff: '9' } }), false);
  assert.equal(isDesktopRouterSelection({ service }), true);
});

test('Malformed targets are not restored as paid router selections', () => {
  for (const value of [null, {}, [], { service: null }, { service: { peerId: 'bad', provider: 'levanto', serviceId: 'route' }, options: { cost_quality_tradeoff: 5 } }]) {
    assert.equal(isDesktopRouterSelection(value), false);
  }
});

test('router picker label names the selected router, falling back while it is undiscovered', () => {
  const offer = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'levanto-route', label: 'GesundAI', priceMicroUsdc: '1000' };
  const router = createDesktopRouterSelection(offer);
  assert.equal(routerAutoModelLabel(router, [offer]), 'Levanto · Auto model');
  assert.equal(routerAutoModelLabel(router, []), 'Router · Auto model');
  assert.equal(routerAutoModelLabel(router, [{ ...offer, peerId: 'e'.repeat(40) }]), 'Router · Auto model');
});

test('router rows name the router and the seller offering it', () => {
  const offer = { peerId: 'd'.repeat(40), provider: 'default-router', serviceId: 'default-router', label: 'GesundAI', priceMicroUsdc: '0' };
  assert.equal(routerDisplayName(offer), 'Default Router');
  assert.equal(routerSellerName(offer), 'GesundAI');
  assert.equal(routerSellerName({ ...offer, label: 'default-router' }), 'dddddddd...dddd');
  assert.equal(routerSellerName({ ...offer, label: ' ' }), 'dddddddd...dddd');
});
