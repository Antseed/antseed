import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow, VprModelCatalogEntry } from '../../../core/state';
import {
  filterVprCatalog,
  routesForSelectedModel,
  sortVprCatalog,
} from '../../../modules/catalog/view-models.js';
import { peerCapabilitySummary, supportsServiceParameter } from '../../../modules/catalog/model-capabilities.js';

function catalogEntry(overrides: Partial<VprModelCatalogEntry> = {}): VprModelCatalogEntry {
  return {
    provider: 'openai',
    serviceId: 'gpt-test',
    label: 'GPT Test',
    peerCount: 1,
    categories: [],
    kind: 'text',
    protocols: ['openai-chat-completions'],
    minInputUsdPerMillion: 1,
    maxInputUsdPerMillion: 1,
    minOutputUsdPerMillion: 2,
    maxOutputUsdPerMillion: 2,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    expectedSavingsPct: null,
    hasEligibleFreeSeller: true,
    bestPeerId: null,
    ...overrides,
  };
}

function discoverRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const provider = overrides.provider ?? 'openai';
  const serviceId = overrides.serviceId ?? 'gpt-test';
  const peerId = overrides.peerId ?? 'peer-1';

  return {
    rowKey: `${peerId}:${serviceId}`,
    serviceId,
    serviceLabel: serviceId,
    categories: [],
    provider,
    protocol: 'openai-chat-completions',
    peerId,
    peerEvmAddress: '',
    sellerContract: null,
    verificationLinks: [],
    peerIconUrl: null,
    peerDisplayName: null,
    peerLabel: '',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cachedInputUsdPerMillion: null,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    lifetimeSessions: 0,
    lifetimeRequests: 0,
    lifetimeInputTokens: 0,
    lifetimeOutputTokens: 0,
    lifetimeFirstSessionAt: null,
    lifetimeLastSessionAt: null,
    onChainChannelCount: null,
    agentId: 1,
    poolStakeAnts: 0,
    onChainActiveChannelCount: 0,
    onChainGhostCount: 0,
    onChainTotalVolumeUsdc: '0',
    onChainLastSettledAt: 0,
    onChainReputationScore: null,
    washFlagged: null,
    effectiveReputationScore: null,
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    selectionValue: `${provider}\u0001${serviceId}\u0001${peerId}`,
    ...overrides,
  };
}

test('Explore search finds a model by category', () => {
  const catalog = [
    catalogEntry({ serviceId: 'chat', label: 'Chat Model', categories: ['chat'] }),
    catalogEntry({ serviceId: 'vision', label: 'Vision Model', categories: ['multimodal', 'image'] }),
  ];

  assert.deepEqual(filterVprCatalog(catalog, { search: 'image' }), [catalog[1]]);
});

test('Explore search finds image-only models by their derived type', () => {
  const image = catalogEntry({ serviceId: 'art-model', label: 'Art Model', kind: 'image' });
  assert.deepEqual(filterVprCatalog([image], { search: 'image generation' }), [image]);
});

test('Explore search finds curated model tags without seller categories', () => {
  const image = catalogEntry({ serviceId: 'lustify-v8', label: 'Lustify V8', kind: 'image', categories: [] });
  assert.deepEqual(filterVprCatalog([image], { search: 'uncensored' }), [image]);
});

test('Explore filters models by output type', () => {
  const text = catalogEntry({ serviceId: 'chat-model', label: 'Chat Model', kind: 'text' });
  const image = catalogEntry({ serviceId: 'art-model', label: 'Art Model', kind: 'image' });

  assert.deepEqual(filterVprCatalog([text, image], { kind: 'image' }), [image]);
  assert.deepEqual(filterVprCatalog([text, image], { kind: 'text' }), [text]);
  assert.deepEqual(filterVprCatalog([text, image], { kind: null }), [text, image]);
});

test('Price sort places lower priced model first', () => {
  const expensive = catalogEntry({
    serviceId: 'expensive',
    label: 'Expensive',
    minInputUsdPerMillion: 5,
    minOutputUsdPerMillion: 6,
  });
  const cheap = catalogEntry({
    serviceId: 'cheap',
    label: 'Cheap',
    minInputUsdPerMillion: 1,
    minOutputUsdPerMillion: 2,
  });

  assert.deepEqual(sortVprCatalog([expensive, cheap], 'Price'), [cheap, expensive]);
});

test('Model route filtering excludes other service IDs but keeps canonical variants', () => {
  const selected = discoverRow({ provider: 'openai', serviceId: 'gpt-test', peerId: 'selected-peer' });
  const otherService = discoverRow({ provider: 'openai', serviceId: 'other-service', peerId: 'other-peer' });
  // Same model advertised under a different provider string and a cosmetic
  // serviceId variant — both are valid routes for the selection.
  const otherProvider = discoverRow({ provider: 'anthropic', serviceId: 'gpt-test', peerId: 'anthropic-peer' });
  const variantKey = discoverRow({ provider: 'openai', serviceId: 'GPT Test', peerId: 'variant-peer' });

  assert.deepEqual(
    routesForSelectedModel([selected, otherService, otherProvider, variantKey], {
      provider: 'openai',
      serviceId: 'gpt-test',
    }),
    [selected, otherProvider, variantKey],
  );
});

test('service parameter support is matched case-insensitively', () => {
  const route = discoverRow({
    protocol: 'openai-images',
    capabilities: { outputs: ['image'], supportedParameters: ['MODERATION', 'output_format'] },
  });

  assert.equal(supportsServiceParameter(route, 'moderation'), true);
  assert.equal(supportsServiceParameter(route, 'quality'), false);
});

test('image seller summaries distinguish generation-only routes from edit support', () => {
  const generationOnly = discoverRow({
    protocol: 'openai-images',
    capabilities: { inputs: ['text'], outputs: ['image'] },
  });
  const editable = discoverRow({
    protocol: 'openai-images',
    capabilities: { inputs: ['text', 'image'], outputs: ['image'] },
  });

  assert.equal(peerCapabilitySummary(generationOnly)[0], undefined);
  assert.equal(peerCapabilitySummary(editable)[0], 'Image editing');
});
