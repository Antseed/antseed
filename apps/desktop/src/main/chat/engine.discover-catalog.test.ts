import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscoverRows, normalizeChatServiceCatalogEntries } from './service-discovery.js';

import {
  buildChatServiceCatalogFromNetworkModels,
  buildChatServiceCatalogFromPersistedPeers,
} from './service-catalog.js';

const venicePeerId = '9'.repeat(40);
const flashPeerId = 'f'.repeat(40);

test('TEE advertisements survive live, persisted, normalization and discovery projections', async () => {
  const offer = {
    peerId: venicePeerId, provider: 'openai', serviceId: 'gpt-test', protocol: 'openai-chat-completions',
    advertisedVerifierIds: [' Antseed-Verifier ', 'antseed-verifier', null, 'bad id'],
  };
  const live = buildChatServiceCatalogFromNetworkModels({ data: [{ peers: [offer] }] });
  const persisted = buildChatServiceCatalogFromPersistedPeers({ discoveredPeers: [{
    peerId: venicePeerId, providers: ['openai'], services: ['gpt-test'],
    capabilities: ['verifier.antseed-verifier'],
  }] });
  for (const entries of [live, persisted]) {
    assert.deepEqual(entries[0]?.advertisedVerifierIds, ['antseed-verifier']);
    const normalized = normalizeChatServiceCatalogEntries(entries);
    assert.deepEqual(normalized[0]?.advertisedVerifierIds, ['antseed-verifier']);
    const rows = await buildDiscoverRows(normalized, new Map(), {}, new Map());
    assert.deepEqual(rows[0]?.advertisedVerifierIds, ['antseed-verifier']);
  }
  for (const advertisedVerifierIds of [undefined, null, 'antseed-verifier', ['bad id', null]]) {
    const entries = buildChatServiceCatalogFromNetworkModels({ data: [{ peers: [{ ...offer, advertisedVerifierIds }] }] });
    assert.deepEqual(entries[0]?.advertisedVerifierIds, []);
  }
});

test('persisted catalog uses the buyer trust score and falls back to the seller-reported score', () => {
  const protocols = { openai: { services: { 'example-model': ['openai-chat-completions'] } } };
  const scored = buildChatServiceCatalogFromPersistedPeers({ discoveredPeers: [{
    peerId: flashPeerId, providers: ['openai'], onChainReputationScore: 70, reputationScore: 99,
    providerServiceApiProtocols: protocols,
  }] });
  assert.equal(scored[0]?.effectiveReputationScore, 70);

  const zero = buildChatServiceCatalogFromPersistedPeers({ discoveredPeers: [{
    peerId: flashPeerId, providers: ['openai'], onChainReputationScore: 0, reputationScore: 99,
    providerServiceApiProtocols: protocols,
  }] });
  assert.equal(zero[0]?.effectiveReputationScore, 0);

  const unscored = buildChatServiceCatalogFromPersistedPeers({ discoveredPeers: [{
    peerId: flashPeerId, providers: ['openai'], reputationScore: 42,
    providerServiceApiProtocols: protocols,
  }] });
  assert.equal(unscored[0]?.effectiveReputationScore, 42);

  const unknown = buildChatServiceCatalogFromPersistedPeers({ discoveredPeers: [{
    peerId: flashPeerId, providers: ['openai'],
    providerServiceApiProtocols: protocols,
  }] });
  assert.equal(unknown[0]?.effectiveReputationScore, null);
});

function modelsPayload(): unknown {
  return {
    object: 'list',
    data: [{
      id: 'claude-fable-5',
      name: 'Claude Fable 5',
      peers: [
        {
          peerId: venicePeerId,
          displayName: 'Venice.ai Proxy',
          provider: 'openai',
          serviceId: 'fable-5',
          protocol: 'openai-chat-completions',
          effectiveReputationScore: 98.31986321791896,
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 30,
          cachedInputUsdPerMillion: 0.6,
          categories: ['chat', 'reasoning'],
          capabilities: {
            contextWindow: 1_000_000,
            maxOutputTokens: 128_000,
            inputs: ['text', 'image'],
            outputs: ['text'],
            reasoning: true,
            toolUse: true,
            structuredOutput: true,
          },
        },
        {
          peerId: flashPeerId,
          displayName: 'Flash',
          provider: 'openai',
          serviceId: 'claude-fable-5',
          protocol: 'openai-chat-completions',
          effectiveReputationScore: 50,
          inputUsdPerMillion: 4,
          outputUsdPerMillion: 20,
        },
      ],
    }],
  };
}

test('network models catalog preserves proxy peer order and effective reputation', () => {
  const catalog = buildChatServiceCatalogFromNetworkModels(modelsPayload());

  assert.deepEqual(catalog.map((entry) => entry.peerId), [venicePeerId, flashPeerId]);
  assert.deepEqual(catalog.map((entry) => entry.effectiveReputationScore), [98.31986321791896, 50]);
  assert.equal(catalog[0]?.label, 'Claude Fable 5');
  assert.equal(catalog[0]?.id, 'fable-5');
  assert.equal(catalog[0]?.peerLabel, `Venice.ai Proxy (${venicePeerId.slice(0, 8)})`);
});

test('network models catalog preserves peer pricing, capabilities, and categories', () => {
  const [entry] = buildChatServiceCatalogFromNetworkModels(modelsPayload());

  assert.equal(entry?.inputUsdPerMillion, 5);
  assert.equal(entry?.outputUsdPerMillion, 30);
  assert.equal(entry?.cachedInputUsdPerMillion, 0.6);
  assert.deepEqual(entry?.categories, ['chat', 'reasoning']);
  assert.deepEqual(entry?.capabilities, {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputs: ['text', 'image'],
    outputs: ['text'],
    reasoning: true,
    toolUse: true,
    structuredOutput: true,
  });
});

test('network models catalog supports image offers and ignores invalid peers', () => {
  const catalog = buildChatServiceCatalogFromNetworkModels({
    object: 'list',
    data: [{
      name: 'GPT Image',
      peers: [
        { peerId: 'x'.repeat(40), provider: 'openai', serviceId: 'gpt-image', protocol: 'openai-images', minImageUsdPerImage: 0.04, maxImageUsdPerImage: 0.08 },
        { peerId: 'invalid', provider: 'openai', serviceId: 'broken', protocol: null },
      ],
    }],
  });

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.protocol, 'openai-images');
  assert.equal(catalog[0]?.minImageUsdPerImage, 0.04);
  assert.equal(catalog[0]?.maxImageUsdPerImage, 0.08);
});

test('persisted peer catalog keeps stale offers available during cold start', () => {
  const peerId = 'a'.repeat(40);
  const catalog = buildChatServiceCatalogFromPersistedPeers({
    discoveredPeers: [{
      peerId,
      displayName: 'Cached Seller',
      providers: ['openai'],
      lastSeen: 1,
      providerServiceApiProtocols: {
        openai: { services: { 'gpt-5.6-sol': ['openai-chat-completions'] } },
      },
      providerPricing: {
        openai: { services: { 'gpt-5.6-sol': { inputUsdPerMillion: 2, outputUsdPerMillion: 8 } } },
      },
    }],
  });

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.peerId, peerId);
  assert.equal(catalog[0]?.id, 'gpt-5.6-sol');
  assert.equal(catalog[0]?.inputUsdPerMillion, 2);
});
