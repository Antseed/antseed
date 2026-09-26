import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, RouteSelectionContext, Router, SerializedHttpRequest } from '@antseed/node'
import { eligibleRouterCandidates, executeRouterSelection, resolveRouterRecommendation, resolveRouterRecommendations, RoutingCatalogCache } from './router-execution.js'
import { createRoutingServiceMetadata, type RoutingCatalogV1, type RoutingPreferenceSchema } from '@antseed/node'

function createRoutingCatalog(models: RoutingCatalogV1['models'], preferencesSchema: RoutingPreferenceSchema = { type: 'object', properties: {}, additionalProperties: false }): RoutingCatalogV1 {
  const content = { version: 1 as const, preferencesSchema, models }
  return { ...content, revision: `rev-${JSON.stringify(content).length}-${models.length}` }
}

const peer = {
  peerId: 'a'.repeat(40) as PeerInfo['peerId'], providers: ['openai'], lastSeen: Date.now(), reputationScore: 90,
  providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'model-a': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } },
  providerServiceApiProtocols: { openai: { services: { 'model-a': ['openai-chat-completions'] } } },
} as PeerInfo
const request: SerializedHttpRequest = {
  requestId: 'original', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ model: 'levanto-auto', messages: [{ role: 'user', content: 'Hello' }], stream: true })),
}
const candidates = () => eligibleRouterCandidates(request, [peer], [], null, () => true)

test('recommendations resolve models or exact peers, never unsupported reasoning', () => {
  const available = candidates()
  assert.equal(available.length, 1)
  assert.equal(resolveRouterRecommendation([{ serviceId: 'model-a' }], available)?.peerId, peer.peerId)
  assert.equal(resolveRouterRecommendation([{ serviceId: 'model-a', peerId: 'b'.repeat(40) }], available), null)
  assert.equal(resolveRouterRecommendation([{ serviceId: 'model-a', inference: { reasoningEffort: 'high' } }], available), null)
  assert.equal(resolveRouterRecommendation([{ serviceId: 'missing' }, { serviceId: 'model-a' }], available)?.serviceId, 'model-a')
})

test('generic preferences are validated before invoking a router', async () => {
  let calls = 0
  const metadata = createRoutingServiceMetadata({ type: 'object', additionalProperties: false,
    properties: { policy: { type: 'string', enum: ['cost', 'quality'], default: 'cost' } } })
  const router: Router = {
    selectPeer: () => null, onResult: () => {}, routingMetadata: metadata,
    async selectRoute(_request, _peers, context) {
      calls++
      assert.deepEqual(context.preferences, { policy: 'quality' })
      assert.equal(context.preferencesSchemaHash, metadata.preferencesSchemaHash)
      return [{ serviceId: 'model-a' }]
    },
  }
  const args = { node: { sendRequest: async () => { throw new Error('unused') } }, router, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal }
  await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', preferences: { policy: 'invalid' } } }), /enum/)
  assert.equal(calls, 0)
  await executeRouterSelection({ ...args, selection: { kind: 'router', preferences: { policy: 'quality' } } })
  assert.equal(calls, 1)
})

test('plugin catalog enum schema overrides adapter defaults, restricts candidates and revalidates before purchase', async () => {
  const schema = { type: 'object' as const, additionalProperties: false as const, required: ['region'], properties: {
    region: { type: 'string' as const, enum: ['eu', 'us'] },
    strategy: { type: 'string' as const, enum: ['fast', 'balanced'], default: 'balanced' },
  } }
  let catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }], schema)
  let catalogCalls = 0
  let calls = 0
  const adapter = { routingMetadata: createRoutingServiceMetadata({ type: 'object', properties: {}, additionalProperties: false }),
    async getCatalog() { catalogCalls++; return catalog },
    async selectRoute(_request: SerializedHttpRequest, _peers: PeerInfo[], context: RouteSelectionContext) {
      calls++
      assert.deepEqual(context.preferences, { region: 'eu', strategy: 'balanced' })
      assert.equal(context.preferencesSchemaHash, createRoutingServiceMetadata(context.catalog!.preferencesSchema).preferencesSchemaHash)
      assert.deepEqual(context.candidates.map(candidate => candidate.serviceId), ['model-a'])
      return [{ serviceId: 'model-a' }]
    },
  }
  const router: Router = { selectPeer: () => null, onResult: () => {}, getModelRouterAdapter: () => adapter }
  const service = { peerId: peer.peerId, provider: 'routing-vendor', serviceId: 'route' }
  const available = [candidates()[0]!, { ...candidates()[0]!, serviceId: 'model-b' }]
  const args = { node: { sendRequest: async () => { throw new Error('unused') } }, router, request,
    peers: [peer], candidates: available, conversationKey: null, signal: new AbortController().signal }
  const invalidPreferences: Array<Record<string, string>> = [{}, { region: 'elsewhere' }, { region: 'eu', unsupported: 'value' }]
  for (const preferences of invalidPreferences) {
    await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', service, preferences } }))
  }
  assert.equal(calls, 0)
  const catalogs = new RoutingCatalogCache()
  await executeRouterSelection({ ...args, catalogs, selection: { kind: 'router', service, preferences: { region: 'eu' } } })
  await executeRouterSelection({ ...args, catalogs, selection: { kind: 'router', service, preferences: { region: 'eu' } } })
  assert.equal(calls, 2)
  const cachedCalls = catalogCalls
  catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }], {
    ...schema, properties: { ...schema.properties, region: { type: 'string', enum: ['us'] } },
  })
  await executeRouterSelection({ ...args, catalogs, selection: { kind: 'router', service, preferences: { region: 'eu' } } })
  assert.equal(catalogCalls, cachedCalls)
  await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', service, preferences: { region: 'eu' } } }), /enum/)
  assert.equal(calls, 3)
  catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-z' }], { type: 'object', properties: {}, additionalProperties: false })
  await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', service } }), /supported by this router/)
  assert.equal(calls, 3)
})

test('a failed recommendation invalidates the cached plugin catalog', async () => {
  let catalogCalls = 0
  let fail = true
  const adapter = { routingMetadata: createRoutingServiceMetadata({ type: 'object', properties: {}, additionalProperties: false }),
    async getCatalog() { catalogCalls++; return createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }]) },
    async selectRoute() { if (fail) throw new Error('Router model catalog changed'); return [{ serviceId: 'model-a' }] },
  }
  const router: Router = { selectPeer: () => null, onResult: () => {}, getModelRouterAdapter: () => adapter }
  const catalogs = new RoutingCatalogCache()
  const args = { node: { sendRequest: async () => { throw new Error('unused') } }, router, request, catalogs,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal,
    selection: { kind: 'router' as const, service: { peerId: peer.peerId, provider: 'routing-vendor', serviceId: 'route' } } }
  await assert.rejects(executeRouterSelection(args), /catalog changed/)
  fail = false
  await executeRouterSelection(args)
  assert.equal(catalogCalls, 2)
})

test('model allowlists restrict adapter candidates, acceptance, and returned fallback destinations', async () => {
  const first = candidates()[0]!
  const available = [first, { ...first, serviceId: 'model-b' }, { ...first, provider: 'other' }]
  const allowedModels = [{ provider: 'openai', serviceId: 'model-a' }]
  let calls = 0
  let forbiddenOnly = false
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      calls++
      assert.deepEqual(context.candidates.map(({ provider, serviceId }) => ({ provider, serviceId })), allowedModels)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-b' }]), false)
      return forbiddenOnly ? [{ serviceId: 'model-b' }] : [{ serviceId: 'model-b' }, { serviceId: 'model-a' }]
    },
  }
  const args = { node: { sendRequest: async () => { throw new Error('unused') } }, router, request,
    peers: [peer], candidates: available, conversationKey: null, signal: new AbortController().signal }
  const result = await executeRouterSelection({ ...args, selection: { kind: 'router', allowedModels } })
  assert.deepEqual(result.recommendations.map(route => route.serviceId), ['model-a'])
  forbiddenOnly = true
  await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', allowedModels } }), /no eligible recommendation/)
  const before = calls
  for (const blocked of [[], [{ provider: 'missing', serviceId: 'model-a' }]]) {
    await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', allowedModels: blocked } }), /model allowlist/)
  }
  assert.equal(calls, before)
})

test('routing purchases cannot substitute a different routing-service peer', async () => {
  let sent = false
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, { ...request, requestId: 'routing-request' }, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { sent = true; throw new Error('must not send') } }, router, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal,
    selection: { kind: 'router', service: { peerId: 'b'.repeat(40), provider: 'levanto', serviceId: 'levanto-route' } },
  }), /selected routing-service peer/)
  assert.equal(sent, false)
})

test('candidate construction enforces buyer restrictions, capacity, and required parameters', () => {
  assert.equal(eligibleRouterCandidates(request, [peer], [], null, () => false).length, 0)
  assert.equal(eligibleRouterCandidates(request, [{ ...peer, maxConcurrency: 1, currentLoad: 1 }], [], null, () => true).length, 0)
  assert.equal(eligibleRouterCandidates(request, [peer], ['tools'], null, () => true).length, 0)
  assert.equal(eligibleRouterCandidates(request, [peer], [], {
    preferFreePeers: false, maxInputUsdPerMillion: 0.5, minTrustScore: 0, allowedPeerIds: [], blockedPeerIds: [],
  }, () => true).length, 0)
})

test('buyer handoff preserves inference payload and sets the resolved seller/provider', async () => {
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      const routes = [{ serviceId: 'model-a' }]
      assert.equal(context.acceptRecommendations(routes), true)
      return routes
    },
  }
  const result = await executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('unexpected network request') } },
    router, request, peers: [peer], candidates: candidates(), conversationKey: 'conversation', signal: new AbortController().signal,
  })
  assert.equal(result.request.requestId, 'original')
  assert.equal(result.request.headers['x-antseed-pin-peer'], peer.peerId)
  assert.equal(result.request.headers['x-antseed-provider'], 'openai')
  assert.deepEqual(JSON.parse(Buffer.from(result.request.body).toString()), { model: 'model-a', messages: [{ role: 'user', content: 'Hello' }], stream: true })
  assert.deepEqual(result.recommendations, [{ serviceId: 'model-a', candidates: candidates() }])
  assert.equal(JSON.parse(Buffer.from(request.body).toString()).model, 'levanto-auto')
})

test('ranked recommendations retain model-only choices and deduplicate their allowed sellers in policy order', () => {
  const first = candidates()[0]!
  const second = { ...first, peerId: 'b'.repeat(40) as PeerInfo['peerId'] }
  const third = { ...first, serviceId: 'model-b' }
  const available = [first, second, third]
  const resolved = resolveRouterRecommendations([
    { serviceId: 'model-a', peerId: second.peerId },
    { serviceId: 'model-b' },
    { serviceId: 'model-a' },
    { serviceId: 'model-a', peerId: second.peerId },
  ], available)
  assert.deepEqual(resolved, [
    { serviceId: 'model-a', peerId: second.peerId, candidate: second },
    { serviceId: 'model-b', candidates: [third] },
    { serviceId: 'model-a', candidates: [first] },
  ])
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: 'model-a', peerId: second.peerId }], available), [
    { serviceId: 'model-a', peerId: second.peerId, candidate: second },
  ])
})

test('an exact peer retains its provider choices without becoming a model-only recommendation', () => {
  const first = candidates()[0]!
  const second = { ...first, provider: 'other-provider' }
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: first.serviceId, peerId: first.peerId }], [first, second]), [
    { serviceId: first.serviceId, peerId: first.peerId, candidate: first },
    { serviceId: second.serviceId, peerId: second.peerId, candidate: second },
  ])
})

test('an exact recommendation cannot switch providers on the same peer and model', () => {
  const first = candidates()[0]!
  const second = { ...first, provider: 'other-provider' }
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: first.serviceId, peerId: first.peerId, provider: second.provider }], [first, second]), [
    { serviceId: second.serviceId, peerId: second.peerId, candidate: second },
  ])
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: first.serviceId, peerId: first.peerId, provider: 'missing-provider' }], [first, second]), [])
})

test('a plugin cannot change fallback destinations after response acceptance', async () => {
  const available = candidates()
  available.push({ ...available[0]!, serviceId: 'model-b' })
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-a' }, { serviceId: 'model-b' }]), true)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-a' }]), false)
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('unused') } }, router, request, peers: [peer],
    candidates: available, conversationKey: null, signal: new AbortController().signal,
  }), /no eligible/)
})

test('explicit routing fails closed on decline and respects cancellation even if plugin ignores it', async () => {
  const router: Router = { selectPeer: () => null, onResult: () => {}, selectRoute: async () => null }
  const args = { node: { sendRequest: async () => { throw new Error('unused') } }, router, request, peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal }
  await assert.rejects(executeRouterSelection(args), /no eligible/)
  const abort = new AbortController()
  router.selectRoute = () => new Promise(() => {})
  const pending = executeRouterSelection({ ...args, signal: abort.signal })
  abort.abort(new Error('client disconnected'))
  await assert.rejects(pending, /client disconnected/)
})

test('routing purchases are registered before dispatch and retain their own immutable request ID', async () => {
  const tracked: string[] = []
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      const serviceRequest = { ...request, requestId: 'routing-purchase' }
      const pending = context.sendRequest(peer, serviceRequest, {})
      serviceRequest.requestId = 'changed-after-dispatch'
      await pending
      return [{ serviceId: 'model-a' }]
    },
  }
  await executeRouterSelection({
    node: { sendRequest: async (_peer, serviceRequest) => {
      assert.deepEqual(tracked, ['routing-purchase'])
      await Promise.resolve()
      assert.equal(serviceRequest.requestId, 'routing-purchase')
      return { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new Uint8Array() }
    } }, router, request, peers: [peer], candidates: candidates(), conversationKey: 'chat',
    signal: new AbortController().signal, onRoutingRequest: requestId => tracked.push(requestId),
  })
})

test('routing purchases cannot reuse the parent inference request ID', async () => {
  const router: Router = {
    selectPeer: () => null, onResult: () => {},
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, request, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('must not dispatch') } }, router, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal,
  }), /distinct request ID/)
})
