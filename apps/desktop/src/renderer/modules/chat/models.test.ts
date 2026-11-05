import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ChatModel } from '../../types/bridge';
import {
  buildCumulativeImagePrompt,
  chooseDefaultChatModel,
  filterChatModels,
  fundsNoticeFromStopReason,
} from './models';

function model(id: string, type = 'text', label = id): ChatModel {
  return { id, label, type, protocol: type === 'text' ? 'openai-chat-completions' : null, supportsImages: false };
}

test('the default model is the last one used while still listed as text, else the first text model', () => {
  const models = [model('flux', 'image'), model('qwen'), model('glm')];
  assert.equal(chooseDefaultChatModel(models, 'glm'), 'glm');
  assert.equal(chooseDefaultChatModel(models, 'gone'), 'qwen');
  assert.equal(chooseDefaultChatModel(models, 'flux'), 'qwen');
  assert.equal(chooseDefaultChatModel([model('flux', 'image')], null), null);
});

test('the dropdown search matches ids and labels and splits text from image models', () => {
  const models = [model('qwen-3', 'text', 'Qwen 3'), model('flux-1', 'image', 'FLUX'), model('glm-5')];
  assert.deepEqual(filterChatModels(models, 'qwen').text.map((m) => m.id), ['qwen-3']);
  assert.deepEqual(filterChatModels(models, 'flux').image.map((m) => m.id), ['flux-1']);
  assert.equal(filterChatModels(models, '').text.length, 2);
});

test('only payment_required stops become the funds notice; spend limits hide "Add funds"', () => {
  assert.equal(fundsNoticeFromStopReason({ kind: 'http_error', message: 'nope' }), null);
  assert.deepEqual(fundsNoticeFromStopReason({ kind: 'payment_required', message: 'Too low.' }), { message: 'Too low.', canAddFunds: true });
  assert.equal(fundsNoticeFromStopReason({ kind: 'payment_required', message: 'Daily limit.', errorCode: 'spend_limit_reached' })?.canAddFunds, false);
});

test('cumulative image prompts number every follow-up', () => {
  const first = buildCumulativeImagePrompt(['an ant'], 'make it blue');
  assert.match(first, /Initial request: an ant\nFollow-up 1: make it blue/);
  assert.match(buildCumulativeImagePrompt([first], 'add a hat'), /Follow-up 2: add a hat/);
});
