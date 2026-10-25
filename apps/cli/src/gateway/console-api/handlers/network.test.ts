import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { decodePolicyHeader, GATEWAY_CONTROL_HEADER, ROUTING_POLICY_HEADER, type RoutingPolicy } from '../../../routing-policy/policy.js'
import type { ResolvedPolicy } from '../../policy-resolver.js'
import { ConsoleRouter, type Principal } from '../router.js'
import type { BuyerLimits, NetworkModel, NetworkRouter, Peer, RoutePreview } from '../types.js'
import { registerNetworkRoutes, type NetworkRouteOverrides } from './network.js'
import { encodeFreeTierCapabilities } from '@antseed/node/free-tier-program'
import { enrichCandidates, mapNetworkModels, mapNetworkRouters, mapPeers, peerServices, teeScopes, teeVerifiedPeers } from './network-mapping.js'
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
      capabilities: ['verifier.antseed-verifier', 'free-tier.v1.base.a1000.w86400000', 'free-tier.v1.tier.p520000.x5'],
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
      onChainAgentId: 42,
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
    'POST /_antseed/peer-health/clear': () => ({ body: { ok: true } }),
    'GET /v1/models': (req) => modelsStatus !== 200
      ? { status: modelsStatus, body: { error: 'Buyer is not ready yet.' } }
      : { body: new URL(req.url, 'http://x').searchParams.get('type') === 'router' ? ROUTERS_BODY : MODELS_BODY },
    'GET /_antseed/verification': () => verificationAllowed
      ? { body: TEE_SNAPSHOT }
      : { status: 403, body: { error: 'Local verification authorization required' } },
    'GET /_antseed/route-preview': (req) => ({
      body: {
        model: new URL(req.url, 'http://x').searchParams.get('model'),
        candidates: [
          { peerId: PEER_A, displayName: null, rank: 1, eligible: true, reasons: ['cheapest'], inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5, trustScore: null },
          { peerId: PEER_C, displayName: 'Named By Buyer', rank: null, eligible: false, reasons: ['blocked by workspace'], inputUsdPerMillion: null, outputUsdPerMillion: null, trustScore: 40, selection: null },
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
const audits: string[] = []
const store = {
  recordAudit: (entry: { action: string; target: { id: string | null } | null }) => { audits.push(`${entry.action} ${entry.target?.id}`) },
  peerStats: (since: number) => {
    assert.equal(since, NOW - 24 * 60 * 60 * 1000)
    return [{ peerId: PEER_A, requests: 17, latencyMsP50: 840, firstTokenMsP50: 300, tokensPerSecondP50: 55.5 }]
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
  const freeTier = { base: { maxRequestsPerAddress: 1000, maxRequestsPerIp: null, windowMs: 86_400_000 }, stakeTiers: [{ minPower: 520_000, multiplier: 5 }] }
  const row = {
    ...PEERS_BODY.peers[0],
    providerPricing: {
      openai: {
        ...PEERS_BODY.peers[0]!.providerPricing.openai,
        services: { ...PEERS_BODY.peers[0]!.providerPricing.openai!.services, 'open-model-free': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      },
    },
  }
  // The seller-wide program covers the free service only; priced ones have no program of their own.
  assert.deepEqual(peerServices(row as Record<string, unknown>), [
    { provider: 'openai', service: 'open-model-a', inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5, cachedInputUsdPerMillion: 0.1, categories: ['chat', 'coding'], freeTier: null },
    { provider: 'openai', service: 'open-model-free', inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: null, categories: [], freeTier },
    { provider: 'openai', service: 'open-model-b', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: null, categories: ['chat'], freeTier: null },
  ])
})

test('peer services and model offers carry a service’s own free-tier program', () => {
  const row = {
    ...PEERS_BODY.peers[0],
    capabilities: [
      ...PEERS_BODY.peers[0]!.capabilities,
      ...encodeFreeTierCapabilities(
        { base: { maxRequestsPerAddress: 5, maxRequestsPerIp: null, windowMs: 86_400_000, stakersOnly: true }, stakeTiers: [{ minPower: 520_000, multiplier: 5 }] },
        'open-model-b',
        { sellerWideTiers: [{ minPower: 520_000, multiplier: 5 }] },
      ),
    ],
  }
  const [a, b] = peerServices(row as Record<string, unknown>)
  // open-model-b is priced: its own program is a free allowance; open-model-a has none.
  assert.equal(a!.freeTier, null)
  assert.deepEqual(b!.freeTier, {
    base: { maxRequestsPerAddress: 5, maxRequestsPerIp: null, windowMs: 86_400_000, stakersOnly: true },
    stakeTiers: [{ minPower: 520_000, multiplier: 5 }],
  })
  const peers = mapPeers({ peers: { ...PEERS_BODY, peers: [row] }, health: HEALTH_BODY, verification: null, stats: [], now: NOW })
  const [model] = mapNetworkModels({
    // The buyer's catalog sends each offer's program; the console passes it through.
    data: [{ id: 'open-model-b', peers: [{ peerId: PEER_A, provider: 'openai', serviceId: 'open-model-b', inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeTier: b!.freeTier }] }],
  }, peers)
  assert.deepEqual(model!.offers[0]!.freeTier, b!.freeTier)
  // The seller-wide program stays on the peer.
  assert.equal(peers[0]!.freeTier?.base.stakersOnly, undefined)
})

test('peer services give a paid unit-billed service no seller-wide program', () => {
  const row = {
    ...PEERS_BODY.peers[0],
    providerPricing: { fal: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: { 'paid-image': {}, 'free-image': {} } } },
    providerServiceCategories: {},
    providerServiceApiProtocols: { fal: { services: { 'paid-image': ['openai-images'], 'free-image': ['openai-images'] } } },
    providerServiceUnitBillingModels: {
      fal: { services: {
        'paid-image': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.02 }] } },
        'free-image': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0 }] } },
      } },
    },
  }
  const services = peerServices(row as Record<string, unknown>)
  assert.equal(services.find((entry) => entry.service === 'paid-image')?.freeTier, null)
  assert.equal(services.find((entry) => entry.service === 'free-image')?.freeTier?.base.maxRequestsPerAddress, 1000)
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

test('TEE snapshot: full only when the provider TEE claim passes too', () => {
  const node = [{ claim: 'antseed-verifier:seller-node-tee-genuine', ok: true }, { claim: 'antseed-verifier:seller-bound', ok: true }]
  const scopes = teeScopes({
    evidence: [
      { peerId: PEER_A, verifierId: 'antseed-verifier', sellerNodeVerified: true, expiresAt: NOW + 1, claims: [...node, { claim: 'antseed-verifier:seller-provider-tee-genuine', ok: true }] },
      { peerId: PEER_B, verifierId: 'antseed-verifier', sellerNodeVerified: true, expiresAt: NOW + 1, claims: node },
    ],
  }, NOW)
  assert.deepEqual([...scopes], [[PEER_A, 'end-to-end'], [PEER_B, 'seller-node']])
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
    teeScope: null,
    stakeAnts: '1200',
    agentId: 42,
    freeTier: {
      base: { maxRequestsPerAddress: 1000, maxRequestsPerIp: null, windowMs: 86_400_000 },
      stakeTiers: [{ minPower: 520_000, multiplier: 5 }],
    },
    usageShareBps: 250,
    washFlagged: false,
    lastSeen: NOW - 5_000,
    health: { failureStreak: 0, coolingDownUntil: null },
    latencyMsP50: 840,
    firstTokenMsP50: 300,
    tokensPerSecondP50: 55.5,
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
    // A's snapshot has no provider TEE claim: seller node only. B is not TEE-capable.
    assert.deepEqual(peers.map((peer) => peer.teeScope), ['seller-node', null])
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
    tags: [],
    contextLength: 128_000,
    capabilities: ['toolUse', 'vision'],
    sellers: 2,
    inputUsdPerMillion: { min: 0, max: 0.5 },
    outputUsdPerMillion: { min: 0, max: 1.5 },
    free: true,
    freeForStakers: false,
    freeAllowance: false,
    teeSellers: 1,
    fullTeeSellers: 0,
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
    agentId: 42,
    // A priced offer gets no seller-wide program, only one of its own.
    freeTier: null,
    reputationScore: 64,
    trustScore: 72,
    verified: false,
    verificationLinks: [],
    tee: true,
    teeScope: null,
    latencyMsP50: 840,
    firstTokenMsP50: null,
    tokensPerSecondP50: null,
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

// ── Routers ──────────────────────────────────────────────────────────────

const ROUTERS_BODY = {
  object: 'list',
  data: [{
    id: 'fake-route', name: 'Fake Router', object: 'model', created: 0, owned_by: 'antseed', type: 'router',
    peers: [
      {
        peerId: PEER_A, displayName: 'Fake TEE Seller', provider: 'fake-routing', serviceId: 'fake-route', protocol: 'irp-suggest',
        options: [{ key: 'cost_quality_tradeoff', type: 'integer', label: 'Cost vs. quality', minimum: 0, maximum: 10, default: 5 }, { key: 'broken' }],
        model: `${PEER_A}@fake-route`, priceUsdPerRequest: 0, models: ['*'],
      },
      { peerId: PEER_C, provider: 'fake-routing', serviceId: 'fake-route', protocol: 'irp-suggest', options: [], model: `${PEER_C}@fake-route`, priceUsdPerRequest: 0.001, models: null },
      { provider: 'no-peer' },
    ],
  }],
}

test('network routers list one router per seller, with trust from the peer list', () => {
  const peers = mapPeers({ peers: PEERS_BODY, health: null, verification: null, stats: [], now: NOW })
  const [a, c] = mapNetworkRouters(ROUTERS_BODY, peers) as [NetworkRouter, NetworkRouter]
  assert.equal(mapNetworkRouters(ROUTERS_BODY, peers).length, 2, 'offers without a peer are skipped')
  assert.deepEqual(a, {
    id: `${PEER_A}@fake-route`, peerId: PEER_A, serviceId: 'fake-route', provider: 'fake-routing', name: 'Fake Router',
    sellerName: 'Fake TEE Seller', protocol: 'irp-suggest',
    options: [{ key: 'cost_quality_tradeoff', type: 'integer', label: 'Cost vs. quality', minimum: 0, maximum: 10, default: 5 }],
    priceUsdPerRequest: 0, free: true, models: ['*'], trustScore: 72, verified: false, verificationLinks: [],
  })
  assert.deepEqual([c.sellerName, c.free, c.priceUsdPerRequest, c.models, c.trustScore], [null, false, 0.001, null, null], 'a seller the peer list does not know yet')
})

test('GET routers asks the buyer for routing services without a policy', async () => {
  const routers = await call(setup(), 'GET', '/routers', member) as NetworkRouter[]
  assert.deepEqual(routers.map((router) => router.id), [`${PEER_A}@fake-route`, `${PEER_C}@fake-route`])
  const sent = lastRequest(buyer, (url) => url === '/v1/models?type=router')
  assert.equal(sent?.headers[ROUTING_POLICY_HEADER], undefined)
})

// ── Route preview ────────────────────────────────────────────────────────

test('candidate enrichment fills names and trust from the peer list', () => {
  const candidates = enrichCandidates([{ peerId: PEER_A, eligible: true, reasons: [] }, { eligible: true }], PEERS_BODY)
  assert.deepEqual(candidates, [{ peerId: PEER_A, displayName: 'Fake TEE Seller', rank: null, eligible: true, reasons: [], inputUsdPerMillion: null, outputUsdPerMillion: null, trustScore: 72, selection: null }])
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
    { peerId: PEER_A, displayName: 'Fake TEE Seller', rank: 1, eligible: true, reasons: ['cheapest'], inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5, trustScore: 72, selection: null },
    { peerId: PEER_C, displayName: 'Named By Buyer', rank: null, eligible: false, reasons: ['blocked by workspace'], inputUsdPerMillion: null, outputUsdPerMillion: null, trustScore: 40, selection: null },
  ])
  const sent = lastRequest(buyer, (url) => url.startsWith('/_antseed/route-preview'))
  assert.equal(sent?.url, '/_antseed/route-preview?model=open-model-a')
  assert.deepEqual(decodePolicyHeader(String(sent?.headers[ROUTING_POLICY_HEADER])), preview.policy)
})

test('candidate enrichment passes the buyer\'s selection numbers through and drops malformed ones', () => {
  const selection = {
    expectedCostUsd: 0.002, expectedPriceUsd: 0.0015, expectedSeconds: 3, successRate: 0.96, observations: 12, record: 'model',
    firstTokenMs: 420, tokensPerSecond: 80, lastSuccessAt: NOW, lastFailureAt: null, lastFailureReason: null,
    failing: false, coolingDown: false, stale: false, ordering: 'expected-cost', sharesTraffic: true, trafficShare: 0.6, poolSize: 2,
    channel: 'open', inFlight: 1, maxConcurrency: 8, routeChainPosition: null,
  }
  const [good, bad] = enrichCandidates([
    { peerId: PEER_A, eligible: true, reasons: [], selection },
    { peerId: PEER_B, eligible: true, reasons: [], selection: { ...selection, record: 'guess' } },
  ], PEERS_BODY)
  assert.deepEqual(good?.selection, selection)
  assert.equal(bad?.selection, null)
})

test('POST routing/seller-history/reset clears the buyer\'s record of a seller, for org admins only', async () => {
  audits.length = 0
  assert.deepEqual(await call(setup(), 'POST', '/routing/seller-history/reset', orgAdmin, { peerId: `0x${PEER_A.toUpperCase()}` }), { ok: true })
  const sent = lastRequest(buyer, (url) => url === '/_antseed/peer-health/clear')
  assert.equal(sent?.method, 'POST')
  assert.deepEqual(sent?.body, { peerId: PEER_A })
  assert.deepEqual(audits, [`routing.seller_history.reset ${PEER_A}`])
  await rejectsWith(call(setup(), 'POST', '/routing/seller-history/reset', member, { peerId: PEER_A }), 403)
  await rejectsWith(call(setup(), 'POST', '/routing/seller-history/reset', orgAdmin, { peerId: 'nope' }), 400, 'invalid_peer')
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
