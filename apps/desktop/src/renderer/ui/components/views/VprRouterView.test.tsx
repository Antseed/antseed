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
import type { RouterAllowedModel } from '../../../../shared/routing-selection';
import { normalizeDiscoverRow } from '../../../modules/catalog/discover-rows';
import { projectRowsToVprModelCatalog } from '../../../modules/catalog/model-catalog';

function createRoutingCatalog(models: RouterAllowedModel[]) {
  return { models };
}

const { selectRouter } = vi.hoisted(() => ({ selectRouter: vi.fn() }));
vi.mock('../../hooks/useActions', () => ({ useActions: () => ({ selectVprRouter: selectRouter }) }));
const irpOptions = [{ key: 'cost_quality_tradeoff', type: 'integer' as const, label: 'Cost vs. quality',
  description: '0 picks the best quality regardless of price; 10 picks the cheapest acceptable model.', minimum: 0, maximum: 10, default: 5 }];

const service = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route', label: 'Test Levanto', priceMicroUsdc: '1000',
  protocol: 'irp-suggest', options: irpOptions, catalog: createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }]) };
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
  state.vprRouteSelection.router = { service, options: undefined, allowedModels };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(markup, /Choose which supported models this router can use\. If the router returns no allowed model, the request fails\./);
  assert.doesNotMatch(markup, /models? selected\.|including newly advertised ones/);
});

test.each([[0, '0'], [8, '8'], [undefined, '5']] as const)('router settings render the router\'s advertised options (%s)', (tradeoff, shown) => {
  const state = createInitialUiState();
  const withOptions = service;
  state.vprRoutingServices = [withOptions];
  state.vprRouteSelection.router = { service, ...(tradeoff === undefined ? {} : { options: { cost_quality_tradeoff: tradeoff } }) };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={withOptions} />);
  assert.match(markup, />Router settings</);
  assert.match(markup, /id="router-option-cost_quality_tradeoff"[^>]*>Cost vs\. quality<\/h3>/);
  assert.match(markup, /type="range"[^>]*min="0"[^>]*max="10"/);
  assert.match(markup, new RegExp(`>${shown}</span>`));
  assert.equal(markup.includes("The router&#x27;s default."), tradeoff === undefined);
  assert.equal(markup.includes("Use the router&#x27;s default"), tradeoff !== undefined);
});

test('a router that advertises no options shows no settings', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  initStore(state);
  const bare = { ...service, protocol: undefined, options: undefined };
  state.vprRoutingServices = [bare];
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={bare} />);
  assert.doesNotMatch(markup, /Router settings|type="range"/);
});

test('Models lists a router with the same row structure and a Router tag', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  initStore(state);
  const markup = renderToStaticMarkup(<VprExploreView />);
  assert.match(markup, />Levanto</);
  assert.match(markup, />Test Levanto</);
  assert.match(markup, />Router</);
  assert.doesNotMatch(markup, /aria-label="Routing services"/);
  assert.equal(markup.split(`class="${rowStyles.list}"`).length - 1, 1);
  assert.doesNotMatch(markup, /No models match/);
  assert.equal(selectRouter.mock.calls.length, 0);
});

test('the top-right button stays selection-only even when applying settings fails', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  state.vprRouteSelection.router = { service, options: undefined };
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
  assert.match(markup, /Cost vs\. quality/);
  assert.match(markup, /Use router/);
  assert.match(markup, />5<\/span>/);
  assert.match(markup, /Allowed models/);
  assert.doesNotMatch(markup, /Chooses a model for each request from the models you allow/);
  assert.doesNotMatch(markup, /levanto \/ route/);
  assert.ok(!markup.includes(service.peerId));
  assert.match(markup, /type="checkbox"[^>]*checked=""/);
  assert.deepEqual(state.vprRouteSelection, previous);
  assert.equal(selectRouter.mock.calls.length, 0);
});

test('saved preferences remain visible and unavailable routers cannot be applied', () => {
  const state = createInitialUiState();
  state.vprRouteSelection.router = { service, options: { cost_quality_tradeoff: 0 } };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={service} />);
  // Settings come from the router's advertised options, so an undiscovered router shows none.
  assert.doesNotMatch(markup, /Router settings/);
  assert.match(markup, /This router is unavailable/);
  assert.match(markup, /disabled=""/);
  assert.doesNotMatch(markup, /\/completed request/);
});

test('empty and stale selections show all models without a previously-selected section', () => {
  const state = createInitialUiState();
  state.chatDiscoverRowsLoaded = true;
  state.vprRoutingServices = [service];
  state.vprRouteSelection.router = { service, options: { cost_quality_tradeoff: 5 }, allowedModels: [] };
  initStore(state);
  const empty = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.doesNotMatch(empty, /Select at least one model/);
  assert.match(empty, /type="checkbox"[^>]*checked=""/);
  state.vprRouteSelection.router.allowedModels = [{ provider: 'openai', serviceId: 'missing-model' }];
  initStore(state);
  const missing = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.doesNotMatch(missing, /Previously selected models|missing-model/);
  assert.match(missing, /type="checkbox"[^>]*checked=""/);
});

test('unknown catalogs never claim support for the entire network', () => {
  const state = createInitialUiState();
  const withoutCatalog = { ...service, catalog: undefined };
  state.vprRoutingServices = [withoutCatalog];
  initStore(state);
  const unknown = renderToStaticMarkup(<VprRouterView service={withoutCatalog} />);
  assert.match(unknown, /Router models are not available yet/);
  assert.doesNotMatch(unknown, /All supported models/);
});

test('an unset option displays the router default without persisting an explicit value', () => {
  const state = createInitialUiState();
  state.vprRoutingServices = [service];
  state.vprRouteSelection.router = { service, options: undefined };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={service} />);
  assert.match(markup, />5<\/span>/);
  assert.match(markup, /The router&#x27;s default\./);
  assert.deepEqual(state.vprRouteSelection.router.options, undefined);
});

test('catalog intersection excludes unsupported providers and drops stale selections from display', () => {
  const state = createInitialUiState();
  state.chatDiscoverRowsLoaded = true;
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
  state.vprRouteSelection.router = { service: catalogService, options: { cost_quality_tradeoff: 5 },
    allowedModels: [{ provider: 'openai', serviceId: 'removed-model' }] };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={catalogService} />);
  assert.doesNotMatch(markup, /unsupported-provider/);
  assert.doesNotMatch(markup, /offline-model|removed-model|Previously selected models|No selected supported models/);
  assert.equal((markup.match(/role="checkbox" aria-checked="true"/g) ?? []).length, 1);
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
  state.vprRouteSelection.router = { service: catalogService, options: { cost_quality_tradeoff: 5 }, allowedModels: [models[0]!] };
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterView service={catalogService} />);
  assert.equal((markup.match(/role="checkbox" aria-checked="true"/g) ?? []).length, 1);
  assert.equal((markup.match(/role="checkbox" aria-checked="false"/g) ?? []).length, 1);
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
  assert.doesNotMatch(markup, /No selected supported models/);
  assert.equal((markup.match(/role="checkbox" aria-checked="true"/g) ?? []).length, 1);
});
