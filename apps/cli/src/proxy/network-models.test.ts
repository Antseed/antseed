import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizedModelReputationScore, type PeerInfo } from '@antseed/node'
import { buildNetworkModels, parseModelTypeFilter } from './network-models.js'

const NOW_MS = 1_700_000_000_000

test('network model offers preserve advertised verifiers without inferring support', () => {
  const providerPricing = { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'gpt-test': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } }
  const teePeer = makePeer({ peerId: 'a'.repeat(40), providers: ['openai'], providerPricing, capabilities: ['verifier.antseed-verifier'] })
  const legacyPeer = makePeer({ peerId: 'b'.repeat(40), providers: ['openai'], providerPricing })
  const peers = [
    teePeer,
    legacyPeer,
  ]
  const [model] = buildNetworkModels(peers, NOW_MS)
  assert.ok(model)
  assert.deepEqual(model.peers.find((peer) => peer.peerId === teePeer.peerId)?.advertisedVerifierIds, ['antseed-verifier'])
  assert.deepEqual(model.peers.find((peer) => peer.peerId === legacyPeer.peerId)?.advertisedVerifierIds, [])
  teePeer.capabilities = []
  assert.deepEqual(buildNetworkModels(peers, NOW_MS)[0]?.peers[0]?.advertisedVerifierIds, [])
})

function makePeer(overrides: Omit<Partial<PeerInfo>, 'peerId'> & { peerId: string }): PeerInfo {
  return {
    lastSeen: NOW_MS,
    providers: [],
    ...overrides,
    peerId: overrides.peerId as PeerInfo['peerId'],
  }
}

const textSeller = makePeer({
  peerId: 'a'.repeat(40),
  displayName: 'Text Seller',
  onChainReputationScore: 35,
  providerPricing: {
    openai: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      services: {
        'qwen3-coder': { inputUsdPerMillion: 3, outputUsdPerMillion: 9, cachedInputUsdPerMillion: 0.3 },
      },
    },
  },
  providerServiceApiProtocols: {
    openai: { services: { 'qwen3-coder': ['openai-chat-completions'] } },
  },
})

const imageSeller = makePeer({
  peerId: 'b'.repeat(40),
  onChainReputationScore: 75,
  providerPricing: {
    openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
  },
  providerServiceApiProtocols: {
    openai: { services: { 'flux-1-schnell': ['openai-images'] } },
  },
  providerServiceUnitBillingModels: {
    openai: {
      services: {
        'flux-1-schnell': {
          'openai-images': {
            version: 1,
            components: [
              { unit: 'output_images', priceUsd: 0.01, match: { size: '512x512' } },
              { unit: 'output_images', priceUsd: 0.05, match: { size: '1024x1024' } },
            ],
          },
        },
      },
    },
  },
})

// Announces the same text model as textSeller (different id casing) plus an
// image model identified only via capability outputs — no protocol announced.
const mixedSeller = makePeer({
  peerId: 'c'.repeat(40),
  onChainReputationScore: 85,
  providerPricing: {
    'local-llm': { defaults: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 0.7 } },
  },
  providerServiceCapabilities: {
    'local-llm': {
      services: {
        'QWEN3-Coder': { outputs: ['text'] },
        'sdxl-turbo': { outputs: ['image'] },
      },
    },
  },
})

test('parseModelTypeFilter maps query values', () => {
  assert.equal(parseModelTypeFilter(null), 'all')
  assert.equal(parseModelTypeFilter(''), 'all')
  assert.equal(parseModelTypeFilter('images'), 'image')
  assert.equal(parseModelTypeFilter('Image'), 'image')
  assert.equal(parseModelTypeFilter('text'), 'text')
  assert.equal(parseModelTypeFilter('audio'), 'invalid')
})

test('aggregates one entry per model id across peers, case-insensitively', () => {
  const models = buildNetworkModels([textSeller, imageSeller, mixedSeller], NOW_MS)
  assert.deepEqual(models.map((model) => model.id), ['flux-1-schnell', 'qwen3-coder', 'sdxl-turbo'])

  const qwen = models.find((model) => model.id === 'qwen3-coder')
  assert.ok(qwen)
  assert.equal(qwen.type, 'text')
  assert.equal(qwen.object, 'model')
  assert.equal(qwen.owned_by, 'antseed')
  assert.equal(qwen.created, Math.floor(NOW_MS / 1000))
  assert.deepEqual(qwen.aliases, ['qwen3-coder', 'qwen3coder'])
  // The missing cached-price penalty reduces reputation without forcing the
  // stronger peer behind a substantially weaker complete offer.
  assert.deepEqual(qwen.peers.map((peer) => peer.peerId), [mixedSeller.peerId, textSeller.peerId])
  assert.deepEqual(qwen.peers.map((peer) => peer.reputationScore), [85, 35])
  assert.deepEqual(qwen.peers.map((peer) => peer.effectiveReputationScore), [42.5, 35])
  assert.deepEqual(qwen.peers.map((peer) => peer.onChainReputationScore), [85, 35])
  assert.deepEqual(qwen.peers.map((peer) => peer.serviceId), ['QWEN3-Coder', 'qwen3-coder'])
})

test('sorts by the buyer trust score, falling back to the seller-reported score', () => {
  const reputationOnlySeller = makePeer({
    peerId: 'f'.repeat(40),
    reputationScore: 95,
    providerServiceApiProtocols: {
      openai: { services: { 'qwen3-coder': ['openai-chat-completions'] } },
    },
  })

  const models = buildNetworkModels([mixedSeller, reputationOnlySeller], NOW_MS)
  const qwen = models.find((model) => model.id === 'QWEN3-Coder')
  assert.ok(qwen)
  assert.deepEqual(qwen.peers.map((peer) => peer.peerId), [reputationOnlySeller.peerId, mixedSeller.peerId])
  assert.deepEqual(qwen.peers.map((peer) => peer.reputationScore), [95, 85])
  assert.deepEqual(qwen.peers.map((peer) => peer.onChainReputationScore), [null, 85])
})

test('the buyer trust score wins over a seller-reported score', () => {
  const boastful = makePeer({
    peerId: 'e'.repeat(40),
    reputationScore: 100,
    onChainReputationScore: 12,
    trust: { score: 12, history: null, usage: null, power: null, identity: { score: 12, kind: 'domain', claim: 'example.com' }, washFlagged: null },
    providerServiceApiProtocols: {
      openai: { services: { 'qwen3-coder': ['openai-chat-completions'] } },
    },
  })

  const models = buildNetworkModels([boastful, mixedSeller], NOW_MS)
  const qwen = models.find((model) => model.aliases.includes('qwen3-coder'))
  assert.ok(qwen)
  assert.deepEqual(qwen.peers.map((peer) => peer.peerId), [mixedSeller.peerId, boastful.peerId])
  assert.deepEqual(qwen.peers.map((peer) => peer.reputationScore), [85, 12])
  assert.deepEqual(qwen.peers.map((peer) => peer.onChainReputationScore), [85, 12])
})

test('sorts /models peers with the configured Price + Trust preferences', () => {
  const cobaltRelay = makePeer({
    peerId: '1'.repeat(40),
    onChainReputationScore: 99,
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 1.88, outputUsdPerMillion: 9.38 },
      },
    },
    providerServiceApiProtocols: {
      openai: { services: { 'kimi-k3': ['openai-chat-completions'] } },
    },
  })
  const emberRoute = makePeer({
    peerId: '2'.repeat(40),
    onChainReputationScore: 96,
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 0.9, outputUsdPerMillion: 2.7 },
      },
    },
    providerServiceApiProtocols: {
      openai: { services: { 'Kimi K3': ['openai-chat-completions'] } },
    },
  })

  const [model] = buildNetworkModels([cobaltRelay, emberRoute], NOW_MS, {
    routingPreferences: {
      preferFreePeers: false,
      maxInputUsdPerMillion: 25,
      minTrustScore: 60,
      allowedPeerIds: [],
      blockedPeerIds: [],
    },
  })

  assert.deepEqual(model?.peers.map((peer) => peer.peerId), [emberRoute.peerId, cobaltRelay.peerId])
})

test('configured /models sorting puts cooling peers after healthy routes', () => {
  const cooling = makePeer({
    peerId: '3'.repeat(40),
    onChainReputationScore: 99,
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } },
    providerServiceApiProtocols: {
      openai: { services: { 'health-model': ['openai-chat-completions'] } },
    },
  })
  const healthy = makePeer({
    peerId: '4'.repeat(40),
    onChainReputationScore: 70,
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } } },
    providerServiceApiProtocols: {
      openai: { services: { 'health-model': ['openai-chat-completions'] } },
    },
  })

  const [model] = buildNetworkModels([cooling, healthy], NOW_MS, {
    routingPreferences: {
      preferFreePeers: false,
      maxInputUsdPerMillion: 25,
      minTrustScore: 60,
      allowedPeerIds: [],
      blockedPeerIds: [],
    },
    peerHealth: new Map([[cooling.peerId, { cooldownUntil: NOW_MS + 30_000, failureStreak: 3 }]]),
  })

  assert.deepEqual(model?.peers.map((peer) => peer.peerId), [healthy.peerId, cooling.peerId])
})

test('returns null reputation and sorts unknown scores last', () => {
  const unknownSeller = makePeer({
    peerId: '0'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'qwen3-coder': ['openai-chat-completions'] } },
    },
  })

  const models = buildNetworkModels([unknownSeller, textSeller], NOW_MS)
  const qwen = models.find((model) => model.id === 'qwen3-coder')
  assert.ok(qwen)
  assert.deepEqual(qwen.peers.map((peer) => peer.peerId), [textSeller.peerId, unknownSeller.peerId])
  assert.deepEqual(qwen.peers.map((peer) => peer.reputationScore), [35, null])
})

test('never re-scores from raw on-chain stats; the node-assigned score is authoritative', () => {
  // Raw signals without a node-assigned score stay unscored in the catalog:
  // scoring happens once, in the node, not in every consumer.
  const peer = makePeer({
    peerId: '9'.repeat(40),
    providers: ['claude-oauth'],
    providerServiceApiProtocols: {
      'claude-oauth': { services: { 'claude-opus-4-6': ['anthropic-messages'] } },
    },
    onChainChannelCount: 20,
    onChainGhostCount: 0,
    onChainTotalVolumeUsdcMicros: 100_000_000,
    onChainUsageEpoch: 22,
    onChainUsageShareBps: 5_000,
    onChainPoolPowerShareBps: 5_000,
    onChainWashFlagged: false,
  })

  const [model] = buildNetworkModels([peer], NOW_MS)
  const [offer] = model?.peers ?? []
  assert.ok(offer)
  assert.equal(offer.onChainReputationScore, null)
  assert.equal(offer.reputationScore, null)
  assert.equal(offer.effectiveReputationScore, null)
})

test('cached-input pricing penalty can change a close reputation ranking', () => {
  const priced = makePeer({
    peerId: '1'.repeat(40),
    onChainReputationScore: 75,
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
        services: {
          'cache-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2 },
        },
      },
    },
    providerServiceApiProtocols: {
      openai: { services: { 'cache-model': ['openai-chat-completions'] } },
    },
  })
  const unpriced = makePeer({
    peerId: '2'.repeat(40),
    onChainReputationScore: 90,
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        services: { 'cache-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      },
    },
    providerServiceApiProtocols: {
      openai: { services: { 'cache-model': ['openai-chat-completions'] } },
    },
  })

  const model = buildNetworkModels([unpriced, priced], NOW_MS)[0]
  assert.deepEqual(model?.peers.map((peer) => peer.peerId), [priced.peerId, unpriced.peerId])
  assert.deepEqual(model?.peers.map((peer) => peer.reputationScore), [75, 90])
  assert.ok((model?.peers[0]?.effectiveReputationScore ?? 0) > (model?.peers[1]?.effectiveReputationScore ?? 0))
})

test('cached-input penalty applies to the fractional trust score as-is', () => {
  const flash = makePeer({
    peerId: '3'.repeat(40),
    onChainReputationScore: 99.93,
    providerServiceApiProtocols: {
      'claude-oauth': { services: { 'claude-opus-4-6': ['anthropic-messages'] } },
    },
  })
  const venice = makePeer({
    peerId: '4'.repeat(40),
    onChainReputationScore: 90.31,
    providerPricing: {
      'claude-oauth': {
        defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
        services: {
          'opus-4.6': { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 },
        },
      },
    },
    providerServiceApiProtocols: {
      'claude-oauth': { services: { 'opus-4.6': ['anthropic-messages'] } },
    },
  })

  const model = buildNetworkModels([flash, venice], NOW_MS)[0]
  assert.deepEqual(model?.peers.map((peer) => peer.peerId), [venice.peerId, flash.peerId])
  assert.equal(model?.peers[0]?.effectiveReputationScore, 90.31)
  assert.ok(Math.abs((model?.peers[1]?.effectiveReputationScore ?? 0) - 49.965) < 1e-9)
})

test('cached-input pricing penalty does not bury a substantially stronger peer', () => {
  const priced = makePeer({
    peerId: '5'.repeat(40),
    onChainReputationScore: 20,
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
        services: {
          'cache-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2 },
        },
      },
    },
    providerServiceApiProtocols: {
      openai: { services: { 'cache-model': ['openai-chat-completions'] } },
    },
  })
  const unpriced = makePeer({
    peerId: '6'.repeat(40),
    onChainReputationScore: 100,
    providerServiceApiProtocols: {
      openai: { services: { 'cache-model': ['openai-chat-completions'] } },
    },
  })

  const model = buildNetworkModels([priced, unpriced], NOW_MS)[0]
  assert.deepEqual(model?.peers.map((peer) => peer.peerId), [unpriced.peerId, priced.peerId])
  assert.ok((model?.peers[0]?.effectiveReputationScore ?? 0) > (model?.peers[1]?.effectiveReputationScore ?? 0))
})

test('keeps reputation ordering when no offer reports cached-input pricing', () => {
  const lower = makePeer({
    peerId: '3'.repeat(40),
    onChainReputationScore: 20,
    providerServiceApiProtocols: {
      openai: { services: { 'no-cache-model': ['openai-chat-completions'] } },
    },
  })
  const higher = makePeer({
    peerId: '4'.repeat(40),
    onChainReputationScore: 100,
    providerServiceApiProtocols: {
      openai: { services: { 'no-cache-model': ['openai-chat-completions'] } },
    },
  })

  const model = buildNetworkModels([lower, higher], NOW_MS)[0]
  assert.deepEqual(model?.peers.map((peer) => peer.peerId), [higher.peerId, lower.peerId])
  assert.deepEqual(
    model?.peers.map((peer) => peer.effectiveReputationScore),
    [normalizedModelReputationScore(higher), normalizedModelReputationScore(lower)],
  )
})

test('merges conservative family aliases while preserving advertised service ids', () => {
  const branded = makePeer({
    peerId: 'd'.repeat(40),
    providerServiceApiProtocols: {
      anthropic: { services: { 'claude-opus-5': ['anthropic-messages'] } },
    },
  })
  const unbranded = makePeer({
    peerId: 'e'.repeat(40),
    providerServiceApiProtocols: {
      anthropic: { services: { 'Opus 5': ['anthropic-messages'] } },
    },
  })

  const models = buildNetworkModels([branded, unbranded], NOW_MS)

  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'claude-opus-5')
  assert.deepEqual(models[0]?.aliases, ['claude-opus-5', 'opus-5', 'opus5'])
  assert.deepEqual(models[0]?.peers.map((peer) => peer.serviceId), ['claude-opus-5', 'Opus 5'])
})

test('merges Fable aliases and the coding-only service variant', () => {
  const branded = makePeer({
    peerId: 'a'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'claude-fable-5': ['openai-chat-completions'] } },
    },
  })
  const unbranded = makePeer({
    peerId: 'b'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'fable-5': ['openai-chat-completions'] } },
    },
  })
  const codingOnly = makePeer({
    peerId: 'c'.repeat(40),
    providerServiceApiProtocols: {
      'claude-oauth': { services: { 'fable-5-coding-only': ['anthropic-messages'] } },
    },
  })

  const models = buildNetworkModels([branded, unbranded, codingOnly], NOW_MS)

  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'claude-fable-5')
  assert.deepEqual(models[0]?.aliases, [
    'claude-fable-5',
    'fable-5',
    'fable-5-coding-only',
    'fable5',
  ])
  assert.deepEqual(models[0]?.supported_protocols, ['anthropic-messages', 'openai-chat-completions'])
  assert.deepEqual(models[0]?.peers.map((peer) => peer.serviceId), [
    'claude-fable-5',
    'fable-5',
    'fable-5-coding-only',
  ])
})

test('merges Claude coding-only aliases and displays decimal versions', () => {
  const base = makePeer({
    peerId: '7'.repeat(40),
    providerServiceApiProtocols: {
      anthropic: { services: { 'claude-opus-4.8': ['anthropic-messages'] } },
    },
  })
  const codingOnly = makePeer({
    peerId: '8'.repeat(40),
    providerServiceApiProtocols: {
      'claude-oauth': { services: { 'opus-4.8-coding-only': ['anthropic-messages'] } },
    },
  })

  const models = buildNetworkModels([base, codingOnly], NOW_MS)
  assert.equal(models.length, 1)
  assert.equal(models[0]?.name, 'Claude Opus 4.8')
  assert.deepEqual(models[0]?.peers.map((peer) => peer.serviceId), ['claude-opus-4.8', 'opus-4.8-coding-only'])
})

test('merges compact numeric versions and flattened vendor prefixes', () => {
  const dotted = makePeer({
    peerId: '1'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-5.6-sol': ['openai-responses'] } },
    },
  })
  const compact = makePeer({
    peerId: '2'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-56-sol': ['openai-responses'] } },
    },
  })
  const vendorPrefixed = makePeer({
    peerId: '3'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'openai-gpt-56-sol': ['openai-responses'] } },
    },
  })

  const models = buildNetworkModels([dotted, compact, vendorPrefixed], NOW_MS)

  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'gpt-5.6-sol')
  assert.equal(models[0]?.name, 'GPT 5.6 Sol')
  assert.deepEqual(models[0]?.aliases, ['gpt-5.6-sol', 'gpt-56-sol', 'gpt56sol', 'openai-gpt-56-sol'])
  assert.deepEqual(models[0]?.peers.map((peer) => peer.serviceId), [
    'gpt-5.6-sol',
    'gpt-56-sol',
    'openai-gpt-56-sol',
  ])
})

test('uses preferred MiniMax decimal display names across aliases', () => {
  const dotted = makePeer({
    peerId: '4'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'minimax-m2.5': ['openai-chat-completions'] } },
    },
  })
  const separated = makePeer({
    peerId: '5'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'minimax-m2-5': ['openai-chat-completions'] } },
    },
  })
  const compact = makePeer({
    peerId: '6'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'minimax-m25': ['openai-chat-completions'] } },
    },
  })

  const models = buildNetworkModels([dotted, separated, compact], NOW_MS)
  assert.equal(models.length, 1)
  assert.equal(models[0]?.name, 'MiniMax M2.5')
})

test('keeps only the lowest-priced duplicate text offer from one peer', () => {
  const peer = makePeer({
    peerId: '8'.repeat(40),
    providerPricing: {
      openai: {
        defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        services: {
          'gpt-5.6-sol': { inputUsdPerMillion: 4, outputUsdPerMillion: 8 },
          'gpt-56-sol': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        },
      },
    },
    providerServiceApiProtocols: {
      openai: {
        services: {
          'gpt-5.6-sol': ['openai-responses'],
          'gpt-56-sol': ['openai-responses'],
        },
      },
    },
  })

  const model = buildNetworkModels([peer], NOW_MS)[0]
  assert.ok(model)
  assert.equal(model.peers.length, 1)
  assert.equal(model.peers[0]?.serviceId, 'gpt-56-sol')
  assert.equal(model.peers[0]?.inputUsdPerMillion, 1)
  assert.equal(model.peers[0]?.outputUsdPerMillion, 2)
  assert.deepEqual(model.aliases, ['gpt-5.6-sol', 'gpt-56-sol', 'gpt56sol'])
})

test('keeps only the cheapest canonical offer across providers for one peer', () => {
  const peer = makePeer({
    peerId: 'a'.repeat(40),
    providers: ['anthropic', 'claude-oauth', 'openai'],
    providerPricing: {
      anthropic: {
        defaults: { inputUsdPerMillion: 18, outputUsdPerMillion: 9 },
        services: { 'claude-opus-4.8': { inputUsdPerMillion: 18, outputUsdPerMillion: 9 } },
      },
      'claude-oauth': {
        defaults: { inputUsdPerMillion: 2.25, outputUsdPerMillion: 11.25 },
        services: { 'opus-4.8-coding-only': { inputUsdPerMillion: 2.25, outputUsdPerMillion: 11.25 } },
      },
      openai: {
        defaults: { inputUsdPerMillion: 0.35, outputUsdPerMillion: 0.95 },
        services: { 'claude-opus-4-8': { inputUsdPerMillion: 0.35, outputUsdPerMillion: 0.95 } },
      },
    },
    providerServiceApiProtocols: {
      anthropic: { services: { 'claude-opus-4.8': ['anthropic-messages'] } },
      'claude-oauth': { services: { 'opus-4.8-coding-only': ['anthropic-messages'] } },
      openai: { services: { 'claude-opus-4-8': ['openai-chat-completions'] } },
    },
  })

  const model = buildNetworkModels([peer], NOW_MS)[0]
  assert.ok(model)
  assert.equal(model.peers.length, 1)
  assert.equal(model.peers[0]?.provider, 'openai')
  assert.equal(model.peers[0]?.serviceId, 'claude-opus-4-8')
  assert.equal(model.peers[0]?.inputUsdPerMillion, 0.35)
  assert.deepEqual(model.aliases, [
    'claude-opus-4-8',
    'claude-opus-4.8',
    'opus-4.8-coding-only',
    'opus48',
  ])
})

test('keeps only the lowest-priced duplicate image offer from one peer', () => {
  const peer = makePeer({
    peerId: '9'.repeat(40),
    providerServiceApiProtocols: {
      openai: {
        services: {
          'flux-1-schnell': ['openai-images'],
          'flux1-schnell': ['openai-images'],
        },
      },
    },
    providerServiceUnitBillingModels: {
      openai: {
        services: {
          'flux-1-schnell': {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.04 }],
            },
          },
          'flux1-schnell': {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.01 }],
            },
          },
        },
      },
    },
  })

  const model = buildNetworkModels([peer], NOW_MS)[0]
  assert.ok(model)
  assert.equal(model.peers.length, 1)
  assert.equal(model.peers[0]?.serviceId, 'flux1-schnell')
  assert.equal(model.peers[0]?.minImageUsdPerImage, 0.01)
})

test('prefers a known duplicate price over an unknown price', () => {
  const peer = makePeer({
    peerId: '0'.repeat(40),
    providerServiceApiProtocols: {
      openai: {
        services: {
          'flux-1-schnell': ['openai-images'],
          'flux1-schnell': ['openai-images'],
        },
      },
    },
    providerServiceUnitBillingModels: {
      openai: {
        services: {
          'flux1-schnell': {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.02 }],
            },
          },
        },
      },
    },
  })

  const model = buildNetworkModels([peer], NOW_MS)[0]
  assert.equal(model?.peers[0]?.serviceId, 'flux1-schnell')
})

test('service pricing overrides provider defaults', () => {
  const models = buildNetworkModels([textSeller], NOW_MS)
  const offer = models[0]?.peers[0]
  assert.ok(offer)
  assert.equal(offer.inputUsdPerMillion, 3)
  assert.equal(offer.outputUsdPerMillion, 9)
  assert.equal(offer.cachedInputUsdPerMillion, 0.3)
  assert.equal(offer.displayName, 'Text Seller')
})

test('exposes peer capabilities and conservative model-level guarantees', () => {
  const first = makePeer({
    peerId: '4'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-capable': ['openai-responses'] } },
    },
    providerServiceCapabilities: {
      openai: {
        services: {
          'gpt-capable': {
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
            inputs: ['text', 'image'],
            outputs: ['text'],
            reasoning: true,
            toolUse: true,
            structuredOutput: true,
            supportedParameters: ['temperature', 'tools', 'response_format'],
          },
        },
      },
    },
    providerServiceCategories: {
      openai: { services: { 'gpt-capable': ['chat', 'reasoning'] } },
    },
  })
  const second = makePeer({
    peerId: '5'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-capable': ['openai-chat-completions'] } },
    },
    providerServiceCapabilities: {
      openai: {
        services: {
          'gpt-capable': {
            contextWindow: 128_000,
            maxOutputTokens: 32_000,
            inputs: ['text'],
            outputs: ['text'],
            reasoning: false,
            toolUse: true,
            structuredOutput: false,
            supportedParameters: ['tools', 'top_p', 'temperature'],
          },
        },
      },
    },
  })

  const model = buildNetworkModels([first, second], NOW_MS)[0]
  assert.ok(model)
  assert.deepEqual(model.supported_protocols, ['openai-chat-completions', 'openai-responses'])
  assert.equal(model.context_length, 128_000)
  assert.equal(model.max_output_tokens, 32_000)
  assert.deepEqual(model.architecture, {
    input_modalities: ['text'],
    output_modalities: ['text'],
  })
  assert.deepEqual(model.capabilities, {
    reasoning: false,
    tool_use: true,
    structured_output: false,
  })
  assert.deepEqual(model.supported_parameters, ['temperature', 'tools'])
  assert.deepEqual(model.capability_coverage, {
    total_offers: 2,
    context_length: 2,
    max_output_tokens: 2,
    input_modalities: 2,
    output_modalities: 2,
    reasoning: 2,
    tool_use: 2,
    structured_output: 2,
    supported_parameters: 2,
  })
  assert.equal(model.peers[0]?.protocol, 'openai-responses')
  assert.deepEqual(model.peers[0]?.categories, ['chat', 'reasoning'])
  assert.equal(model.peers[0]?.capabilities?.contextWindow, 200_000)
})

test('does not claim model-level guarantees when any offer omits a capability', () => {
  const reported = makePeer({
    peerId: '6'.repeat(40),
    providerServiceCapabilities: {
      openai: {
        services: {
          'partially-described': {
            contextWindow: 128_000,
            inputs: ['text', 'image'],
            toolUse: true,
          },
        },
      },
    },
  })
  const unknown = makePeer({
    peerId: '7'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'partially-described': ['openai-chat-completions'] } },
    },
  })

  const model = buildNetworkModels([reported, unknown], NOW_MS)[0]
  assert.ok(model)
  assert.equal(model.context_length, undefined)
  assert.equal(model.architecture, undefined)
  assert.equal(model.capabilities, undefined)
  assert.equal(model.supported_parameters, undefined)
  assert.equal(model.capability_coverage.context_length, 1)
  assert.equal(model.capability_coverage.input_modalities, 1)
  assert.equal(model.capability_coverage.tool_use, 1)
})

test('image models are detected via protocol or capability outputs', () => {
  const models = buildNetworkModels([textSeller, imageSeller, mixedSeller], NOW_MS)
  const flux = models.find((model) => model.id === 'flux-1-schnell')
  const sdxl = models.find((model) => model.id === 'sdxl-turbo')
  assert.equal(flux?.type, 'image')
  assert.equal(sdxl?.type, 'image')
  assert.equal(flux?.peers[0]?.minImageUsdPerImage, 0.01)
  assert.equal(flux?.peers[0]?.maxImageUsdPerImage, 0.05)
})

test('type filter splits text and image models', () => {
  const models = buildNetworkModels([textSeller, imageSeller, mixedSeller], NOW_MS)
  const images = models.filter((model) => model.type === 'image')
  const text = models.filter((model) => model.type === 'text')
  assert.deepEqual(images.map((model) => model.id), ['flux-1-schnell', 'sdxl-turbo'])
  assert.deepEqual(text.map((model) => model.id), ['qwen3-coder'])
})

test('decision models are typed from the typesafe-systemone protocol', () => {
  const decision = makePeer({
    peerId: '6'.repeat(40),
    providerServiceApiProtocols: {
      typesafe: { services: { 'jev-latest': ['typesafe-systemone'] } },
    },
  })
  const models = buildNetworkModels([textSeller, decision], NOW_MS)
  const jev = models.find((model) => model.id === 'jev-latest')
  assert.equal(jev?.type, 'decision')
  assert.deepEqual(jev?.supported_protocols, ['typesafe-systemone'])
  assert.equal(parseModelTypeFilter('decisions'), 'decision')
  assert.equal(parseModelTypeFilter('decision'), 'decision')
})

test('returns an empty list when no peers are discovered', () => {
  assert.deepEqual(buildNetworkModels([], NOW_MS), [])
})

test('keeps a canonically merged model text-routable when any peer serves text', () => {
  const image = makePeer({
    peerId: '4'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'shared-model': ['openai-images'] } },
    },
  })
  const text = makePeer({
    peerId: '5'.repeat(40),
    providerServiceApiProtocols: {
      openai: { services: { 'shared model': ['openai-chat-completions'] } },
    },
  })

  const [model] = buildNetworkModels([image, text], NOW_MS)
  assert.equal(model?.type, 'text')
  assert.deepEqual(model?.peers.map((peer) => peer.type).sort(), ['image', 'text'])
})
