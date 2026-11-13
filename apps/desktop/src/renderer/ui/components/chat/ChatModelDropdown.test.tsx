import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ChatModel } from '../../../types/bridge';
import { centeredScrollTop, holdEnterInSearch, modelLab, pickerTabFor } from './ChatModelDropdown';

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
