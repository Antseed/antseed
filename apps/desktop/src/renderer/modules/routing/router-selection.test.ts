import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createDesktopRouterSelection, isDesktopRouterSelection, routerPreferenceDefaults, routerPreferenceError } from '../../../shared/routing-selection';
import { loadVprRouteSelection, saveVprRouteSelection, VPR_ROUTE_SELECTION_STORAGE_KEY } from './preferences';
import { createInitialUiState } from '../../core/state';

afterEach(() => vi.unstubAllGlobals());

test('router persistence round-trips arbitrary text-enum settings without hardcoding fields or values', () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
  const offer = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route', label: 'Display only', priceMicroUsdc: '1000' };
  for (const preferences of [{ strategy: 'fast', region: 'eu' }, { cqt: '2' }, {}]) {
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
  const router = createDesktopRouterSelection({ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' }, {}, []);
  assert.equal(isDesktopRouterSelection(router), true);
  for (const allowedModels of [null, ['model-a'], [{ provider: 'openai' }], [{ provider: '', serviceId: 'model-a' }]]) {
    assert.equal(isDesktopRouterSelection({ ...router, allowedModels }), false);
  }
});

test('advertised defaults and required enums validate without inventing a selection', () => {
  const schema = { type: 'object' as const, additionalProperties: false as const, required: ['region'], properties: {
    strategy: { type: 'string' as const, enum: ['fast', 'balanced'], default: 'balanced' },
    region: { type: 'string' as const, enum: ['eu', 'us'] },
  } };
  assert.deepEqual(routerPreferenceDefaults(schema), { strategy: 'balanced' });
  assert.match(routerPreferenceError(schema, {})!, /region/);
  assert.equal(routerPreferenceError(schema, { region: 'eu' }), null);
  assert.match(routerPreferenceError(schema, { region: 'removed' })!, /advertised value/);
  assert.match(routerPreferenceError(schema, { oldSetting: 'x' })!, /no longer advertised/);
});

test('missing preferences and malformed targets are not restored as paid router selections', () => {
  for (const value of [null, {}, [], { service: null }, { service: { peerId: 'bad', provider: 'levanto', serviceId: 'route' }, preferences: { cqt: '5' } }]) {
    assert.equal(isDesktopRouterSelection(value), false);
  }
});
