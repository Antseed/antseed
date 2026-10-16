import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { normalizeDiscoverRow } from '../../../modules/catalog/discover-rows';
import { RoutedModelIndicator, routedModelLabel } from './RoutedModelIndicator';

const router = 'd'.repeat(40) + '@free-model-router';
const peerId = '1d90f467689d499dc435e5744b4613c3203eb0aa';

beforeEach(() => initStore(createInitialUiState()));

test('a model the user chose names only the seller that served it', () => {
  const direct = { role: 'assistant', content: 'Reply', meta: { service: 'glm-5.3-flash', peerId, peerName: 'Open Forge' } };
  assert.equal(routedModelLabel(direct), 'Open Forge');
  assert.match(renderToStaticMarkup(<RoutedModelIndicator message={direct} />), /Routed to Open Forge</);
});

test('a model a router chose names the model and the seller', () => {
  const routed = { role: 'assistant', content: 'Reply', meta: { service: 'glm-5.3-flash', peerId, peerName: 'Open Forge', router } };
  assert.equal(routedModelLabel(routed), 'GLM 5.3 Flash · Open Forge');
  assert.equal(routedModelLabel({ ...routed, meta: { service: 'gpt-6-astra', router } }), 'GPT 6 Astra');
});

test('replies saved without a seller name use the discovered name, then a short peer id', () => {
  const saved = { role: 'assistant', content: 'Reply', meta: { service: 'glm-5.3-flash', peerId } };
  assert.equal(routedModelLabel(saved, () => 'Open Forge'), 'Open Forge');
  assert.equal(routedModelLabel(saved), '1d90f467...b0aa');
  const state = createInitialUiState();
  const row = normalizeDiscoverRow({ peerId, serviceId: 'glm-5.3-flash', provider: 'openai', protocol: 'openai-chat-completions',
    inputUsdPerMillion: 0, outputUsdPerMillion: 0, peerLabel: 'Open Forge (1d90f467)' });
  assert.ok(row);
  state.vprRoutableRows = [row];
  initStore(state);
  assert.match(renderToStaticMarkup(<RoutedModelIndicator message={saved} />), /Routed to Open Forge</);
});

test('nothing is invented for router aliases, unknown sellers or user messages', () => {
  for (const service of [undefined, '', 'antseed', 'peer@antseed']) {
    assert.equal(routedModelLabel({ role: 'assistant', content: '', meta: { service, router } }), null);
  }
  assert.equal(routedModelLabel({ role: 'assistant', content: '', meta: { service: 'gpt-6-astra' } }), null);
  assert.equal(routedModelLabel({ role: 'user', content: '', meta: { service: 'gpt-6-astra', peerId, router } }), null);
});
