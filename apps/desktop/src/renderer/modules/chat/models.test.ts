import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ChatModel } from '../../types/bridge';
import {
  buildCumulativeImagePrompt,
  chooseDefaultChatModel,
  chooseModelForPrivate,
  filterChatModels,
  fundsNoticeAction,
  fundsNoticeFromStopReason,
  offerPriceLabel,
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

test('with no last model, the default works without funds', () => {
  const paid = { ...model('paid', 'text'), free: false, toolUse: true, sellers: 30 } as ChatModel;
  const free = { ...model('free', 'text'), free: true, toolUse: true, sellers: 2 } as ChatModel;
  assert.equal(chooseDefaultChatModel([paid, free], null), 'free');
  assert.equal(chooseDefaultChatModel([paid], null), 'paid');
});

test('the dropdown lists free models first and can show only them', () => {
  const paid = { ...model('paid'), free: false } as ChatModel;
  const free = { ...model('free'), free: true } as ChatModel;
  assert.deepEqual(filterChatModels([paid, free], '').text.map((m) => m.id), ['free', 'paid']);
  assert.deepEqual(filterChatModels([paid, free], '', true).text.map((m) => m.id), ['free']);
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

test('without funds Private moves to a model still free there, and keeps one that is', () => {
  const paid = { ...model('glm-5.3-flash'), free: false, toolUse: true, sellers: 5 };
  const free = { ...model('deepseek-flash'), free: true, toolUse: false, sellers: 1 };
  assert.equal(chooseModelForPrivate([paid, free], 'glm-5.3-flash', false), 'deepseek-flash');
  assert.equal(chooseModelForPrivate([paid, free], 'not-listed', false), 'deepseek-flash');
  assert.equal(chooseModelForPrivate([paid, free], 'deepseek-flash', false), null);
});

test('without funds and nothing free, Private leaves the model for the funds note', () => {
  assert.equal(chooseModelForPrivate([{ ...model('glm'), free: false, toolUse: true, sellers: 1 }], 'glm', false), null);
});

test('with funds Private keeps a listed model, and replaces a missing one with a paid one', () => {
  const paid = { ...model('glm-5.2'), free: false, toolUse: true, sellers: 1 };
  const free = { ...model('deepseek-flash'), free: true, toolUse: true, sellers: 9 };
  assert.equal(chooseModelForPrivate([paid, free], 'glm-5.2', true), null);
  assert.equal(chooseModelForPrivate([paid, free], 'deepseek-flash', true), null);
  assert.equal(chooseModelForPrivate([paid, free], 'not-listed', true), 'glm-5.2');
});

test('a pin is dropped in Private, since its seller may not be allowed', () => {
  const peer = '73b4c9335fa239f9c6df3d28d5bf5d3cdf4de736';
  assert.equal(chooseModelForPrivate([{ ...model('glm-5.2'), free: false, toolUse: true, sellers: 1 }], `${peer}@glm-5.2`, true), 'glm-5.2');
});

test('with funds the stand-in is the cheapest paid model with tools', () => {
  const costly = { ...model('sol'), free: false, toolUse: true, sellers: 9, inputUsdPerMillion: 10, outputUsdPerMillion: 40 };
  const cheap = { ...model('flash'), free: false, toolUse: true, sellers: 1, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  assert.equal(chooseModelForPrivate([costly, cheap], 'not-listed', true), 'flash');
});

test('with funds the stand-in is never a model free only for stakers', () => {
  const stakers = { ...model('luna'), free: false, freeForStakers: true, toolUse: true, sellers: 2, inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  const paid = { ...model('flash'), free: false, freeForStakers: false, toolUse: true, sellers: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
  assert.equal(chooseModelForPrivate([stakers, paid], 'not-listed', true), 'flash');
});

test('a funds note never sends a remote gateway\'s user to fund this device', () => {
  assert.equal(fundsNoticeAction(true, 'local'), 'deposit');
  assert.equal(fundsNoticeAction(true, 'remote'), 'console');
  assert.equal(fundsNoticeAction(false, 'remote'), null);
  assert.equal(fundsNoticeAction(false, 'local'), null);
});

test('a $0 offer only stakers get is labeled for stakers, not Free', () => {
  const zero = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  assert.equal(offerPriceLabel(zero, false), 'Free');
  assert.equal(offerPriceLabel(zero, true), 'Free for stakers');
  assert.equal(offerPriceLabel({ inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.9 }, true), '$0.10 / $0.90 per M');
});
