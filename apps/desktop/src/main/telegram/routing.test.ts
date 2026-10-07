import assert from 'node:assert/strict';
import test from 'node:test';
import { telegramModelPickerText } from './routing.js';

test('Telegram keeps the model picker wording when no router is selected', () => {
  assert.equal(telegramModelPickerText('model-a', true), 'Pick a model — it applies to this chat and becomes the default in the app:');
  assert.equal(telegramModelPickerText('', false), 'No models discovered yet — try again in a moment.');
});

test('Telegram explains router mode even before inference discovery completes', () => {
  assert.match(telegramModelPickerText('antseed', true), /^A router is active/);
  assert.match(telegramModelPickerText('antseed', true), /no fixed default model/);
  assert.match(telegramModelPickerText('antseed', false), /Picking a model leaves router mode/);
  assert.match(telegramModelPickerText('antseed', false), /No models discovered/);
});
