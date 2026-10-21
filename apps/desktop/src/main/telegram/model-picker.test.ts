import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTSEED_AUTO_MODEL,
  isCurrentTelegramModel,
  telegramModelButtonText,
  telegramModelOptions,
  telegramModelPickerText,
} from './model-picker.js';

const models = [
  { model: 'claude-opus-5.5', label: 'Claude Opus 5.5', provider: 'anthropic', favorite: true },
  { model: 'antseed', label: 'Antseed Auto' },
  { model: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', provider: 'openai' },
];

test('Antseed Auto comes first and is not duplicated', () => {
  const options = telegramModelOptions(models, 24);
  assert.deepEqual(options.map((option) => option.id), [ANTSEED_AUTO_MODEL, 'claude-opus-5.5', 'gpt-5.6-sol']);
  assert.equal(options[0]!.label, 'Antseed Auto');
  assert.equal(options[1]!.favorite, true);
});

test('the limit counts Antseed Auto', () => {
  assert.deepEqual(telegramModelOptions(models, 2).map((option) => option.id), [ANTSEED_AUTO_MODEL, 'claude-opus-5.5']);
  assert.deepEqual(telegramModelOptions([], 24).map((option) => option.id), [ANTSEED_AUTO_MODEL]);
});

test('the check mark follows the chat model, defaulting to Auto', () => {
  const [auto, opus] = telegramModelOptions(models, 24);
  assert.equal(isCurrentTelegramModel(auto!, ''), true);
  assert.equal(isCurrentTelegramModel(auto!, undefined), true);
  assert.equal(isCurrentTelegramModel(auto!, 'antseed'), true);
  assert.equal(isCurrentTelegramModel(opus!, 'antseed'), false);
  assert.equal(isCurrentTelegramModel(auto!, 'claude-opus-5.5'), false);
  assert.equal(isCurrentTelegramModel(opus!, 'Claude-Opus-5.5'), true);
  assert.equal(telegramModelButtonText(opus!, 'claude-opus-5.5'), '✓ ★ Claude Opus 5.5');
  assert.equal(telegramModelButtonText(auto!, 'claude-opus-5.5'), 'Antseed Auto');
});

test('the picker text explains Auto and that picks apply to this chat', () => {
  assert.match(telegramModelPickerText(true), /this Telegram chat/);
  assert.match(telegramModelPickerText(true), /model selected in the AI VPN/);
  assert.doesNotMatch(telegramModelPickerText(true), /No other models/);
  assert.match(telegramModelPickerText(false), /No other models discovered yet/);
});
