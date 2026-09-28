import assert from 'node:assert/strict';
import test from 'node:test';
import { telegramModelPickerText, telegramRouteModel } from './routing.js';

test('Telegram uses the router alias rather than inventing a fixed model', () => {
  assert.equal(telegramRouteModel({ kind: 'router', service: { peerId: 'router' } }), 'antseed');
  assert.equal(telegramRouteModel({ kind: 'model', model: ' peer@model-a ' }), 'peer@model-a');
  assert.equal(telegramRouteModel({ kind: 'model', model: null }), '');
  assert.equal(telegramRouteModel({ model: 'legacy' }), '');
  assert.equal(telegramRouteModel(undefined), '');
});

test('Telegram explains router mode even before inference discovery completes', () => {
  for (const alias of ['antseed', 'levanto-auto']) {
    assert.match(telegramModelPickerText(alias, true), /no fixed default model/);
    assert.match(telegramModelPickerText(alias, false), /Picking a model leaves router mode/);
    assert.match(telegramModelPickerText(alias, false), /No models discovered/);
  }
  assert.doesNotMatch(telegramModelPickerText('model-a', true), /router is active/);
});
