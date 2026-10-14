import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { decodePolicyHeader, GATEWAY_CONTROL_HEADER, ROUTING_POLICY_HEADER, type RoutingPolicy } from '../../../routing-policy/policy.js'
import type { ResolvedPolicy } from '../../policy-resolver.js'
import { ConsoleRouter, type Principal } from '../router.js'
import type { BuyerLimits, NetworkModel, Peer, RoutePreview } from '../types.js'
import { registerNetworkRoutes, type NetworkRouteOverrides } from './network.js'
import { enrichCandidates, mapNetworkModels, mapPeers, peerServices, teeVerifiedPeers } from './network-mapping.js'
import {
  call,
  fakeCanSeeWorkspace,
  fakeDeps,
  fakeRequireOrgAdmin,
  memberPrincipal,
  rejectsWith,
  startFakeBuyer,
  TEST_SECRET,
  lastRequest,
  type FakeBuyer,
} from './network-test-helpers.js'

// Obvious fake peer ids.
const PEER_A = 'aa'.repeat(20)
const PEER_B = 'bb'.repeat(20)
const PEER_C = 'cc'.repeat(20)
const NOW = 1_700_000_000_000

const PEERS_BODY = {
  ok: true,
  peers: [
    {
      peerId: PEER_A,
      displayName: 'Fake TEE Seller',
      providers: ['openai'],
      capabilities: ['verifier.antseed-verifier'],
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          services: { 'open-model-a': { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5, cachedInputUsdPerMillion: 0.1 } },
        },
      },
      providerServiceCategories: { openai: { services: { 'open-model-a': ['chat', 'coding'], 'open-model-b': ['chat'] } } },
      reputationScore: 80,
      onChainReputationScore: 61,
      trust: { score: 72, washFlagged: false },
      onChainPoolStakeAnts: 1200,
      onChainUsageShareBps: 250,
      onChainWashFlagged: false,
      verificationResults: { verified: false, checkedAtMs: 1, domains: [], github: [] },
      lastSeen: NOW - 5_000,
    },
    {
      peerId: PEER_B,
      providers: ['anthropic'],
      capabilities: [],
      providerPricing: { anthropic: { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } } },
      onChainWashFlagged: true,
      verificationResults: {
        verified: true,
        checkedAtMs: 1,
        domains: [{ domain: 'Seller.Example.com', verified: true }, { domain: 'unchecked.example.com', verified: false }],
        github: [{ username: 'fake-seller', repository: 'models', verified: true }, { username: 'bad name!', verified: true }],
      },
      lastSeen: NOW - 60_000,
    },
  ],
}

const HEALTH_BODY = {
  ok: true,
  peers: [
    { peerId: PEER_B, failureStreak: 3, cooldownUntil: NOW + 30_000, coolingDown: true },
    { peerId: PEER_A, failureStreak: 0, cooldownUntil: 0, coolingDown: false },
  ],
}

const TEE_SNAPSHOT = {
  sessionId: 's',
  verificationEnabled: true,
  evidence: [{ peerId: PEER_A, verifierId: 'antseed-verifier', fingerprint: 'f', checkedAt: NOW - 1000, expiresAt: NOW + 60_000, sellerNodeVerified: true, claims: [] }],
}

// The buyer's `/v1/models`, trimmed to the fields the console reads.
const MODELS_BODY = {
  object: 'list',
  data: [
    {
      id: 'open-model-a',
      name: 'Open Model A',
      aliases: ['open-model-a', 'open-model-a-latest'],
      type: 'text',
      context_length: 32_000,
      peers: [
        {
          peerId: PEER_A, displayName: 'Fake TEE Seller', provider: 'openai', serviceId: 'open-model-a', protocol: 'openai-chat-completions', protocols: ['openai-chat-completions', 'openai-responses'],
          type: 'text', advertisedVerifierIds: ['antseed-verifier'], capabilities: { contextWindow: 128_000, toolUse: true, inputs: ['text', 'image'] },
          reputationScore: 61, effectiveReputationScore: 64, onChainReputationScore: 61, inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5, cachedInputUsdPerMillion: 0.1,
        },
        {
          peerId: PEER_B, provider: 'anthropic', serviceId: 'Open-Model-A', protocol: null, protocols: [], type: 'text', capabilities: { contextWindow: 32_000, reasoning: false },
          reputationScore: null, effectiveReputationScore: null, onChainReputationScore: null, inputUsdPerMillion: 0, outputUsdPerMillion: 0,
        },
      ],
    },
    {
      id: 'open-image-model',
      name: 'Open Image Model',
      aliases: [],
      type: 'image',
      peers: [{ peerId: PEER_C, provider: 'fal', serviceId: 'open-image-model', protocol: null, protocols: [], type: 'image', reputationScore: 30, effectiveReputationScore: 30, onChainReputationScore: null, minImageUsdPerImage: 0.04, maxImageUsdPerImage: 0.02 }],
    },
    { name: 'no id' },
  ],
}

let buyer: FakeBuyer
let verificationAllowed = false
let modelsStatus = 200
let peersDown = false

before(async () => {
  buyer = await startFakeBuyer({
    'GET /_antseed/peers': () => (peersDown ? { status: 500, body: { error: 'boom' } } : { body: PEERS_BODY }),
    'GET /_antseed/peer-health': () => ({ body: HEALTH_BODY }),
    'GET /v1/models': () => modelsStatus === 200
      ? { body: MODELS_BODY }
      : { status: modelsStatus, body: { error: 'Buyer is not ready yet.' } },
    'GET /_antseed/verification': () => verificationAllowed
      ? { body: TEE_SNAPSHOT }
      : { status: 403, body: { error: 'Local verification authorization required' } },
    'GET /_antseed/route-preview': (req) => ({
      body: {
        model: new URL(req.url, 'http://x').searchParams.get('model'),
        candidates: [
          { peerId: PEER_A, displayName: null, rank: 1, eligible: true, reasons: ['cheapest'], inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5, trustScore: null },
          { peerId: PEER_C, displayName: 'Named By Buyer', rank: null, eligible: false, reasons: ['blocked by workspace'], inputUsdPerMillion: null, outputUsdPerMillion: null, trustScore: 40 },
        ],
        buyer: { minReputation: 40, requireVerified: true },
      },
    }),
  })
})

after(async () => {
  await buyer.close()
})

const KEY_WORKSPACES: Record<string, string> = { key_team: 'ws_team', key_other: 'ws_other' }
const store = {
  peerStats: (since: number) => {
    assert.equal(since, NOW - 24 * 60 * 60 * 1000)
    return [{ peerId: PEER_A, requests: 17, latencyMsP50: 840 }]
  },
  workspaceForKey: (keyId: string) => (KEY_WORKSPACES[keyId] ? { id: KEY_WORKSPACES[keyId] } : null),
}

const member = memberPrincipal('m_member', { ws_team: 'member' })
const orgAdmin = memberPrincipal('m_admin', {}, 'admin')
const keySession: Principal = { kind: 'key', keyId: 'key_team', sessionId: 'ks' }

const resolveCalls: Array<Record<string, string | undefined>> = []
function fakeResolvePolicy(_store: unknown, target: { keyId?: string; workspaceId?: string; memberId?: string; presetSlug?: string }): ResolvedPolicy {
  resolveCalls.push({ ...target })
  const policy: RoutingPolicy = { allowedModels: ['open-model-a'], blockedPeerIds: [PEER_C], sort: 'price' }
  return {
    policy,
    sources: [
      { level: 'buyer', id: null, policy: null },
      { level: 'gateway', id: null, policy: null },
      ...(target.workspaceId ? [{ level: 'workspace' as const, id: target.workspaceId, policy }] : []),
    ],
  }
}

function setup(extra: NetworkRouteOverrides = {}): ConsoleRouter {
  const router = new ConsoleRouter()
  registerNetworkRoutes(router, fakeDeps(store, () => NOW), {
    buyer: buyer.client,
    canSeeWorkspace: fakeCanSeeWorkspace,
    requireOrgAdmin: fakeRequireOrgAdmin,
    resolvePolicy: fakeResolvePolicy,
    ...extra,
  })
  return router
}

// ── Peers ────────────────────────────────────────────────────────────────

test('peer services price each service from its own entry or the provider default', () => {
  assert.deepEqual(peerServices(PEERS_BODY.peers[0] as Record<string, unknown>), [
    { provider: 'openai', service: 'open-model-a', inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5, cachedInputUsdPerMillion: 0.1, categories: ['chat', 'coding'] },
    { provider: 'openai', service: 'open-model-b', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: null, categories: ['chat'] },
  ])
})

test('TEE snapshot: only current passing attestations count', () => {
  const verified = teeVerifiedPeers({
    evidence: [
      ...TEE_SNAPSHOT.evidence,
      { peerId: PEER_B, verifierId: 'antseed-verifier', sellerNodeVerified: true, expiresAt: NOW - 1 },
      { peerId: PEER_C, verifierId: 'antseed-verifier', sellerNodeVerified: false, expiresAt: NOW + 1 },
    ],
  }, NOW)
  assert.deepEqual([...verified], [PEER_A])
})

test('GET peers merges buyer peers, health and gateway stats', async () => {
  verificationAllowed = false
  const peers = await call(setup(), 'GET', '/peers', member) as Peer[]
  assert.equal(peers.length, 2)
  const [a, b] = peers as [Peer, Peer]
  assert.deepEqual({ ...a, services: a.services.length }, {
    peerId: PEER_A,
    displayName: 'Fake TEE Seller',
    services: 2,
    trustScore: 72,
    // The buyer's own score wins over the seller-reported 80.
    reputationScore: 61,
    // No verification snapshot and no verified claims.
    verified: false,
    verificationLinks: [],
    tee: true,
    stakeAnts: '1200',
    usageShareBps: 250,
    washFlagged: false,
    lastSeen: NOW - 5_000,
    health: { failureStreak: 0, coolingDownUntil: null },
    latencyMsP50: 840,
    requests24h: 17,
  })
  assert.equal(b.verified, true)
  // Only claims that checked out, sanitised, as links.
  assert.deepEqual(b.verificationLinks, [
    { kind: 'domain', label: 'seller.example.com', href: 'https://seller.example.com' },
    { kind: 'github', label: '@fake-seller/models', href: 'https://github.com/fake-seller/models' },
  ])
  assert.equal(b.tee, false)
  assert.equal(b.washFlagged, true)
  assert.equal(b.trustScore, null)
  assert.equal(b.reputationScore, null)
  assert.deepEqual(b.health, { failureStreak: 3, coolingDownUntil: NOW + 30_000 })
  assert.equal(b.requests24h, 0)
  assert.equal(b.latencyMsP50, null)
  const sent = lastRequest(buyer, (url) => url === '/_antseed/peers')
  assert.equal(sent?.headers[GATEWAY_CONTROL_HEADER], TEST_SECRET)
})

test('GET peers uses the TEE snapshot when the buyer shares it', async () => {
  verificationAllowed = true
  try {
    const peers = await call(setup(), 'GET', '/peers', member) as Peer[]
    // A by its TEE attestation, B by its verified ownership claims.
    assert.deepEqual(peers.map((peer) => peer.verified), [true, true])
  } finally {
    verificationAllowed = false
  }
})

test('GET peers still answers without peer health', () => {
  const peers = mapPeers({ peers: PEERS_BODY, health: null, verification: null, stats: [], now: NOW })
  assert.deepEqual(peers[1]!.health, { failureStreak: 0, coolingDownUntil: null })
})

// ── Models ───────────────────────────────────────────────────────────────

test('network models merge the buyer catalog with the peer list', () => {
  const peers = mapPeers({ peers: PEERS_BODY, health: HEALTH_BODY, verification: null, stats: [{ peerId: PEER_A, requests: 1, latencyMsP50: 840 }], now: NOW })
  const [text, image] = mapNetworkModels(MODELS_BODY, peers) as [NetworkModel, NetworkModel]
  assert.equal(mapNetworkModels(MODELS_BODY, peers).length, 2, 'entries without an id are skipped')
  assert.deepEqual({ ...text, offers: text.offers.length }, {
    id: 'open-model-a',
    name: 'Open Model A',
    aliases: ['open-model-a-latest'],
    type: 'text',
    contextLength: 128_000,
    capabilities: ['toolUse', 'vision'],
    sellers: 2,
    inputUsdPerMillion: { min: 0, max: 0.5 },
    outputUsdPerMillion: { min: 0, max: 1.5 },
    free: true,
    teeSellers: 1,
    verifiedSellers: 1,
    offers: 2,
  })
  assert.deepEqual(text.offers[0], {
    peerId: PEER_A,
    displayName: 'Fake TEE Seller',
    serviceId: 'open-model-a',
    provider: 'openai',
    protocols: ['openai-chat-completions', 'openai-responses'],
    inputUsdPerMillion: 0.5,
    outputUsdPerMillion: 1.5,
    cachedInputUsdPerMillion: 0.1,
    usdPerImage: null,
    contextLength: 128_000,
    free: false,
    reputationScore: 64,
    trustScore: 72,
    verified: false,
    verificationLinks: [],
    tee: true,
    latencyMsP50: 840,
  })
  // B's name and verification come from the peer list; it keeps its own service id for pinning.
  const b = text.offers[1]!
  assert.deepEqual([b.serviceId, b.verified, b.free, b.trustScore, b.latencyMsP50], ['Open-Model-A', true, true, null, null])
  assert.deepEqual(b.verificationLinks.map((link) => link.label), ['seller.example.com', '@fake-seller/models'])
  // A seller the peer list does not know yet, priced per image.
  assert.equal(image.type, 'image')
  assert.equal(image.contextLength, null)
  assert.equal(image.inputUsdPerMillion, null)
  assert.deepEqual(image.offers[0]!.usdPerImage, { min: 0.02, max: 0.04 })
  assert.deepEqual([image.offers[0]!.displayName, image.offers[0]!.verified, image.offers[0]!.free], [null, false, false])
  assert.deepEqual(image.offers[0]!.verificationLinks, [])
})

test('GET models lists the unfiltered network catalog to members and tokens', async () => {
  modelsStatus = 200
  const router = setup()
  const models = await call(router, 'GET', '/models', member) as NetworkModel[]
  assert.deepEqual(models.map((model) => model.id), ['open-model-a', 'open-image-model'])
  assert.equal(models[0]!.offers[0]!.latencyMsP50, 840)
  const sent = lastRequest(buyer, (url) => url === '/v1/models')
  assert.equal(sent?.headers[GATEWAY_CONTROL_HEADER], TEST_SECRET)
  assert.equal(sent?.headers[ROUTING_POLICY_HEADER], undefined, 'no routing policy, like /peers')
  assert.equal(router.match('GET', '/models')!.route.options.allow, router.match('GET', '/peers')!.route.options.allow)
})

test('GET models reports a buyer that is down or not ready', async () => {
  modelsStatus = 503
  try {
    await rejectsWith(call(setup(), 'GET', '/models', member), 503, 'buyer_unavailable')
  } finally {
    modelsStatus = 200
  }
  const unreachable = setup({ buyer: () => Promise.reject(new Error('connect ECONNREFUSED')) })
  await rejectsWith(call(unreachable, 'GET', '/models', member), 502, 'buyer_unreachable')
})

test('GET models still answers when the peer list fails', async () => {
  peersDown = true
  try {
    const models = await call(setup(), 'GET', '/models', member) as NetworkModel[]
    assert.equal(models.length, 2)
    assert.equal(models[0]!.offers[1]!.verified, false)
    assert.equal(models[0]!.offers[0]!.tee, true, 'TEE still comes from the offer')
  } finally {
    peersDown = false
  }
})

// ── Route preview ────────────────────────────────────────────────────────

test('candidate enrichment fills names and trust from the peer list', () => {
  const candidates = enrichCandidates([{ peerId: PEER_A, eligible: true, reasons: [] }, { eligible: true }], PEERS_BODY)
  assert.deepEqual(candidates, [{ peerId: PEER_A, displayName: 'Fake TEE Seller', rank: null, eligible: true, reasons: [], inputUsdPerMillion: null, outputUsdPerMillion: null, trustScore: 72 }])
})

test('GET route-preview sends the resolved policy and enriches candidates', async () => {
  resolveCalls.length = 0
  const preview = await call(setup(), 'GET', '/route-preview?model=open-model-a&key=key_team', member) as RoutePreview
  assert.deepEqual(resolveCalls, [{ keyId: 'key_team', workspaceId: 'ws_team' }])
  assert.equal(preview.model, 'open-model-a')
  assert.equal(preview.modelAllowed, true)
  assert.deepEqual(preview.policy, { allowedModels: ['open-model-a'], blockedPeerIds: [PEER_C], sort: 'price' })
  assert.deepEqual(preview.sources.map((source) => source.level), ['buyer', 'gateway', 'workspace'])
  assert.deepEqual(preview.candidates, [
    { peerId: PEER_A, displayName: 'Fake TEE Seller', rank: 1, eligible: true, reasons: ['cheapest'], inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5, trustScore: 72 },
    { peerId: PEER_C, displayName: 'Named By Buyer', rank: null, eligible: false, reasons: ['blocked by workspace'], inputUsdPerMillion: null, outputUsdPerMillion: null, trustScore: 40 },
  ])
  const sent = lastRequest(buyer, (url) => url.startsWith('/_antseed/route-preview'))
  assert.equal(sent?.url, '/_antseed/route-preview?model=open-model-a')
  assert.deepEqual(decodePolicyHeader(String(sent?.headers[ROUTING_POLICY_HEADER])), preview.policy)
})

test('GET route-preview shows the buyer hard limits as the buyer source', async () => {
  const preview = await call(setup(), 'GET', '/route-preview?model=open-model-a&workspace=ws_team', member) as RoutePreview
  const source = preview.sources.find((entry) => entry.level === 'buyer')
  assert.equal(source?.policy?.minReputation, 40)
  assert.equal(source?.policy?.requireVerified, true)
  // Max pricing comes from the buyer config (defaults: the test config file does not exist).
  assert.equal(typeof source?.policy?.maxInputUsdPerMillion, 'number')
  assert.equal(source?.policy?.minTrustScore, undefined, 'routing preferences are not buyer limits')
  // The buyer limits are not folded into the policy the gateway sends.
  assert.equal(preview.policy.minReputation, undefined)
})

test('GET routing/buyer-limits reports the running buyer\'s hard limits to any member or key', async () => {
  const limits = await call(setup(), 'GET', '/routing/buyer-limits', keySession) as BuyerLimits
  assert.equal(limits.minPeerReputation, 40)
  assert.equal(limits.requireVerifier, true)
  assert.equal(typeof limits.maxPricing?.inputUsdPerMillion, 'number')
})

test('GET route-preview with a disallowed model skips the buyer', async () => {
  const before = buyer.requests.length
  const preview = await call(setup(), 'GET', `/route-preview?model=${PEER_A}@closed-model&workspace=ws_team`, member) as RoutePreview
  assert.equal(preview.model, 'closed-model')
  assert.equal(preview.modelAllowed, false)
  assert.deepEqual(preview.candidates, [])
  assert.equal(buyer.requests.length, before)
})

test('GET route-preview checks what the caller may see', async () => {
  const router = setup()
  await rejectsWith(call(router, 'GET', '/route-preview', member), 400)
  await rejectsWith(call(router, 'GET', '/route-preview?model=open-model-a&workspace=ws_other', member), 403)
  await rejectsWith(call(router, 'GET', '/route-preview?model=open-model-a&key=key_other', member), 404)
  await rejectsWith(call(router, 'GET', '/route-preview?model=open-model-a&key=key_missing', member), 404)
  await rejectsWith(call(router, 'GET', '/route-preview?model=open-model-a&key=key_team&workspace=ws_other', orgAdmin), 400)
  await rejectsWith(call(router, 'GET', '/route-preview?model=open-model-a&member=m_someone', member), 403)
  // Own member policy, and anything for an org admin.
  await call(router, 'GET', '/route-preview?model=open-model-a&member=m_member', member)
  await call(router, 'GET', '/route-preview?model=open-model-a&member=m_someone&key=key_other', orgAdmin)
  // Key sessions see their own key only.
  await rejectsWith(call(router, 'GET', '/route-preview?model=open-model-a&key=key_other', keySession), 403)
  resolveCalls.length = 0
  await call(router, 'GET', '/route-preview?model=open-model-a&workspace=ws_other', keySession)
  assert.deepEqual(resolveCalls, [{ keyId: 'key_team' }])
  const route = router.match('GET', '/route-preview')!.route
  assert.deepEqual(route.options.allow, ['member', 'token', 'key'])
})
