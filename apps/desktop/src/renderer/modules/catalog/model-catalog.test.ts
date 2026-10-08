import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DiscoverRow, VprSelectedModel } from '../../core/state';
import { createInitialUiState } from '../../core/state';
import { filterTeeBrowseRows, projectTeeBrowseCatalog, teeBrowseCache } from './tee-browse';
import { filterVprCatalog, sortVprCatalog } from './view-models';
import { chooseBestVprRoute, isRouteEligibleForAutoSelection } from '../routing/select';
import { writeRetainedState } from '../../ui/hooks/useRetainedState';
import * as baselines from './openrouter-baseline';
import {
  createVprRouteSelection,
  findCatalogEntry,
  projectRowsToVprModelCatalog,
  selectDefaultVprModel,
  sortFreeModelsByPriority,
} from './model-catalog.js';

test('TEE browsing counts distinct sellers and intersects pricing with matching offers', () => {
  const preferences = { ...createInitialUiState().vprRoutingPreferences, minTrustScore: 0 };
  const rows = [
    discoverRow({ peerId: 'standard', serviceId: 'gpt-test', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }),
    discoverRow({ peerId: 'tee', serviceId: 'gpt-test', advertisedVerifierIds: ['antseed-verifier'], inputUsdPerMillion: 2, outputUsdPerMillion: 4 }),
    discoverRow({ peerId: 'tee', serviceId: 'openai/gpt-test', advertisedVerifierIds: ['antseed-verifier'], inputUsdPerMillion: 2, outputUsdPerMillion: 4 }),
    discoverRow({ peerId: 'other', serviceId: 'another-model', advertisedVerifierIds: ['acme'] }),
  ];
  const catalog = projectRowsToVprModelCatalog(rows);
  const snapshot = structuredClone({ rows, catalog, preferences });
  const routeBefore = chooseBestVprRoute(rows, preferences);
  const pin = createVprRouteSelection(catalog[0], 'standard');
  const pinBefore = structuredClone(pin);
  const filtered = projectTeeBrowseCatalog(catalog, rows, preferences, 'tee');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].peerCount, 1);
  assert.equal(filtered[0].minInputUsdPerMillion, 2);
  assert.equal(filtered[0].minOutputUsdPerMillion, 4);
  assert.equal(filtered[0].hasEligibleFreeSeller, false);
  assert.equal(filtered[0].serviceId, catalog[0].serviceId);
  assert.deepEqual(filterVprCatalog(filtered, { freeOnly: true }), []);
  assert.deepEqual(filterVprCatalog(filtered, { search: 'gpt', kinds: ['text'] }), filtered);
  assert.deepEqual(filterVprCatalog(filtered, { kinds: ['image'] }), []);
  assert.deepEqual(sortVprCatalog(filtered, 'Price'), filtered);
  assert.equal(filterTeeBrowseRows(rows, 'tee').length, 2);
  assert.equal(projectTeeBrowseCatalog(catalog, rows, preferences, 'all'), catalog);
  assert.equal(filterTeeBrowseRows(rows, 'all'), rows);
  assert.deepEqual({ rows, catalog, preferences }, snapshot);
  assert.deepEqual(pin, pinBefore);
  assert.equal(chooseBestVprRoute(rows, preferences), routeBefore);
  const withdrawn = rows.map((row) => ({ ...row, advertisedVerifierIds: [] }));
  assert.deepEqual(projectTeeBrowseCatalog(catalog, withdrawn, preferences, 'tee'), []);
});

test('TEE browsing keeps existing trust-based pricing eligibility and fallback', () => {
  const preferences = { ...createInitialUiState().vprRoutingPreferences, minTrustScore: 60 };
  const rows = [
    discoverRow({ peerId: 'low', advertisedVerifierIds: ['antseed-verifier'], effectiveReputationScore: 10, inputUsdPerMillion: 0, outputUsdPerMillion: 0 }),
    discoverRow({ peerId: 'high', advertisedVerifierIds: ['antseed-verifier'], effectiveReputationScore: 90, inputUsdPerMillion: 3, outputUsdPerMillion: 6 }),
  ];
  const catalog = projectRowsToVprModelCatalog(rows, (row) => isRouteEligibleForAutoSelection(row, preferences));
  const [filtered] = projectTeeBrowseCatalog(catalog, rows, preferences, 'tee');
  assert.equal(filtered.minInputUsdPerMillion, 3);
  assert.equal(filtered.hasEligibleFreeSeller, false);
  const [fallback] = projectTeeBrowseCatalog(catalog, [rows[0]], preferences, 'tee');
  assert.equal(fallback.minInputUsdPerMillion, 0);
  assert.equal(fallback.hasEligibleFreeSeller, false);
});

test('TEE browsing retains its session filter without storing routing preferences', () => {
  assert.equal(teeBrowseCache.filter, 'all');
  writeRetainedState(teeBrowseCache, 'filter', 'tee');
  assert.equal(teeBrowseCache.filter, 'tee');
  writeRetainedState(teeBrowseCache, 'filter', 'all');
});

test('TEE display savings use matching prices rather than the unfiltered free offer', () => {
  const reference = vi.spyOn(baselines, 'getCachedOpenRouterPrices').mockReturnValue({ 'gpt-test': { input: 4, output: 8 } });
  try {
    const rows = [
      discoverRow({ peerId: 'standard', serviceId: 'gpt-test', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }),
      discoverRow({ peerId: 'tee', serviceId: 'gpt-test', advertisedVerifierIds: ['antseed-verifier'], inputUsdPerMillion: 2, outputUsdPerMillion: 4 }),
    ];
    const catalog = projectRowsToVprModelCatalog(rows);
    const [filtered] = projectTeeBrowseCatalog(catalog, rows, createInitialUiState().vprRoutingPreferences, 'tee');
    assert.equal(filtered.expectedSavingsPct, 50);
    assert.equal(filtered.baselineInputUsdPerMillion, 4);
    assert.equal(catalog[0].expectedSavingsPct, null);
  } finally {
    reference.mockRestore();
  }
});

test('TEE browsing uses image offer prices and excludes unknown advertisements', () => {
  const rows = [
    discoverRow({ peerId: 'standard', serviceId: 'art', protocol: 'openai-images', minImageUsdPerImage: 0, maxImageUsdPerImage: 0 }),
    discoverRow({ peerId: 'tee', serviceId: 'art', protocol: 'openai-images', advertisedVerifierIds: ['antseed-verifier'], minImageUsdPerImage: 0.04, maxImageUsdPerImage: 0.08 }),
    discoverRow({ peerId: 'unrelated', serviceId: 'text', advertisedVerifierIds: ['other-verifier'] }),
  ];
  const filtered = projectTeeBrowseCatalog(projectRowsToVprModelCatalog(rows), rows, createInitialUiState().vprRoutingPreferences, 'tee');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].kind, 'image');
  assert.equal(filtered[0].minImageUsdPerImage, 0.04);
  assert.equal(filtered[0].maxImageUsdPerImage, 0.08);
  assert.deepEqual(filterVprCatalog(filtered, { freeOnly: true }), []);
});

function discoverRow(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  const peerId = overrides.peerId ?? 'p1';
  const serviceId = overrides.serviceId ?? 's1';
  const provider = overrides.provider ?? 'openai';
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
    onChainSybilRisk: null,
    onChainSybilFlags: [],
    networkRequests: null,
    networkInputTokens: null,
    networkOutputTokens: null,
    selectionValue: `${provider}\u0001${serviceId}\u0001${peerId}`,
    ...overrides,
  };
}

test('groups two peers with the same provider/service into one catalog entry', () => {
  const rows = [
    discoverRow({ peerId: 'p1', serviceLabel: 'GPT Test', categories: ['chat'] }),
    discoverRow({ peerId: 'p2', serviceLabel: '', categories: ['code', 'chat'] }),
  ];

  const catalog = projectRowsToVprModelCatalog(rows);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].provider, 'openai');
  assert.equal(catalog[0].serviceId, 's1');
  assert.equal(catalog[0].label, 'GPT Test');
  assert.equal(catalog[0].peerCount, 2);
  assert.deepEqual(catalog[0].categories, ['chat', 'code']);
});

test('price min/max ignores null values', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'p1', inputUsdPerMillion: null, outputUsdPerMillion: 9 }),
    discoverRow({ peerId: 'p2', inputUsdPerMillion: 2, outputUsdPerMillion: null }),
    discoverRow({ peerId: 'p3', inputUsdPerMillion: 5, outputUsdPerMillion: 4 }),
  ]);

  assert.equal(entry.minInputUsdPerMillion, 5);
  assert.equal(entry.maxInputUsdPerMillion, 5);
  assert.equal(entry.minOutputUsdPerMillion, 4);
  assert.equal(entry.maxOutputUsdPerMillion, 9);
  assert.equal(entry.minCachedInputUsdPerMillion, null);
  assert.equal(entry.maxCachedInputUsdPerMillion, null);
});

test('catalog input/output prices come from the best route while cached price spans the group', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'low-input', inputUsdPerMillion: 1, outputUsdPerMillion: 20, cachedInputUsdPerMillion: 0.1 }),
    discoverRow({ peerId: 'low-output', inputUsdPerMillion: 8, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.8 }),
  ]);

  assert.equal(entry.bestPeerId, 'low-output');
  assert.equal(entry.minInputUsdPerMillion, 8);
  assert.equal(entry.minOutputUsdPerMillion, 2);
  assert.equal(entry.minCachedInputUsdPerMillion, 0.1);
  assert.equal(entry.maxCachedInputUsdPerMillion, 0.8);
});

test('catalog retains cached-input pricing from a non-representative unified route', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({
      peerId: 'cheap-coding-only',
      serviceId: 'fable-5-coding-only',
      inputUsdPerMillion: 0.45,
      outputUsdPerMillion: 1.15,
      cachedInputUsdPerMillion: null,
    }),
    discoverRow({
      peerId: 'cached-fable',
      serviceId: 'claude-fable-5',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
      cachedInputUsdPerMillion: 0.6,
    }),
  ]);

  assert.equal(entry.bestPeerId, 'cached-fable');
  assert.equal(entry.serviceId, 'claude-fable-5');
  assert.equal(entry.minCachedInputUsdPerMillion, 0.6);
  assert.equal(entry.maxCachedInputUsdPerMillion, 0.6);
});

test('expectedSavingsPct stays unset until a retail baseline is applied', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'p1', inputUsdPerMillion: 4, outputUsdPerMillion: 6 }),
    discoverRow({ peerId: 'p2', inputUsdPerMillion: 8, outputUsdPerMillion: 12 }),
  ]);

  assert.equal(entry.expectedSavingsPct, null);
});

test('bestPeerId picks the lowest priced peer', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ peerId: 'expensive', inputUsdPerMillion: 8, outputUsdPerMillion: 12 }),
    discoverRow({ peerId: 'cheap', inputUsdPerMillion: 4, outputUsdPerMillion: 6 }),
  ]);

  assert.equal(entry.bestPeerId, 'cheap');
});

test('selectDefaultVprModel preserves an existing selected model when present', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'anthropic', serviceId: 'claude', serviceLabel: 'Claude' }),
  ]);
  const current: VprSelectedModel = {
    provider: 'anthropic',
    serviceId: 'claude',
    label: 'Pinned Label',
    categories: ['existing'],
  };

  assert.equal(selectDefaultVprModel(catalog, current), current);
});

test('selectDefaultVprModel falls back to the first sorted catalog entry', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'z', serviceLabel: 'Zed', peerId: 'p1' }),
    discoverRow({ provider: 'anthropic', serviceId: 'a', serviceLabel: 'Alpha', peerId: 'p2' }),
    discoverRow({ provider: 'anthropic', serviceId: 'a', serviceLabel: 'Alpha', peerId: 'p3' }),
  ]);

  assert.deepEqual(selectDefaultVprModel(catalog, null), {
    provider: 'anthropic',
    serviceId: 'a',
    label: 'Alpha',
    categories: [],
  });
});

test('selectDefaultVprModel prefers a free model for the first selection', () => {
  const catalog = projectRowsToVprModelCatalog([
    // Popular paid frontier model (more peers = sorted first).
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', serviceLabel: 'GPT 5.6', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', serviceLabel: 'GPT 5.6', peerId: 'p2' }),
    // Free model with a single seller.
    discoverRow({
      provider: 'openai',
      serviceId: 'free-mini',
      serviceLabel: 'Free Mini',
      peerId: 'p3',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
  ]);

  assert.equal(selectDefaultVprModel(catalog, null)?.serviceId, 'free-mini');
});

test('selectDefaultVprModel skips a free model without a routable free peer', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', serviceLabel: 'GPT 5.6', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', serviceLabel: 'GPT 5.6', peerId: 'p2' }),
    // Free entry whose only free seller the eligibility gate rejects.
    discoverRow({
      provider: 'openai',
      serviceId: 'gated-free',
      serviceLabel: 'Gated Free',
      peerId: 'p3',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
    // Free entry with a routable free seller.
    discoverRow({
      provider: 'openai',
      serviceId: 'open-free',
      serviceLabel: 'Open Free',
      peerId: 'p4',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
  ]);
  const freeRouteReputation = (entry: { serviceId: string }): number | null =>
    (entry.serviceId === 'open-free' ? 75 : null);

  assert.equal(selectDefaultVprModel(catalog, null, freeRouteReputation)?.serviceId, 'open-free');
});

test('catalog pricing ignores sellers auto-routing would not pick', () => {
  // Hana-style case: an untrusted seller offers the model for $0 while the
  // trusted sellers charge — the entry must NOT read as free, because a send
  // would really route (and bill) through a trusted paid seller.
  const [entry] = projectRowsToVprModelCatalog(
    [
      discoverRow({ peerId: 'untrusted-free', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }),
      discoverRow({ peerId: 'trusted-paid', inputUsdPerMillion: 0.135, outputUsdPerMillion: 0.54 }),
    ],
    (row) => row.peerId !== 'untrusted-free',
  );

  assert.equal(entry.minInputUsdPerMillion, 0.135);
  assert.equal(entry.minOutputUsdPerMillion, 0.54);
  assert.equal(entry.peerCount, 2);
});

test('catalog pricing falls back to all sellers when none pass the gate', () => {
  const [entry] = projectRowsToVprModelCatalog(
    [discoverRow({ peerId: 'only-untrusted', inputUsdPerMillion: 0, outputUsdPerMillion: 0 })],
    () => false,
  );

  assert.equal(entry.minInputUsdPerMillion, 0);
  assert.equal(entry.minOutputUsdPerMillion, 0);
});

test('selectDefaultVprModel picks the free model whose seller has the highest trust score', () => {
  const catalog = projectRowsToVprModelCatalog([
    // More peers = sorted first in the catalog, but its free seller is barely trusted.
    discoverRow({
      provider: 'openai',
      serviceId: 'barely-free',
      serviceLabel: 'Barely Free',
      peerId: 'p1',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
    discoverRow({ provider: 'openai', serviceId: 'barely-free', peerId: 'p2' }),
    discoverRow({
      provider: 'openai',
      serviceId: 'proven-free',
      serviceLabel: 'Proven Free',
      peerId: 'p3',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
  ]);
  const freeRouteReputation = (entry: { serviceId: string }): number | null => {
    if (entry.serviceId === 'barely-free') return 61;
    if (entry.serviceId === 'proven-free') return 94;
    return null;
  };

  assert.equal(selectDefaultVprModel(catalog, null, freeRouteReputation)?.serviceId, 'proven-free');
});

test('selectDefaultVprModel prefers a priority-list free model over a higher-trust unknown one', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({
      provider: 'openai',
      serviceId: 'obscure-free',
      serviceLabel: 'Obscure Free',
      peerId: 'p1',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
    discoverRow({
      provider: 'openai',
      serviceId: 'MiniMax-M3',
      serviceLabel: 'MiniMax M3',
      peerId: 'p2',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
  ]);
  const freeRouteReputation = (entry: { serviceId: string }): number | null => {
    if (entry.serviceId === 'obscure-free') return 99;
    if (entry.serviceId === 'MiniMax-M3') return 70;
    return null;
  };

  assert.equal(selectDefaultVprModel(catalog, null, freeRouteReputation)?.serviceId, 'MiniMax-M3');
});

test('selectDefaultVprModel keeps a model with a free route even when a paid variant raises entry prices', () => {
  // A second seller's paid cached-input price must not mask the model's
  // genuinely free route — candidacy is judged per route by the callback.
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({
      provider: 'openai',
      serviceId: 'mixed-model',
      serviceLabel: 'Mixed Model',
      peerId: 'free-seller',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
    discoverRow({
      provider: 'openai',
      serviceId: 'mixed-model',
      peerId: 'paid-seller',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.1,
    }),
  ]);

  assert.equal(
    selectDefaultVprModel(catalog, null, () => 80)?.serviceId,
    'mixed-model',
  );
});

test('selectDefaultVprModel falls back to the popular pick when no free model is routable', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', serviceLabel: 'GPT 5.6', peerId: 'p1' }),
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6', serviceLabel: 'GPT 5.6', peerId: 'p2' }),
    discoverRow({
      provider: 'openai',
      serviceId: 'gated-free',
      serviceLabel: 'Gated Free',
      peerId: 'p3',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
  ]);

  assert.equal(selectDefaultVprModel(catalog, null, () => null)?.serviceId, 'gpt-5.6');
});

test('findCatalogEntry returns null when the service is absent', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 's1' }),
  ]);

  assert.equal(findCatalogEntry(catalog, 'openai', 'other-model'), null);
});

test('findCatalogEntry matches canonical serviceId variants across providers', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna' }),
  ]);

  assert.equal(findCatalogEntry(catalog, 'other-provider', 'GPT 5.6 Luna')?.serviceId, 'gpt-5.6-luna');
});

test('catalog classifies image services without aggregating peer capabilities', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({
      serviceId: 'gpt-image-test',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'], supportedParameters: ['quality'] },
      minImageUsdPerImage: 0.04,
      maxImageUsdPerImage: 0.08,
    }),
  ]);

  assert.equal(entry.kind, 'image');
  assert.deepEqual(entry.protocols, ['openai-images']);
  assert.equal(entry.minImageUsdPerImage, 0.04);
  assert.equal(entry.maxImageUsdPerImage, 0.08);
  assert.equal('capabilities' in entry, false);
});

test('image model route selections support both Auto and explicit seller pins', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({
      serviceId: 'image-model',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'] },
      minImageUsdPerImage: 0.04,
      maxImageUsdPerImage: 0.04,
    }),
  ]);

  assert.deepEqual(createVprRouteSelection(entry, null), {
    model: {
      provider: entry.provider,
      serviceId: entry.serviceId,
      label: entry.label,
      categories: [],
    },
    mode: 'auto',
    peerId: null,
  });
  assert.deepEqual(createVprRouteSelection(entry, ' image-peer '), {
    model: {
      provider: entry.provider,
      serviceId: entry.serviceId,
      label: entry.label,
      categories: [],
    },
    mode: 'pinned-peer',
    peerId: 'image-peer',
  });
});

test('catalog chooses the cheapest image seller by per-image pricing', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({
      peerId: 'expensive-image-peer',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'] },
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      minImageUsdPerImage: 0.08,
      maxImageUsdPerImage: 0.12,
    }),
    discoverRow({
      peerId: 'cheap-image-peer',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'] },
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      minImageUsdPerImage: 0.04,
      maxImageUsdPerImage: 0.06,
    }),
  ]);

  assert.equal(entry.bestPeerId, 'cheap-image-peer');
  assert.equal(entry.minImageUsdPerImage, 0.04);
  assert.equal(entry.maxImageUsdPerImage, 0.12);
});

test('selectDefaultVprModel ignores image-only services for the chat fallback', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({
      serviceId: 'image-free',
      protocol: 'openai-images',
      capabilities: { outputs: ['image'] },
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    }),
    discoverRow({ serviceId: 'text-paid', peerId: 'p2' }),
  ]);

  assert.equal(selectDefaultVprModel(catalog, null)?.serviceId, 'text-paid');
});

test('catalog aggregates serviceId variants of the same model', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-5.6-luna', peerId: 'p1', inputUsdPerMillion: 4, outputUsdPerMillion: 6 }),
    discoverRow({ provider: 'openai-responses', serviceId: 'GPT 5.6 Luna', peerId: 'p2', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }),
    discoverRow({ provider: 'openai', serviceId: 'openai/gpt-5.6-luna', peerId: 'p3', inputUsdPerMillion: 8, outputUsdPerMillion: 12 }),
  ]);

  assert.equal(catalog.length, 1);
  const [entry] = catalog;
  assert.equal(entry.peerCount, 3);
  // Representative provider/serviceId come from the best priced route so
  // dispatching (bestPeerId, serviceId) matches what that peer advertises.
  assert.equal(entry.bestPeerId, 'p2');
  assert.equal(entry.serviceId, 'GPT 5.6 Luna');
  assert.equal(entry.provider, 'openai-responses');
  assert.equal(entry.label, 'GPT 5.6 Luna');
});

test('catalog uses the protocol preferred name for compact GPT aliases', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'gpt-56-luna', peerId: 'p1' }),
    discoverRow({ provider: 'openai-responses', serviceId: 'gpt-5.6-luna', peerId: 'p2' }),
  ]);

  assert.equal(entry.label, 'GPT 5.6 Luna');
});

test('catalog uses the protocol preferred name for MiniMax aliases', () => {
  const [entry] = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'openai', serviceId: 'minimax-m2-5', peerId: 'p1' }),
    discoverRow({ provider: 'openai-responses', serviceId: 'MiniMax-M2.5', peerId: 'p2' }),
    discoverRow({ provider: 'openai', serviceId: 'minimax-m25', peerId: 'p3' }),
  ]);

  assert.equal(entry.label, 'MiniMax M2.5');
  assert.equal(entry.peerCount, 3);
});

test('catalog uses the clean Fable name even when coding-only is the cheapest route', () => {
  const rows = [
    discoverRow({
      provider: 'claude-oauth',
      serviceId: 'fable-5-coding-only',
      peerId: 'cheap',
      inputUsdPerMillion: 0.45,
      outputUsdPerMillion: 1.15,
    }),
    discoverRow({
      provider: 'openai',
      serviceId: 'claude-fable-5',
      peerId: 'branded',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
    }),
    discoverRow({
      provider: 'openai',
      serviceId: 'fable-5',
      peerId: 'plain',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
    }),
  ];

  for (const orderedRows of [rows, [...rows].reverse()]) {
    const [entry] = projectRowsToVprModelCatalog(orderedRows);
    assert.equal(entry.label, 'Claude Fable 5');
    assert.equal(entry.bestPeerId, 'branded');
    assert.equal(entry.serviceId, 'claude-fable-5');
    assert.equal(entry.provider, 'openai');
  }
});

test('catalog merges Claude coding-only routes into their base model', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ provider: 'anthropic', serviceId: 'claude-opus-4.8', peerId: 'base' }),
    discoverRow({ provider: 'claude-oauth', serviceId: 'opus-4.8-coding-only', peerId: 'coding' }),
  ]);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.label, 'Claude Opus 4.8');
  assert.equal(catalog[0]?.peerCount, 2);
});

test('sortFreeModelsByPriority leads with priority-slot models, keeps availability order past them', () => {
  const catalog = projectRowsToVprModelCatalog([
    discoverRow({ serviceId: 'minimax-m2.7', peerId: 'a1' }),
    discoverRow({ serviceId: 'minimax-m2.7', peerId: 'a2' }),
    discoverRow({ serviceId: 'minimax-m2.7', peerId: 'a3' }),
    discoverRow({ serviceId: 'random-free-model', peerId: 'b1' }),
    discoverRow({ serviceId: 'random-free-model', peerId: 'b2' }),
    discoverRow({ serviceId: 'deepseek-v4-flash', peerId: 'd1' }),
  ]);

  assert.deepEqual(
    sortFreeModelsByPriority(catalog).map((entry) => entry.serviceId),
    // deepseek (slot 1) leads despite having the fewest sellers; minimax
    // follows in its slot; unslotted models keep the incoming availability
    // order at the tail.
    ['deepseek-v4-flash', 'minimax-m2.7', 'random-free-model'],
  );
});
