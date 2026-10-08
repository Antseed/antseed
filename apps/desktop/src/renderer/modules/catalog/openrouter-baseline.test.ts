import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprModelCatalogEntry } from '../../core/state';
import { applyOpenRouterBaselines } from './openrouter-baseline.js';

function fableEntry(): VprModelCatalogEntry {
  return {
    provider: 'claude-oauth',
    serviceId: 'fable-5-coding-only',
    label: 'Fable 5',
    peerCount: 11,
    categories: [],
    kind: 'text',
    protocols: ['anthropic-messages', 'openai-chat-completions'],
    minInputUsdPerMillion: 0.45,
    maxInputUsdPerMillion: 12,
    minOutputUsdPerMillion: 1.15,
    maxOutputUsdPerMillion: 60,
    minCachedInputUsdPerMillion: 0.35,
    maxCachedInputUsdPerMillion: 4.5,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    expectedSavingsPct: null,
    hasEligibleFreeSeller: false,
    bestPeerId: 'peer',
  };
}

test('matches a canonical Fable OpenRouter reference key', () => {
  const [entry] = applyOpenRouterBaselines([fableEntry()], {
    fable5: { input: 5, output: 30 },
  });

  assert.equal(entry.baselineInputUsdPerMillion, 5);
  assert.equal(entry.baselineOutputUsdPerMillion, 30);
  assert.equal(entry.expectedSavingsPct, 95);
});

test('matches the legacy flattened Claude Fable reference key after restart', () => {
  const [entry] = applyOpenRouterBaselines([fableEntry()], {
    claudefable5: { input: 5, output: 30 },
  });

  assert.equal(entry.baselineInputUsdPerMillion, 5);
  assert.equal(entry.baselineOutputUsdPerMillion, 30);
  assert.equal(entry.expectedSavingsPct, 95);
});

test('leaves savings unset when no retail reference is available', () => {
  const [entry] = applyOpenRouterBaselines([fableEntry()], null);

  assert.equal(entry.expectedSavingsPct, null);
});
