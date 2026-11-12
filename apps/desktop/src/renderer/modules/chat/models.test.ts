import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ChatModel } from '../../types/bridge';
import {
  selectionIsFree,
  buildCumulativeImagePrompt,
  chooseDefaultChatModel,
  chooseModelForPrivate,
  filterChatModels,
  findChatModel,
  fundsNoticeAction,
  fundsNoticeFromStopReason,
  isFreeOffer,
  offerPriceLabel,
  pickerChatModels,
  shouldWaitForFreeModel,
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

test('a first message waits for a free model only while none is listed, for an unfunded user who chose nothing', () => {
  const paid = { ...model('paid'), free: false } as ChatModel;
  const free = { ...model('free'), free: true } as ChatModel;
  const fresh = { chosen: false, funded: false };
  assert.equal(shouldWaitForFreeModel([paid], 'paid', fresh), true, 'only paid sellers found so far');
  assert.equal(shouldWaitForFreeModel([], null, fresh), true, 'nothing listed yet');
  assert.equal(shouldWaitForFreeModel([paid, free], 'paid', fresh), false, 'a free model is listed: the default moves to it');
  assert.equal(shouldWaitForFreeModel([paid], 'paid', { chosen: true, funded: false }), false, 'the user picked this model');
  assert.equal(shouldWaitForFreeModel([paid], 'paid', { chosen: false, funded: true }), false, 'funds pay for it');
});

test('the dropdown lists free models first and can show only them', () => {
  const paid = { ...model('paid'), free: false } as ChatModel;
  const free = { ...model('free'), free: true } as ChatModel;
  assert.deepEqual(filterChatModels([paid, free], '').text.map((m) => m.id), ['free', 'paid']);
  assert.deepEqual(filterChatModels([paid, free], '', 'free').text.map((m) => m.id), ['free']);
});

test('routers list on their own, first, and Auto shows only them', () => {
  const router = { ...model('<peerId>@example-router', 'text', 'Example Router'), router: { sellerName: 'Example Seller', priceUsdPerRequest: 0.0001, models: 12 } } as ChatModel;
  const free = { ...model('free'), free: true } as ChatModel;
  const all = filterChatModels([free, router], '');
  assert.deepEqual(all.routers.map((m) => m.id), ['<peerId>@example-router']);
  assert.deepEqual(all.text.map((m) => m.id), ['free']);
  assert.deepEqual(filterChatModels([free, router], '', 'routers'), { routers: [router], text: [], image: [] });
  assert.deepEqual(filterChatModels([free, router], '', 'free').routers, []);
  assert.deepEqual(filterChatModels([free, router], 'example seller').routers, [router]);
  // Found whole, not as a pinned model, and never the default.
  assert.equal(findChatModel([free, router], '<peerId>@example-router'), router);
  assert.equal(chooseDefaultChatModel([router, free], null), 'free');
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
  const peer = 'cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34';
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

test('a seller charging only for cache reads is not labeled Free, and names that price', () => {
  const cachedOnly = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.05 };
  assert.equal(offerPriceLabel(cachedOnly, false), '$0 / $0 per M · cache reads $0.0500');
  assert.equal(offerPriceLabel(cachedOnly, true), '$0 / $0 per M · cache reads $0.0500');
  assert.equal(offerPriceLabel({ ...cachedOnly, cachedInputUsdPerMillion: null }, false), 'Free');
});

test('a pin to a paid seller of a model with a free seller is not Free', () => {
  const free = 'a'.repeat(40);
  const model = { free: true, freeSellerId: `0x${free.toUpperCase()}` };
  assert.equal(selectionIsFree(model, 'model-a'), true);
  assert.equal(selectionIsFree(model, `${free}@model-a`), true);
  assert.equal(selectionIsFree(model, `${'b'.repeat(40)}@model-a`), false);
  assert.equal(selectionIsFree({ free: false, freeSellerId: null }, 'model-a'), false);
});

test('an offer charging for cached input is not free', () => {
  assert.equal(isFreeOffer({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.1 }), false);
  assert.equal(isFreeOffer({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0 }), true);
  assert.equal(isFreeOffer({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 }), true);
});

test('the picker leaves out models no trusted seller serves, but keeps the ones in use', () => {
  const trusted = { ...model('trusted'), free: true } as ChatModel;
  const lowTrust = { ...model('low-trust'), free: true, lowTrust: true } as ChatModel;
  const lowTrustImage = { ...model('low-trust-image', 'image'), lowTrust: true } as ChatModel;
  const all = [trusted, lowTrust, lowTrustImage];
  assert.deepEqual(pickerChatModels(all, [null, null]).map((m) => m.id), ['trusted']);
  // An open chat or saved default on one keeps it, pinned to a seller or not.
  assert.deepEqual(pickerChatModels(all, ['low-trust', null]).map((m) => m.id), ['trusted', 'low-trust']);
  assert.deepEqual(pickerChatModels(all, [`${'a'.repeat(40)}@low-trust`, null]).map((m) => m.id), ['trusted', 'low-trust']);
  assert.deepEqual(pickerChatModels(all, ['trusted', 'low-trust-image']).map((m) => m.id), ['trusted', 'low-trust-image']);
});

test('while no trusted seller serves a free text model, the picker keeps the low-trust free ones', () => {
  const trustedPaid = { ...model('trusted-paid'), free: false } as ChatModel;
  const lowTrustFree = { ...model('low-trust-free'), free: true, lowTrust: true } as ChatModel;
  const lowTrustPaid = { ...model('low-trust-paid'), free: false, lowTrust: true } as ChatModel;
  const lowTrustFreeImage = { ...model('low-trust-free-image', 'image'), free: true, lowTrust: true } as ChatModel;
  const all = [trustedPaid, lowTrustFree, lowTrustPaid, lowTrustFreeImage];
  assert.deepEqual(pickerChatModels(all, [null, null]).map((m) => m.id), ['trusted-paid', 'low-trust-free']);
});

test('defaults rank free and trusted, then free, then paid and trusted, while a saved choice stays', () => {
  const trustedPaid = { ...model('trusted-paid'), free: false, toolUse: true, sellers: 9 } as ChatModel;
  const lowTrustFree = { ...model('low-trust-free'), free: true, toolUse: false, sellers: 1, lowTrust: true } as ChatModel;
  const trustedFree = { ...model('trusted-free'), free: true, toolUse: false, sellers: 1 } as ChatModel;
  const lowTrustFreeTools = { ...model('low-trust-free-tools'), free: true, toolUse: true, sellers: 9, lowTrust: true } as ChatModel;
  // An unfunded user's default answers without funds, even when only low-trust sellers serve it free.
  assert.equal(chooseDefaultChatModel([trustedPaid, lowTrustFree], null), 'low-trust-free');
  assert.equal(chooseDefaultChatModel([trustedPaid, lowTrustFreeTools, lowTrustFree, trustedFree], null), 'trusted-free');
  assert.equal(chooseDefaultChatModel([trustedPaid, lowTrustFree], 'trusted-paid'), 'trusted-paid', 'the user chose it');
  // A stand-in without funds is free first, trusted next; with funds, a trusted paid one.
  assert.equal(chooseModelForPrivate([trustedPaid, lowTrustFree], 'gone', false), 'low-trust-free');
  assert.equal(chooseModelForPrivate([lowTrustFreeTools, trustedFree, trustedPaid], 'gone', false), 'trusted-free');
  assert.equal(chooseModelForPrivate([lowTrustFree, trustedPaid], 'gone', true), 'trusted-paid');
});

test('a first message does not wait while any free text model is listed, low-trust or not', () => {
  const trustedPaid = { ...model('trusted-paid'), free: false } as ChatModel;
  const lowTrustFree = { ...model('low-trust-free'), free: true, lowTrust: true } as ChatModel;
  const fresh = { chosen: false, funded: false };
  assert.equal(shouldWaitForFreeModel([trustedPaid, lowTrustFree], 'trusted-paid', fresh), false);
  assert.equal(shouldWaitForFreeModel([trustedPaid], 'trusted-paid', fresh), true);
});

test('a saved id finds its model after the listing names it by another of its ids', () => {
  // One read lists `glm-5.3-flash`, the next `z-ai/glm-5.3-flash`: the same model by the canonical rule.
  const glm = { ...model('z-ai/glm-5.3-flash'), free: true, toolUse: true, sellers: 1 } as ChatModel;
  const other = { ...model('qwen'), free: true, toolUse: true, sellers: 5 } as ChatModel;
  const listed = [other, glm];
  assert.equal(findChatModel(listed, 'glm-5.3-flash'), glm);
  assert.equal(findChatModel(listed, 'GLM-5.3-Flash'), glm, 'ignoring case');
  assert.equal(findChatModel(listed, `${'a'.repeat(40)}@glm-5.3-flash`), glm, 'a pinned seller');
  assert.equal(findChatModel(listed, 'gone'), null);
  // The saved default stays on it instead of falling back.
  assert.equal(chooseDefaultChatModel(listed, 'glm-5.3-flash'), 'z-ai/glm-5.3-flash');
  // A chat on it keeps it in the picker even when its sellers are low-trust.
  const lowTrustGlm = { ...glm, free: false, lowTrust: true } as ChatModel;
  assert.deepEqual(pickerChatModels([other, lowTrustGlm], ['glm-5.3-flash', null]).map((m) => m.id), ['qwen', 'z-ai/glm-5.3-flash']);
  // Private keeps a listed model rather than moving off it.
  assert.equal(chooseModelForPrivate([other, glm], 'glm-5.3-flash', false), null);
});

test('an exact id wins over another id for the same model', () => {
  const exact = model('glm-5.3-flash');
  const canonical = model('z-ai/glm-5.3-flash');
  assert.equal(findChatModel([canonical, exact], 'glm-5.3-flash'), exact);
  assert.equal(findChatModel([canonical, exact], 'z-ai/glm-5.3-flash'), canonical);
  // Case alone beats a canonical match too.
  assert.equal(findChatModel([canonical, exact], 'GLM-5.3-FLASH'), exact);
});

test('a dated variant is another model', () => {
  const listed = [model('deepseek-v4.1-flash')];
  assert.equal(findChatModel(listed, 'deepseek-v4-1-flash-1017'), null);
  assert.equal(findChatModel(listed, 'deepseek-v4-1-flash')?.id, 'deepseek-v4.1-flash');
});
