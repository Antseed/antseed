import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ChatModel } from '../../../types/bridge';
import { cardFits, centeredScrollTop, holdEnterInSearch, initialPickerTab, skillPrompt, modelInlineDetails, modelLab, modelSummary, pickerLists, pickerTabFor } from './ChatModelDropdown';

test('Enter in the model search does not submit the composer form around it', () => {
  const pressed = (key: string) => {
    let prevented = false;
    holdEnterInSearch({ key, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(pressed('Enter'), true);
  assert.equal(pressed('a'), false);
  assert.equal(pressed('Escape'), false);
});

test('the menu opens with the selected model centered, or at the top for one near it', () => {
  // A model 1000px down a 380px menu, 60px tall: its middle at the menu's middle.
  assert.equal(centeredScrollTop(1000, 60, 380), 840);
  assert.equal(centeredScrollTop(50, 60, 380), 0);
  // Below a 40px filter row it centers in the 340px left under it.
  assert.equal(centeredScrollTop(1000, 60, 380, 40), 820);
});

const model = (fields: Partial<ChatModel>): ChatModel => ({
  id: 'm', label: 'm', type: 'text', protocol: 'openai-chat-completions', supportsImages: false, sellers: 1, free: false,
  minImageUsd: null, freeSellerId: null, freeForStakers: false, tee: false, toolUse: false, reasoning: false,
  inputUsdPerMillion: null, outputUsdPerMillion: null, ...fields,
} as ChatModel);

test('the picker opens on the tab of the model in use', () => {
  assert.equal(pickerTabFor(model({ router: { sellerName: null, priceUsdPerRequest: 0, models: 3 } })), 'auto');
  assert.equal(pickerTabFor(model({ type: 'image' })), 'image');
  assert.equal(pickerTabFor(model({})), 'text');
  // No model in use yet: Text.
  assert.equal(pickerTabFor(null), 'text');
});

test('a row shows its lab only for models a known lab makes', () => {
  assert.equal(modelLab(model({ id: 'moonshotai/kimi-k3', label: 'Kimi K3' })), 'Moonshot');
  assert.equal(modelLab(model({ id: 'z-ai/glm-5.3-flash', label: 'glm-5.3-flash' })), 'Z.ai');
  assert.equal(modelLab(model({ id: 'gemma-4-27b', label: 'gemma-4-27b' })), 'Google');
  assert.equal(modelLab(model({ id: 'olmo-3-32b', label: 'olmo-3-32b' })), null);
  // An app's name inside a model id isn't a lab.
  assert.equal(modelLab(model({ id: 'goose-coder', label: 'goose-coder' })), null);
  assert.equal(modelLab(model({ id: 'kimi-router', label: 'Kimi router', router: { sellerName: 'Example Seller', priceUsdPerRequest: 0, models: 4 } })), null);
});

test('with the model in use not listed, the picker opens on a tab that has models', () => {
  const image = model({ type: 'image' });
  assert.equal(initialPickerTab(null, ['image']), 'image');
  assert.equal(initialPickerTab(null, ['auto']), 'auto');
  assert.equal(initialPickerTab(image, ['auto', 'text', 'image']), 'image');
  assert.equal(initialPickerTab(null, ['auto', 'text']), 'text');
});

test('Free narrows Text and Image, never the routers on Auto', () => {
  const router = model({ id: 'r', label: 'Router', router: { sellerName: null, priceUsdPerRequest: 0.001, models: 3 } });
  const paid = model({ id: 'paid', label: 'Paid' });
  const free = model({ id: 'free', label: 'Free', free: true });
  const lists = pickerLists([router, paid, free], '', true);
  assert.deepEqual(lists.auto, [router]);
  assert.deepEqual(lists.text, [free]);
});

test('a row tells screen readers what its detail card shows', () => {
  const kimi = model({ id: 'moonshotai/kimi-k3', label: 'Kimi K3', tee: true, supportsImages: true, sellers: 6, contextWindow: 256000, inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 });
  const summary = modelSummary(kimi);
  for (const part of ['Moonshot', 'TEE', 'Vision', 'per M', '256k context', '6 sellers']) assert.ok(summary.includes(part), part);
  const router = model({ id: 'r', label: 'Router', router: { sellerName: 'Example Seller', priceUsdPerRequest: 0, models: 4 } });
  assert.equal(modelSummary(router), 'by Example Seller. Router. Free picks. picks from 4 models');
});

test('the card shows beside the menu only where it fits, else rows carry the details', () => {
  // A 400px menu at the left of a wide window: room on its right.
  assert.equal(cardFits(40, 440, 1280), true);
  // At the right edge: room on its left.
  assert.equal(cardFits(840, 1240, 1280), true);
  // Home's full-width menu in a 920px window: no room either side.
  assert.equal(cardFits(120, 860, 920), false);
});

test('without room for the card, a row\'s second line adds only what its tags don\'t say', () => {
  const glm = model({ id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', free: true, contextWindow: 200000 });
  assert.equal(modelInlineDetails(glm), 'Z.ai · 200k context');
  const kimi = model({ id: 'moonshotai/kimi-k3', label: 'Kimi K3', inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 });
  assert.match(modelInlineDetails(kimi), /^Moonshot · from \$0\.60/);
  // Capabilities stay visible too; Free and TEE are the row's own tags.
  const qwen = model({ id: 'qwen-4-235b', label: 'Qwen 4 235B', tee: true, supportsImages: true, reasoning: true, toolUse: true, freeForStakers: true });
  assert.equal(modelInlineDetails(qwen), 'Qwen · Free for stakers · Vision · Reasoning · Tools');
});

test('video and decision models get tabs of their own, searched like the rest', () => {
  const video = model({ id: 'alibaba/wan-3.0/text-to-video', label: 'Wan 3.0 text to video', type: 'video' });
  const decision = model({ id: 'jev-latest', label: 'Jev', type: 'decision' });
  assert.equal(pickerTabFor(video), 'video');
  assert.equal(pickerTabFor(decision), 'decision');
  const lists = pickerLists([video, decision, model({ id: 'glm', label: 'GLM' })], 'wan', false);
  assert.deepEqual(lists.video, [video]);
  assert.deepEqual(lists.decision, []);
  assert.deepEqual(lists.text, []);
});

test('a video or decision model starts a prompt for the chat model, naming its skill', () => {
  assert.equal(skillPrompt(model({ id: 'alibaba/wan-3.0/text-to-video', type: 'video' })), 'Make a video with the model alibaba/wan-3.0/text-to-video (antseed-videos skill) of: ');
  assert.equal(skillPrompt(model({ id: 'jev-latest', type: 'decision' })), 'Use the decision model jev-latest (antseed-decisions skill) to answer: ');
});
