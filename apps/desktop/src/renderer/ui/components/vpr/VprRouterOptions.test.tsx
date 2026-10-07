import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { VprRouterOptions, VprRouterRow } from './VprRouterOptions';
import { VprModelRowList } from './VprModelRows';
import rowStyles from './VprModelRows.module.scss';
import dropdownStyles from '../chat/VprModelDropdown.module.scss';

vi.mock('../../hooks/useActions', () => ({ useActions: () => ({ selectVprRouter: vi.fn() }) }));

test.each([false, true])('router menus separate routers from models with visible headings (chat=%s)', (forConversation) => {
  const state = createInitialUiState();
  state.vprRoutingServices = [{ peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route', label: 'Auto Router', priceMicroUsdc: '0' }];
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterOptions forConversation={forConversation} />);
  assert.ok(markup.includes(`class="${dropdownStyles.modelDropdownSection}">Routers</div>`));
  assert.ok(markup.includes(`class="${dropdownStyles.modelDropdownSection}">Models</div>`));
  assert.ok(markup.indexOf('>Routers<') < markup.indexOf('>Auto Router<'));
  assert.ok(markup.indexOf('>Auto Router<') < markup.indexOf('>Models<'));
});

test('browse list labels router rows without adding an empty models section', () => {
  const markup = renderToStaticMarkup(<VprModelRowList entries={[]} additionalRowsLabel="Routers"
    additionalRows={[<button key="router">Auto Router</button>]} onSelect={() => {}} emptyLabel="No models" />);
  assert.ok(markup.includes(`class="${rowStyles.sectionHeading}">Routers</div>`));
  assert.ok(markup.indexOf('>Routers<') < markup.indexOf('>Auto Router<'));
  assert.doesNotMatch(markup, />Models</);
});

test('browse list hides the router heading when no routers are available', () => {
  const markup = renderToStaticMarkup(<VprModelRowList entries={[]} additionalRowsLabel="Routers"
    additionalRows={[]} onSelect={() => {}} emptyLabel="No models" />);
  assert.doesNotMatch(markup, />Routers</);
  assert.match(markup, /No models/);
});

test.each([false, true])('router rows use one standard tag and omit units for free pricing (menu=%s)', (menu) => {
  const service = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route', label: 'Test router', priceMicroUsdc: '0' };
  const free = renderToStaticMarkup(<VprRouterRow service={service} menu={menu} onClick={() => {}} />);
  assert.ok(free.includes(`class="${rowStyles.modelTag}">Router</span>`));
  assert.equal((free.match(/>Router</g) ?? []).length, 1);
  assert.match(free, />Free</);
  assert.doesNotMatch(free, /\/ request/);
  const paid = renderToStaticMarkup(<VprRouterRow service={{ ...service, priceMicroUsdc: '1000' }} menu={menu} onClick={() => {}} />);
  assert.match(paid, /\$0\.001/);
  assert.match(paid, /\/ request/);
});

test.each(['0', '1000'])('chat router uses the model picker layout and pricing (%s)', (priceMicroUsdc) => {
  const service = { peerId: 'd'.repeat(40), provider: 'fake-levanto', serviceId: 'route', label: 'Auto Router', priceMicroUsdc };
  const markup = renderToStaticMarkup(<VprRouterRow service={service} chat active onClick={() => {}} />);
  assert.ok(markup.includes(`class="${dropdownStyles.modelDropdownItem} ${dropdownStyles.active}"`));
  assert.ok(markup.includes(`class="${dropdownStyles.itemTopRow}"`));
  assert.ok(markup.includes(`class="${dropdownStyles.itemName}"`));
  assert.ok(markup.includes(`class="${dropdownStyles.imageBadge}">Router</span>`));
  assert.ok(markup.includes(`class="${dropdownStyles.itemMeta}"><span class="${rowStyles.peerMeta}" title="fake-levanto">fake-levanto</span>`));
  assert.match(markup, />Auto Router</);
  assert.match(markup, /role="option" aria-selected="true"/);
  assert.equal((markup.match(/>Router</g) ?? []).length, 1);
  assert.ok(markup.includes(`class="${dropdownStyles.itemPricing}">${priceMicroUsdc === '0' ? 'Free' : '$0.001 / request'}</span>`));
  if (priceMicroUsdc === '0') assert.doesNotMatch(markup, /\/ request/);
});

test.each([false, true])('model and home rows put seller before price on the second line (menu=%s)', menu => {
  const service = { peerId: 'd'.repeat(40), provider: 'fake-levanto', serviceId: 'route', label: 'Auto Router', priceMicroUsdc: '0' };
  const markup = renderToStaticMarkup(<VprRouterRow service={service} menu={menu} onClick={() => {}} />);
  assert.ok(markup.includes(`class="${rowStyles.metaLine}"><span class="${rowStyles.peerMeta}" title="fake-levanto">fake-levanto</span>`));
  assert.ok(markup.indexOf('>fake-levanto<') < markup.indexOf('>Free<'));
});

test('fixed-model chats do not mark the global router as their active selection', () => {
  const state = createInitialUiState();
  const service = { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' };
  state.vprRouteSelection = { model: null, mode: 'auto', peerId: null, router: { service, costQualityTradeoff: 5 } };
  state.vprRoutingServices = [{ ...service, label: 'Test router', priceMicroUsdc: '1000' }];
  initStore(state);
  const fixed = renderToStaticMarkup(<VprRouterOptions forConversation routerActive={false} />);
  assert.match(fixed, /aria-selected="false"/);
  assert.doesNotMatch(fixed, /Levanto cost \/ quality/);
  const routed = renderToStaticMarkup(<VprRouterOptions forConversation routerActive />);
  assert.match(routed, /aria-selected="true"/);
  assert.match(routed, /\$0\.001/);
  assert.match(routed, />Router</);
  assert.doesNotMatch(routed, /<select|Levanto cost \/ quality|Cost \/ quality/);
});

test('a disappeared selected router remains visible with an actionable message', () => {
  const state = createInitialUiState();
  state.vprRouteSelection = { model: null, mode: 'auto', peerId: null,
    router: { service: { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' }, costQualityTradeoff: 5 } };
  initStore(state);
  assert.match(renderToStaticMarkup(<VprRouterOptions />), /Selected router unavailable/);
});

test('routing discovery failures remain visible before selecting a router', () => {
  const state = createInitialUiState();
  state.vprRoutingServicesError = 'The buyer on port 8377 does not support routing services. Stop the older buyer in its owning app, then start this VPR buyer.';
  initStore(state);
  const markup = renderToStaticMarkup(<VprRouterOptions />);
  assert.match(markup, /Routing services/);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Stop the older buyer/);
});

test.each([false, true])('an empty router catalog renders nothing (chat=%s)', (forConversation) => {
  initStore(createInitialUiState());
  assert.equal(renderToStaticMarkup(<VprRouterOptions forConversation={forConversation} />), '');
});

test('an unavailable global router does not add an empty section to a fixed-model chat', () => {
  const state = createInitialUiState();
  state.vprRouteSelection.router = { service: { peerId: 'd'.repeat(40), provider: 'levanto', serviceId: 'route' }, costQualityTradeoff: undefined };
  initStore(state);
  assert.equal(renderToStaticMarkup(<VprRouterOptions forConversation routerActive={false} />), '');
});
