import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { decodePolicyHeader, GATEWAY_CONTROL_HEADER, ROUTING_POLICY_HEADER, type RoutingPolicy } from '../../../routing-policy/policy.js'
import type { ResolvedPolicy } from '../../policy-resolver.js'
import { ConsoleRouter, type Principal } from '../router.js'
import type { Peer, RoutePreview } from '../types.js'
import { registerNetworkRoutes, type NetworkRouteOverrides } from './network.js'
import { enrichCandidates, mapPeers, peerServices, teeVerifiedPeers } from './network-mapping.js'
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
      verificationResults: { verified: true, checkedAtMs: 1, domains: [], github: [] },
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

let buyer: FakeBuyer
let verificationAllowed = false

before(async () => {
  buyer = await startFakeBuyer({
    'GET /_antseed/peers': () => ({ body: PEERS_BODY }),
    'GET /_antseed/peer-health': () => ({ body: HEALTH_BODY }),
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
