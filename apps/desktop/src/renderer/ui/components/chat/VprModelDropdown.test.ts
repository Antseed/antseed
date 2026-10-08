import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprModelCatalogEntry } from '../../../core/state';
import { filterVprModelDropdownCatalog } from './VprModelDropdown';

function catalogEntry(kind: VprModelCatalogEntry['kind'], serviceId: string): VprModelCatalogEntry {
  return {
    provider: 'openai',
    serviceId,
    label: serviceId,
    peerCount: 1,
    categories: [],
    kind,
    protocols: [kind === 'image' ? 'openai-images' : 'openai-chat-completions'],
    minInputUsdPerMillion: null,
    maxInputUsdPerMillion: null,
    minOutputUsdPerMillion: null,
    maxOutputUsdPerMillion: null,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    expectedSavingsPct: null,
    hasEligibleFreeSeller: true,
    bestPeerId: null,
  };
}

test('model dropdown catalog stays within the active chat mode', () => {
  const text = catalogEntry('text', 'text-model');
  const image = catalogEntry('image', 'image-model');
  assert.deepEqual(filterVprModelDropdownCatalog([text, image], 'image'), [image]);
  assert.deepEqual(filterVprModelDropdownCatalog([text, image], 'text'), [text]);
});
