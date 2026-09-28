import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { setVprModelPageTarget, setVprRouterPageTarget } from '../../../modules/catalog/model-page-target';
import { VprModelView } from './VprModelView';
import { VprRouterView } from './VprRouterView';
import { VprExploreView } from './VprExploreView';
import rowStyles from '../vpr/VprModelRows.module.scss';
import type { RoutingCatalogV1 } from '@antseed/node';
import { normalizeDiscoverRow } from '../../../modules/catalog/discover-rows';
import { projectRowsToVprModelCatalog } from '../../../modules/catalog/model-catalog';

let catalogRevision = 0;
function createRoutingCatalog(models: RoutingCatalogV1['models'], preferencesSchema: RoutingCatalogV1['preferencesSchema'] = { type: 'object', properties: {}, additionalProperties: false }, options: { title?: string } = {}): RoutingCatalogV1 {
  return { version: 1, revision: `test-catalog-${++catalogRevision}`, models, preferencesSchema, ...options };
}

const { selectRouter } = vi.hoisted(() => ({ selectRouter: vi.fn() }));
vi.mock('../../hooks/useActions', () => ({ useActions: () => ({ selectVprRouter: selectRouter }) }));
const service = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route', label: 'Test Levanto', priceMicroUsdc: '1000',
  catalog: createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }], {
    type: 'object', additionalProperties: false, properties: {
      strategy: { type: 'string', enum: ['balanced', 'fast'], default: 'balanced', description: 'Choose a strategy' },
      region: { type: 'string', enum: ['eu', 'us'], description: 'Preferred region' },
    },
  }) };
afterEach(() => { setVprModelPageTarget('openai', 'test'); selectRouter.mockClear(); });

test.each(['0', '1000'])('router detail only shows billing units for paid pricing (%s)', (priceMicroUsdc) => {
  const state = createInitialUiState();
  const pricedService = { ...service, priceMicroUsdc };
  state.vprRoutingServices = [pricedService];
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={pricedService} />);
  assert.match(markup, /aria-label="About router pricing"/);
  assert.doesNotMatch(markup, /Model inference is billed separately/);
  if (priceMicroUsdc === '0') {
    assert.match(markup, />Free</);
    assert.doesNotMatch(markup, /\/completed request/);
  } else {
    assert.match(markup, /\$0\.001/);
    assert.match(markup, /\/completed request/);
  }
});

test.each([
  { selection: 'all', allowedModels: undefined },
  { selection: 'none', allowedModels: [] },
  { selection: 'one', allowedModels: [{ provider: 'openai', serviceId: 'model-a' }] },
])('allowed-models info stays the same with $selection selected', ({ allowedModels }) => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  state.vprRouteSelection.router = { service, preferences: {}, allowedModels };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(markup, /Choose which supported models this router can use\. If the router returns no allowed model, the request fails\./);
  assert.doesNotMatch(markup, /models? selected\.|including newly advertised ones/);
});

test('router-provided titles and descriptions replace wire keys without hardcoded labels', () => {
  const state = createInitialUiState();
  const titledService = { ...service, catalog: createRoutingCatalog([], {
    type: 'object', additionalProperties: false, properties: {
      cqt: { type: 'string', enum: ['5'], default: '5', title: 'Cost quality', description: 'Balance cost and quality.' },
      strategy: { type: 'string', enum: ['fast'], title: 'Response speed', description: '<script>untrusted</script>' },
    },
  }) };
  state.vprRoutingServices = [titledService];
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={titledService} />);
  assert.match(markup, /<h3>Cost quality<\/h3>/);
  assert.match(markup, /aria-label="Cost quality"/);
  assert.match(markup, /Balance cost and quality\./);
  assert.match(markup, /<h3>Response speed<\/h3>/);
  assert.match(markup, /&lt;script&gt;untrusted&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<h3>cqt<|<h3>strategy<|<script>/);
});

test('Models lists a router with the same row structure and a Router tag', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  initStore(state);
  const markup = renderToStaticMarkup(<VprExploreView />);
  assert.match(markup, /Test Levanto/);
  assert.match(markup, />Router</);
  assert.doesNotMatch(markup, /aria-label="Routing services"/);
  assert.equal(markup.split(`class="${rowStyles.list}"`).length - 1, 1);
  assert.doesNotMatch(markup, /No models match/);
  assert.equal(selectRouter.mock.calls.length, 0);
});

test('the top-right button stays selection-only even when applying settings fails', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  state.vprRouteSelection.router = { service, preferences: {} };
  state.vprRouteError = 'Router unavailable';
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(markup, /aria-label="Selected router" disabled=""/);
  assert.match(markup, /Could not apply router settings: Router unavailable/);
  assert.doesNotMatch(markup, /Save settings|>Save</);
});

test('browsing router detail shows settings without changing the selected model', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  const previous = structuredClone(state.vprRouteSelection);
  initStore(state);
  setVprRouterPageTarget(service);
  const markup = renderToStaticMarkup(<VprModelView />);
  assert.match(markup, /Choose a strategy/);
  assert.match(markup, /Use router/);
  assert.match(markup, />balanced</);
  assert.match(markup, /Preferred region/);
  assert.doesNotMatch(markup, /cqt|Cost \/ quality|Higher quality|Lower cost/);
  assert.match(markup, /Allowed models/);
  assert.doesNotMatch(markup, /Chooses a model for each request from the models you allow/);
  assert.doesNotMatch(markup, /levanto \/ route/);
  assert.ok(!markup.includes(service.peerId));
  assert.match(markup, /type="checkbox" checked=""/);
  assert.deepEqual(state.vprRouteSelection, previous);
  assert.equal(selectRouter.mock.calls.length, 0);
});

test('saved preferences remain visible and unavailable routers cannot be applied', () => {
  const state = createInitialUiState();
  state.vprRouteSelection.router = { service, preferences: { strategy: 'fast' } };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(markup, /strategy.*fast/);
  assert.match(markup, /This router is unavailable/);
  assert.match(markup, /disabled=""/);
  assert.doesNotMatch(markup, /\/completed request/);
});

test('empty allowlist cannot be applied and unavailable selected models remain visible', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  state.vprRouteSelection.router = { service, preferences: { cqt: '5' }, allowedModels: [] };
  initStore(state);
  const empty = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(empty, /Select at least one model/);
  assert.match(empty, /disabled=""/);
  state.vprRouteSelection.router.allowedModels = [{ provider: 'openai', serviceId: 'missing-model' }];
  initStore(state);
  const missing = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(missing, /Previously selected models not currently available/);
  assert.match(missing, /missing-model/);
});

test('unknown and stale catalogs never claim support for the entire network', () => {
  const state = createInitialUiState();
  const withoutCatalog = { ...service, catalog: undefined };
  state.vprRoutingServices = [withoutCatalog];
  initStore(state);
  const unknown = renderToStaticMarkup(<VprRouterView service={withoutCatalog} />);
  assert.match(unknown, /does not publish its supported models/);
  assert.doesNotMatch(unknown, /All supported models/);
  state.vprRoutingServices = [{ ...service, catalogExpiresAt: 1 }];
  initStore(state);
  const stale = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(stale, /catalog is stale/);
  assert.match(stale, /disabled=""/);
  assert.match(stale, /model-a/);
});

test('required choices and changed schemas keep saved values visible for correction', () => {
  const state = createInitialUiState();
  const required = { ...service, catalog: createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }], {
    type: 'object', additionalProperties: false, required: ['region'], properties: {
      region: { type: 'string', enum: ['eu', 'us'] },
    },
  }) };
  state.vprRoutingServices = [required];
  initStore(state);
  const empty = renderToStaticMarkup(<VprRouterView service={required} />);
  assert.match(empty, /Choose a value for region/);
  state.vprRouteSelection.router = { service: required, preferences: { region: 'removed', strategy: 'fast' } };
  initStore(state);
  const changed = renderToStaticMarkup(<VprRouterView service={required} />);
  assert.match(changed, /removed \(unavailable\)/);
  assert.match(changed, /Remove strategy/);
  assert.match(changed, /Choose an advertised value for region/);
  assert.deepEqual(state.vprRouteSelection.router.preferences, { region: 'removed', strategy: 'fast' });
});

test('saved empty preferences display advertised defaults without adding hardcoded settings', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  state.vprRouteSelection.router = { service, preferences: {} };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(markup, />balanced</);
  assert.doesNotMatch(markup, /cqt|Quality focused/);
  assert.deepEqual(state.vprRouteSelection.router.preferences, {});
});

test('catalog intersection excludes unsupported providers and keeps unavailable selections visible', () => {
  const state = createInitialUiState();
  const catalogService = { ...service, catalog: createRoutingCatalog([
    { provider: 'openai', serviceId: 'model-a' }, { provider: 'openai', serviceId: 'offline-model' },
  ]) };
  state.vprRoutingServices = [catalogService];
  const rows = ['openai', 'unsupported-provider'].map(provider => normalizeDiscoverRow({
    peerId: 'seller', serviceId: 'model-a', provider, protocol: 'openai-chat-completions',
    inputUsdPerMillion: 0, outputUsdPerMillion: 0, effectiveReputationScore: 90,
  }));
  assert.ok(rows[0] && rows[1]);
  state.vprRoutableRows = [rows[0], rows[1]];
  state.vprModelCatalog = projectRowsToVprModelCatalog([rows[0], rows[1]]);
  state.vprRouteSelection.router = { service: catalogService, preferences: { cqt: '5' },
    allowedModels: [{ provider: 'openai', serviceId: 'removed-model' }] };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={catalogService} />);
  assert.doesNotMatch(markup, /unsupported-provider/);
  assert.match(markup, /offline-model/);
  assert.match(markup, /removed-model/);
  assert.match(markup, /No selected supported models are currently available/);
  assert.deepEqual(state.vprRouteSelection.router.allowedModels, [{ provider: 'openai', serviceId: 'removed-model' }]);
});

test('checkbox identity distinguishes provider and model IDs containing separators', () => {
  const state = createInitialUiState();
  const models = [{ provider: 'a:b', serviceId: 'c' }, { provider: 'a', serviceId: 'b:c' }];
  const catalogService = { ...service, catalog: createRoutingCatalog(models) };
  state.vprRoutingServices = [catalogService];
  const rows = models.map(model => normalizeDiscoverRow({
    ...model, peerId: 'seller', protocol: 'openai-chat-completions',
    inputUsdPerMillion: 0, outputUsdPerMillion: 0, effectiveReputationScore: 90,
  }));
  assert.ok(rows[0] && rows[1]);
  state.vprRoutableRows = [rows[0], rows[1]];
  state.vprModelCatalog = projectRowsToVprModelCatalog([rows[0], rows[1]]);
  state.vprRouteSelection.router = { service: catalogService, preferences: { cqt: '5' }, allowedModels: [models[0]!] };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={catalogService} />);
  assert.equal((markup.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.equal((markup.match(/aria-checked="false"/g) ?? []).length, 1);
});

test('supported exact providers remain selectable even when the main model catalog groups them together', () => {
  const state = createInitialUiState();
  const models = [{ provider: 'cheap-provider', serviceId: 'gpt-4.1' }, { provider: 'supported-provider', serviceId: 'gpt-4.1' }];
  const catalogService = { ...service, catalog: createRoutingCatalog([models[1]!]) };
  state.vprRoutingServices = [catalogService];
  const rows = models.map((model, index) => normalizeDiscoverRow({
    ...model, peerId: `seller-${index}`, protocol: 'openai-chat-completions',
    inputUsdPerMillion: index, outputUsdPerMillion: index, effectiveReputationScore: 90,
  }));
  assert.ok(rows[0] && rows[1]);
  state.vprRoutableRows = [rows[0], rows[1]];
  state.vprModelCatalog = projectRowsToVprModelCatalog(state.vprRoutableRows);
  assert.equal(state.vprModelCatalog.length, 1);
  assert.equal(state.vprModelCatalog[0]!.provider, 'cheap-provider');
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={catalogService} />);
  assert.doesNotMatch(markup, /No selected supported models|Supported but not currently available/);
  assert.equal((markup.match(/aria-checked="true"/g) ?? []).length, 1);
});
