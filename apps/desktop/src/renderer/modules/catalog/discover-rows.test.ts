import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeDiscoverRow, projectRowsToChatServiceOptions } from './discover-rows.js';

test('normalizeDiscoverRow carries only normalized advertised verifier IDs', () => {
  const raw = { peerId: 'abc', serviceId: 'gpt-5' };
  assert.deepEqual(normalizeDiscoverRow({ ...raw, advertisedVerifierIds: [' Antseed-Verifier ', 'antseed-verifier', null, 'bad id'] })?.advertisedVerifierIds, ['antseed-verifier']);
  assert.deepEqual(normalizeDiscoverRow({ ...raw, advertisedVerifierIds: 'antseed-verifier' })?.advertisedVerifierIds, []);
  assert.deepEqual(normalizeDiscoverRow(raw)?.advertisedVerifierIds, []);
});

test('normalizeDiscoverRow validates the trust breakdown and its nullable parts', () => {
  const trust = {
    score: 74,
    history: { score: 40, channelCount: 50, totalVolumeUsdcMicros: 75_000_000 },
    usage: { score: 10, shareBps: 500, epoch: 11 },
    power: { score: 4, shareBps: 20, epoch: 12 },
    identity: { score: 20, kind: 'github', claim: 'portfolio' },
    washFlagged: false,
  };
  const raw = { peerId: 'abc', serviceId: 'example', trust, poolStakeAnts: 1234.5, washFlagged: false };
  const row = normalizeDiscoverRow(raw);
  assert.deepEqual(row?.trust, trust);
  assert.equal(row?.poolStakeAnts, 1234.5);
  assert.equal(row?.washFlagged, false);

  // Parts are independently nullable; an unknown identity kind drops just that part.
  assert.deepEqual(
    normalizeDiscoverRow({ ...raw, trust: { ...trust, history: null, usage: null, power: null, identity: { score: 5, kind: 'twitter', claim: 'x' }, washFlagged: null } })?.trust,
    { score: 74, history: null, usage: null, power: null, identity: null, washFlagged: null },
  );
  // The whole breakdown is dropped when the final score is missing or out of range.
  assert.equal(normalizeDiscoverRow({ ...raw, trust: { ...trust, score: 101 } })?.trust, null);
  assert.equal(normalizeDiscoverRow({ ...raw, trust: { ...trust, score: -1 } })?.trust, null);
  assert.equal(normalizeDiscoverRow({ ...raw, trust: 'bogus' })?.trust, null);
  assert.equal(normalizeDiscoverRow({ ...raw, trust: undefined })?.trust, null);
  // Non-boolean wash verdicts and negative stakes are normalized away.
  assert.equal(normalizeDiscoverRow({ ...raw, washFlagged: 'yes' })?.washFlagged, null);
  assert.equal(normalizeDiscoverRow({ ...raw, poolStakeAnts: -3 })?.poolStakeAnts, 0);
});

test('normalizeDiscoverRow rejects entries with missing peerId or serviceId', () => {
  assert.equal(normalizeDiscoverRow({}), null);
  assert.equal(normalizeDiscoverRow({ peerId: 'abc' }), null);
  assert.equal(normalizeDiscoverRow({ serviceId: 'gpt-5' }), null);
});

test('normalizeDiscoverRow populates all numeric defaults to 0 / null', () => {
  const row = normalizeDiscoverRow({
    peerId: 'abc123',
    serviceId: 'gpt-5',
    peerEvmAddress: '0xabc123',
    agentId: 1,
  });
  assert.ok(row);
  assert.equal(row!.lifetimeSessions, 0);
  assert.equal(row!.poolStakeAnts, 0);
  assert.equal(row!.trust, null);
  assert.equal(row!.washFlagged, null);
  assert.equal(row!.cachedInputUsdPerMillion, null);
  assert.equal(row!.peerIconUrl, null);
  assert.equal(row!.onChainReputationScore, null);
  assert.equal(row!.onChainSybilRisk, null);
  assert.deepEqual(row!.onChainSybilFlags, []);
  assert.deepEqual(row!.verificationLinks, []);
});

/* Regression: Discover must carry buyer.state.json Sybil metadata through to the UI. */
test('normalizeDiscoverRow preserves on-chain sybil risk and string flags', () => {
  const row = normalizeDiscoverRow({
    peerId: 'abc123',
    serviceId: 'gpt-5',
    onChainSybilRisk: 0.12,
    onChainSybilFlags: ['narrow_custom', null, 'subfloor_ticket'],
  });
  assert.ok(row);
  assert.equal(row!.onChainSybilRisk, 0.12);
  assert.deepEqual(row!.onChainSybilFlags, ['narrow_custom', 'subfloor_ticket']);
});

test('normalizeDiscoverRow preserves safe verified external links only', () => {
  const row = normalizeDiscoverRow({
    peerId: 'abc123',
    serviceId: 'gpt-5',
    peerIconUrl: 'https://example.com/favicon.ico',
    verificationLinks: [
      {
        kind: 'domain',
        label: 'example.com',
        href: 'https://example.com',
        title: ' Example Site ',
        description: ' A verified domain. ',
        faviconUrl: 'https://example.com/favicon.ico',
      },
      { kind: 'github', label: '@antseed/test', href: 'https://github.com/antseed/test' },
      { kind: 'domain', label: 'bad-icon', href: 'https://bad-icon.example', faviconUrl: 'http://bad-icon.example/favicon.ico' },
      { kind: 'domain', label: 'bad', href: 'http://example.com' },
      { kind: 'x', label: 'bad', href: 'https://example.com' },
    ],
  });
  assert.ok(row);
  assert.deepEqual(row!.verificationLinks, [
    {
      kind: 'domain',
      label: 'example.com',
      href: 'https://example.com/',
      title: 'Example Site',
      description: 'A verified domain.',
      faviconUrl: 'https://example.com/favicon.ico',
    },
    { kind: 'github', label: '@antseed/test', href: 'https://github.com/antseed/test' },
    { kind: 'domain', label: 'bad-icon', href: 'https://bad-icon.example/' },
  ]);
  assert.equal(row!.peerIconUrl, 'https://example.com/favicon.ico');
});

test('projectRowsToChatServiceOptions dedupes by (provider, service, peer)', () => {
  const rows = [
    { rowKey: 'p1:s1', serviceId: 's1', serviceLabel: 's1', categories: [], provider: 'openai', protocol: 'openai-chat-completions', peerId: 'p1', peerEvmAddress: '', sellerContract: null, verificationLinks: [], peerIconUrl: null, peerDisplayName: null, peerLabel: '', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: null, lifetimeSessions: 0, lifetimeRequests: 0, lifetimeInputTokens: 0, lifetimeOutputTokens: 0, lifetimeFirstSessionAt: null, lifetimeLastSessionAt: null, onChainChannelCount: null, agentId: 1, poolStakeAnts: 0, onChainActiveChannelCount: 0, onChainGhostCount: 0, onChainTotalVolumeUsdc: '0', onChainLastSettledAt: 0, onChainReputationScore: null, selectionValue: 'openai\u0001s1\u0001p1' },
    { rowKey: 'p1:s1', serviceId: 's1', serviceLabel: 's1', categories: [], provider: 'openai', protocol: 'openai-chat-completions', peerId: 'p1', peerEvmAddress: '', sellerContract: null, verificationLinks: [], peerIconUrl: null, peerDisplayName: null, peerLabel: '', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: null, lifetimeSessions: 0, lifetimeRequests: 0, lifetimeInputTokens: 0, lifetimeOutputTokens: 0, lifetimeFirstSessionAt: null, lifetimeLastSessionAt: null, onChainChannelCount: null, agentId: 1, poolStakeAnts: 0, onChainActiveChannelCount: 0, onChainGhostCount: 0, onChainTotalVolumeUsdc: '0', onChainLastSettledAt: 0, onChainReputationScore: null, selectionValue: 'openai\u0001s1\u0001p1' },
  ];
  const options = projectRowsToChatServiceOptions(rows);
  assert.equal(options.length, 1);
});

test('normalizeDiscoverRow preserves advertised service capabilities', () => {
  const row = normalizeDiscoverRow({
    peerId: 'abc123',
    serviceId: 'gpt-image',
    protocol: 'openai-images',
    capabilities: {
      inputs: ['text'],
      outputs: ['image'],
      contextWindow: 32_000,
      supportedParameters: ['quality', 'output_format'],
    },
  });

  assert.deepEqual(row?.capabilities, {
    inputs: ['text'],
    outputs: ['image'],
    contextWindow: 32_000,
    supportedParameters: ['quality', 'output_format'],
  });
});

test('projectRowsToChatServiceOptions excludes image-only services from chat', () => {
  const image = normalizeDiscoverRow({
    peerId: 'abc123',
    serviceId: 'gpt-image',
    provider: 'openai',
    protocol: 'openai-images',
    capabilities: { outputs: ['image'] },
  });
  const text = normalizeDiscoverRow({
    peerId: 'abc123',
    serviceId: 'gpt-text',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: { outputs: ['text'] },
  });

  assert.ok(image && text);
  assert.deepEqual(projectRowsToChatServiceOptions([image, text]).map((entry) => entry.id), ['gpt-text']);
});

test('projectRowsToChatServiceOptions preserves peer display name and cached input price', () => {
  const row = normalizeDiscoverRow({
    peerId: 'abc123',
    serviceId: 'gpt-5',
    peerDisplayName: 'Friendly Peer',
    peerLabel: '0xabc123...',
    cachedInputUsdPerMillion: 0.5,
    selectionValue: 'openai\u0001gpt-5\u0001abc123',
  });
  assert.ok(row);

  const [option] = projectRowsToChatServiceOptions([row!]);
  assert.equal(option.peerDisplayName, 'Friendly Peer');
  assert.equal(option.peerLabel, '0xabc123...');
  assert.equal(option.peerIconUrl, null);
  assert.equal(option.cachedInputUsdPerMillion, 0.5);
});
