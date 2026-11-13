import assert from 'node:assert/strict';
import { test } from 'vitest';

import { availableModelFamilies, modelFamilyLabel } from '@antseed/ui';

test('resolves the family from the model label even when the provider is a transport slug', () => {
  assert.equal(modelFamilyLabel({ provider: 'openai', label: 'GLM 5.2' }), 'Z.ai');
  assert.equal(modelFamilyLabel({ provider: 'openai', label: 'Kimi K3' }), 'Moonshot');
  assert.equal(modelFamilyLabel({ provider: 'anthropic', label: 'Claude Opus 4.8' }), 'Anthropic');
  assert.equal(modelFamilyLabel({ provider: 'openai', label: 'GPT-5.6' }), 'OpenAI');
});

test('codex models count as OpenAI', () => {
  assert.equal(modelFamilyLabel({ provider: 'openai', label: 'GPT-5 Codex' }), 'OpenAI');
});

test('unrecognized models resolve to no family', () => {
  assert.equal(modelFamilyLabel({ provider: 'custom', label: 'Mystery Model 9000' }), null);
});

test('an unknown model falls back to the provider slug, matching the row icon', () => {
  assert.equal(modelFamilyLabel({ provider: 'openai', label: 'Mystery Model 9000' }), 'OpenAI');
});

test('availableModelFamilies dedupes and alphabetizes', () => {
  const families = availableModelFamilies([
    { provider: 'openai', label: 'GPT-5.6' },
    { provider: 'openai', label: 'GPT-5 Codex' },
    { provider: 'anthropic', label: 'Claude Opus 4.8' },
    { provider: 'openai', label: 'GLM 5.2' },
    { provider: 'custom', label: 'Mystery Model 9000' },
  ]);
  assert.deepEqual(families, ['Anthropic', 'OpenAI', 'Z.ai']);
});
