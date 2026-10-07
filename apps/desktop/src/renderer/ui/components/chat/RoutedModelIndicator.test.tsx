import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoutedModelIndicator, routedModelLabel } from './RoutedModelIndicator';

test('response indicators retain their actual model independently of later selections', () => {
  const first = { role: 'assistant', content: 'First response', meta: { service: 'gpt-6-astra' } };
  const second = { role: 'assistant', content: 'Second response', meta: { service: 'gpt-5.6-luna' } };
  assert.match(renderToStaticMarkup(<RoutedModelIndicator message={first} />), /Routed to GPT 6 Astra/);
  assert.match(renderToStaticMarkup(<RoutedModelIndicator message={second} />), /Routed to GPT 5\.6 Luna/);
  assert.notEqual(routedModelLabel(first), routedModelLabel(second));
});

test('router aliases, unknown models and user messages never invent a resolved model', () => {
  for (const service of [undefined, '', 'antseed', 'peer@antseed']) {
    assert.equal(routedModelLabel({ role: 'assistant', content: '', meta: { service } }), null);
  }
  assert.equal(routedModelLabel({ role: 'user', content: '', meta: { service: 'gpt-6-astra' } }), null);
  assert.equal(routedModelLabel({ role: 'assistant', content: '', meta: { service: 'peer@gpt-6-astra' } }), 'GPT 6 Astra');
});
