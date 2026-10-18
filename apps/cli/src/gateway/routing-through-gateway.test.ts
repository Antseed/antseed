/**
 * A routing service used through the gateway, end to end: a real gateway in
 * front of a real buyer proxy, with only the network faked. The halves are
 * tested on their own elsewhere; this checks that they fit.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node'
import { BuyerProxy } from '../proxy/buyer-proxy.js'
import { GATEWAY_CONTROL_SECRET_FILE } from '../routing-policy/policy.js'
import { GatewayAccounting } from './accounting.js'
import { GatewayServer } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import { GatewayStore } from './store.js'

const SECRET = 'e'.repeat(64)
const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }
const RANKING_USDC = 1_000
const INFERENCE_USDC = 25_000

function seller(seed: string, trust: number): PeerInfo {
  return {
    peerId: seed.repeat(40) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['openai'],
    onChainReputationScore: trust,
    displayName: `Test seller ${seed}`,
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } },
    providerServiceApiProtocols: { openai: { services: { 'gpt-5': ['openai-chat-completions'] } } },
  }
}

function routingService(seed: string): PeerInfo {
  return {
    peerId: seed.repeat(40) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['alpha'],
    onChainReputationScore: 90,
    metadata: {
      peerId: seed.repeat(40), version: 12, timestamp: Date.now(), signature: '', region: 'test',
      providers: [{ provider: 'alpha', services: ['alpha-route'], maxConcurrency: 1, currentLoad: 0,
        defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        serviceApiProtocols: { 'alpha-route': ['irp-suggest'] },
        serviceUnitBillingModels: { 'alpha-route': { 'irp-suggest': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } } },
      }],
    } as unknown as NonNullable<PeerInfo['metadata']>,
  }
}

const first = seller('a', 80)
const second = seller('b', 85)
const router = routingService('d')
const ROUTER_MODEL = `${router.peerId}@alpha-route`

interface Sent { peerId: string; body: Record<string, unknown> | null }

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-gw-routing-'))
  mkdirSync(join(dir, 'buyer', 'gateway'), { recursive: true })
  writeFileSync(join(dir, 'buyer', GATEWAY_CONTROL_SECRET_FILE), `${SECRET}\n`, { mode: 0o600 })

  // The network: every send is charged and recorded against its request, like a paid seller.
  const sent: Sent[] = []
  const rankedCandidates: string[][] = []
  // Sellers that refuse with a 503 (unpaid), so the next recommendation is tried; an empty ranking fails the router.
  const failingPeers = new Set<string>()
  const ranking = { empty: false }
  let proxy: BuyerProxy
  const node = {
    router: { allowsPeerForPolicy: () => true, onResult: () => {} },
    buyerIdentities: () => [{ name: 'default', address: '0x' + '1'.repeat(40) }],
    sendRequest: async (peer: PeerInfo, request: SerializedHttpRequest) => {
      let body: Record<string, unknown> | null = null
      try { body = JSON.parse(Buffer.from(request.body).toString('utf8')) } catch { /* the ranking body is not inspected */ }
      sent.push({ peerId: peer.peerId, body })
      if (failingPeers.has(peer.peerId)) {
        return { requestId: request.requestId, statusCode: 503, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":{"message":"busy"}}') }
      }
      ;(proxy as any)._spendAttribution.record({
        requestId: request.requestId, sellerPeerId: peer.peerId,
        amountUsdc: String(peer.peerId === router.peerId ? RANKING_USDC : INFERENCE_USDC),
        inputTokens: '10', cachedInputTokens: '0', outputTokens: '5', outputImages: '0',
      })
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"choices":[]}') }
    },
  }
  // The routing service: ranks the candidates it is sent, best trust first, and is paid through the buyer.
  const modelRoutingClient = {
    listModels: async () => [{ id: 'gpt-5' }],
    async selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: any) {
      const candidates = context.candidates as Array<{ peerId: string }>
      rankedCandidates.push(candidates.map((candidate) => candidate.peerId))
      await context.sendRequest(peers.find((peer) => peer.peerId === router.peerId)!,
        { requestId: `${request.requestId}-rank`, method: 'POST', path: '/v1/routing/rank', headers: {}, body: new Uint8Array() })
      const byTrust = peers.filter((peer) => candidates.some((candidate) => candidate.peerId === peer.peerId))
        .sort((a, b) => (b.onChainReputationScore ?? 0) - (a.onChainReputationScore ?? 0))
      if (ranking.empty) return []
      const routes = byTrust.map((peer) => ({ serviceId: 'gpt-5', peerId: peer.peerId, provider: 'openai' }))
      assert.equal(context.acceptRecommendations(routes), true)
      return routes
    },
  }
  proxy = new BuyerProxy({ adaptiveRouting: { spreadTolerance: 0, explorationRate: 0 }, port: 0, dataDir: join(dir, 'buyer'), node: node as any, modelRoutingClient: modelRoutingClient as any })
  ;(proxy as any)._getPeers = async () => [first, second, router]
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  ;(proxy as any)._mergeStateFile = async () => {}
  const buyerServer = (proxy as any)._server
  await new Promise<void>((resolve) => buyerServer.listen(0, '127.0.0.1', resolve))
  const buyerPort = (buyerServer.address() as AddressInfo).port

  const store = new GatewayStore(join(dir, 'gateway'))
  const accounting = new GatewayAccounting(store, { holdUsdc: 100_000, settleGraceMs: 20 })
  const feed = new SpendFeedPoller({ buyerPort, controlSecret: SECRET, onPage: (page) => { accounting.ingest(page.bootId, page.events) }, intervalMs: 60_000 })
  const gateway = new GatewayServer({
    store, accounting, buyerPort, controlSecret: SECRET, console: null,
    identityAddress: async () => null, spendFeedState: () => feed.state, refreshSpendFeed: () => feed.pollOnce(),
  })
  const port = await gateway.start()

  t.after(async () => {
    await gateway.stop()
    accounting.dispose()
    await (proxy as any)._conversations.flush()
    await new Promise<void>((resolve) => buyerServer.close(() => resolve()))
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const call = async (secret: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers }
  }
  return { store, feed, call, sent, rankedCandidates, failingPeers, ranking }
}

const chatBody = { model: ROUTER_MODEL, messages: [{ role: 'user', content: 'Hello' }], routing: { cost_quality_tradeoff: 7 } }

test('a key naming a routing service gets an answer from the seller it picked, among the sellers the key allows', async (t) => {
  const ctx = await setup(t)
  const { secret, key } = ctx.store.createKey({ label: 'team', limits: NO_LIMITS, expiresAt: null, routingPolicy: { blockedPeerIds: [second.peerId] } })

  const res = await ctx.call(secret, '/v1/chat/completions', chatBody)
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(ctx.rankedCandidates, [[first.peerId]], 'the router only ranks sellers the key allows')
  assert.deepEqual(ctx.sent.map((entry) => entry.peerId), [router.peerId, first.peerId])
  const inference = ctx.sent[1]!.body!
  assert.equal(inference['routing'], undefined, 'routing options never reach the seller')
  assert.equal(inference['model'], 'gpt-5')

  assert.equal(res.headers.get('x-antseed-router-peer-id'), router.peerId, 'the client sees which router ranked it')
  assert.equal(res.headers.get('x-antseed-router-service'), 'alpha-route')
  assert.equal(res.headers.get('x-antseed-router-rank'), '1')

  const [row] = ctx.store.listRequests({ keyId: key.id })
  assert.equal(row!.status, 200)
  assert.equal(row!.model, 'alpha-route')
  assert.equal(row!.sellerPeerId, first.peerId, 'the log names the seller that answered')
  assert.equal(row!.servedModel, 'gpt-5', 'and the model the router picked')
  assert.deepEqual(row!.router, { peerId: router.peerId, service: 'alpha-route', rank: 1 })

  // Both the ranking and the inference are charged to the key; the ranking is told apart as the router's fee.
  await ctx.feed.pollOnce()
  assert.equal(ctx.store.keyUsageSummaries([key.id], 0).get(key.id)!.spentUsdc, RANKING_USDC + INFERENCE_USDC)
  const settled = ctx.store.getRequest(row!.tag)!
  assert.equal(settled.spentUsdc, RANKING_USDC + INFERENCE_USDC)
  assert.equal(settled.routingSpentUsdc, RANKING_USDC)
  assert.equal(settled.costPending, false)

  // Usage groups by router and the log filters by it.
  const byRouter = ctx.store.usageReport({ keyId: key.id }, 'router')
  assert.deepEqual(byRouter.groups.map((group) => [group.group, group.requests, group.spentUsdc]), [[router.peerId, 1, RANKING_USDC + INFERENCE_USDC]])
  assert.equal(ctx.store.listRequests({ keyId: key.id, routerPeerId: router.peerId }).length, 1)
  assert.equal(ctx.store.listRequests({ keyId: key.id, routerPeerId: first.peerId }).length, 0)
})

test('a routed request served by the router\'s second pick records that rank', async (t) => {
  const ctx = await setup(t)
  const { secret, key } = ctx.store.createKey({ label: 'team', limits: NO_LIMITS, expiresAt: null, routingPolicy: null })
  ctx.failingPeers.add(second.peerId)

  const res = await ctx.call(secret, '/v1/chat/completions', chatBody)
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(ctx.sent.map((entry) => entry.peerId), [router.peerId, second.peerId, first.peerId])
  assert.equal(res.headers.get('x-antseed-router-rank'), '2')
  const [row] = ctx.store.listRequests({ keyId: key.id })
  assert.equal(row!.sellerPeerId, first.peerId)
  assert.deepEqual(row!.router, { peerId: router.peerId, service: 'alpha-route', rank: 2 })
})

test('a failed ranking is logged against the router, with no seller', async (t) => {
  const ctx = await setup(t)
  const { secret, key } = ctx.store.createKey({ label: 'team', limits: NO_LIMITS, expiresAt: null, routingPolicy: null })
  ctx.ranking.empty = true

  const res = await ctx.call(secret, '/v1/chat/completions', chatBody)
  assert.equal(res.status, 502, res.text)
  assert.equal(res.headers.get('x-antseed-router-peer-id'), router.peerId)
  const [row] = ctx.store.listRequests({ keyId: key.id })
  assert.equal(row!.status, 502)
  assert.equal(row!.sellerPeerId, null, 'the router is not reported as the seller')
  assert.deepEqual(row!.router, { peerId: router.peerId, service: 'alpha-route', rank: null })
})

test('a key limited to other models cannot use a routing service, and no ranking is bought', async (t) => {
  const ctx = await setup(t)
  const limited = ctx.store.createKey({ label: 'limited', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['gpt-5'] } })
  const res = await ctx.call(limited.secret, '/v1/chat/completions', chatBody)
  assert.equal(res.status, 403)
  assert.equal(res.json.error.code, 'model_not_allowed')
  assert.deepEqual(ctx.sent, [])

  const routerAllowed = ctx.store.createKey({ label: 'router', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['alpha-route', 'gpt-5'] } })
  assert.equal((await ctx.call(routerAllowed.secret, '/v1/chat/completions', chatBody)).status, 200)
})

test('a key whose policy blocks the routing service is refused before any ranking is bought', async (t) => {
  const ctx = await setup(t)
  const blocked = ctx.store.createKey({ label: 'blocked', limits: NO_LIMITS, expiresAt: null, routingPolicy: { blockedPeerIds: [router.peerId] } })
  const res = await ctx.call(blocked.secret, '/v1/chat/completions', chatBody)
  assert.equal(res.status, 403)
  assert.equal(res.json.error.code, 'peer_not_allowed')
  assert.deepEqual(ctx.sent, [])
})

test('/v1/models?type=router through a key lists the routers that key may use', async (t) => {
  const ctx = await setup(t)
  const open = ctx.store.createKey({ label: 'open', limits: NO_LIMITS, expiresAt: null })
  const listed = await ctx.call(open.secret, '/v1/models?type=router')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.json.data.map((entry: any) => [entry.id, entry.peers[0].model]), [['alpha-route', ROUTER_MODEL]])

  const limited = ctx.store.createKey({ label: 'limited', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['gpt-5'] } })
  assert.deepEqual((await ctx.call(limited.secret, '/v1/models?type=router')).json.data, [])
})
