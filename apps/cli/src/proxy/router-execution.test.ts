import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, ModelRouterAdapter, SerializedHttpRequest } from '@antseed/node'
import { eligibleRouterCandidates, executeRouterSelection, requestForRecommendation, resolveRouterRecommendations, RoutingCatalogCache } from './router-execution.js'
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

const metadata = createRoutingServiceMetadata({ type: 'object', properties: {}, additionalProperties: false })
const unusedNode = { sendRequest: async () => { throw new Error('unused') } }

test('recommendations keep allowed destinations in router order, each naming its provider', () => {
  const first = candidates()[0]!
  const available = [first, { ...first, serviceId: 'model-b' }, { ...first, peerId: 'b'.repeat(40), provider: 'other' }]
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: 'model-a', peerId: 'c'.repeat(40) }], available), [])
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: 'model-a', inference: { reasoningEffort: 'high' } }], available), [])
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: 'model-a', peerId: first.peerId, provider: 'other' }], available), [])
  assert.deepEqual(resolveRouterRecommendations([
    { serviceId: 'missing' },
    { serviceId: 'model-b', peerId: first.peerId, provider: 'openai' },
    { serviceId: 'model-a' },
    { serviceId: 'model-a', provider: 'openai' },
  ], available), [
    { serviceId: 'model-b', peerId: first.peerId, provider: 'openai' },
    { serviceId: 'model-a', provider: 'openai' },
    { serviceId: 'model-a', provider: 'other' },
  ])
})

test('a recommendation becomes an ordinary inference request with its own ID', () => {
  const pinned = { ...request, headers: { ...request.headers, 'x-antseed-pin-peer': 'c'.repeat(40), 'x-antseed-prefer-peer': 'd'.repeat(40), 'x-antseed-provider': 'openai' } }
  const exact = requestForRecommendation(pinned, { serviceId: 'model-a', peerId: peer.peerId, provider: 'anthropic' }, 'attempt-1')
  assert.equal(exact.requestId, 'attempt-1')
  assert.equal(exact.headers['x-antseed-pin-peer'], peer.peerId)
  assert.equal(exact.headers['x-antseed-provider'], 'anthropic')
  assert.equal(exact.headers['x-antseed-prefer-peer'], undefined)
  assert.deepEqual(JSON.parse(Buffer.from(exact.body).toString()), { model: 'model-a', messages: [{ role: 'user', content: 'Hello' }], stream: true })
  const modelOnly = requestForRecommendation(pinned, { serviceId: 'model-a' }, 'attempt-2')
  assert.equal(modelOnly.headers['x-antseed-pin-peer'], undefined)
  assert.equal(modelOnly.headers['x-antseed-provider'], 'openai')
  assert.equal(JSON.parse(Buffer.from(request.body).toString()).model, 'levanto-auto')
})

test('router catalogs restrict candidates, are cached, and refresh after a failed recommendation', async () => {
  let catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }])
  let catalogCalls = 0
  let fail = false
  const seen: string[][] = []
  const adapter: ModelRouterAdapter = { routingMetadata: metadata,
    async getCatalog() { catalogCalls++; return catalog },
    async selectRoute(_request, _peers, context) {
      seen.push(context.candidates.map(candidate => candidate.serviceId))
      assert.equal(context.catalog?.revision, catalog.revision)
      if (fail) throw new Error('Router model catalog changed')
      return [{ serviceId: 'model-a' }]
    },
  }
  const catalogs = new RoutingCatalogCache()
  const args = { node: unusedNode, adapter, request, catalogs, peers: [peer],
    candidates: [candidates()[0]!, { ...candidates()[0]!, serviceId: 'model-b' }], conversationKey: null,
    signal: new AbortController().signal,
    selection: { kind: 'router' as const, service: { peerId: peer.peerId, provider: 'routing-vendor', serviceId: 'route' } } }
  assert.deepEqual(await executeRouterSelection(args), [{ serviceId: 'model-a', provider: 'openai' }])
  await executeRouterSelection(args)
  assert.equal(catalogCalls, 1)
  assert.deepEqual(seen, [['model-a'], ['model-a']])
  fail = true
  await assert.rejects(executeRouterSelection(args), /catalog changed/)
  fail = false
  await executeRouterSelection(args)
  assert.equal(catalogCalls, 2)
  catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-z' }])
  await assert.rejects(executeRouterSelection({ ...args, catalogs: new RoutingCatalogCache() }), /supported by this router/)
})

test('model allowlists restrict adapter candidates and returned recommendations', async () => {
  const first = candidates()[0]!
  const available = [first, { ...first, serviceId: 'model-b' }, { ...first, provider: 'other' }]
  const allowedModels = [{ provider: 'openai', serviceId: 'model-a' }]
  let calls = 0
  let forbiddenOnly = false
  const adapter: ModelRouterAdapter = { routingMetadata: metadata,
    async selectRoute(_request, _peers, context) {
      calls++
      assert.deepEqual(context.candidates.map(({ provider, serviceId }) => ({ provider, serviceId })), allowedModels)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-b' }]), false)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-a' }]), true)
      return forbiddenOnly ? [{ serviceId: 'model-b' }] : [{ serviceId: 'model-b' }, { serviceId: 'model-a' }]
    },
  }
  const args = { node: unusedNode, adapter, request, peers: [peer], candidates: available, conversationKey: null, signal: new AbortController().signal }
  assert.deepEqual(await executeRouterSelection({ ...args, selection: { kind: 'router', allowedModels } }), [{ serviceId: 'model-a', provider: 'openai' }])
  forbiddenOnly = true
  await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', allowedModels } }), /no eligible recommendation/)
  const before = calls
  for (const blocked of [[], [{ provider: 'missing', serviceId: 'model-a' }]]) {
    await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', allowedModels: blocked } }), /model allowlist/)
  }
  assert.equal(calls, before)
})

test('preferences are validated with schema defaults before invoking an adapter', async () => {
  let calls = 0
  const schemaMetadata = createRoutingServiceMetadata({ type: 'object', additionalProperties: false,
    properties: { policy: { type: 'string', enum: ['cost', 'quality'], default: 'cost' } } })
  const adapter: ModelRouterAdapter = { routingMetadata: schemaMetadata,
    async selectRoute(_request, _peers, context) {
      calls++
      assert.equal(context.preferencesSchemaHash, schemaMetadata.preferencesSchemaHash)
      return [{ serviceId: String(context.preferences?.policy === 'quality' ? 'model-a' : 'missing') }]
    },
  }
  const args = { node: unusedNode, adapter, request, peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal }
  await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router', preferences: { policy: 'invalid' } } }), /enum/)
  assert.equal(calls, 0)
  assert.deepEqual(await executeRouterSelection({ ...args, selection: { kind: 'router', preferences: { policy: 'quality' } } }), [{ serviceId: 'model-a', provider: 'openai' }])
  await assert.rejects(executeRouterSelection({ ...args, selection: { kind: 'router' } }), /no eligible/)
})

test('a declined recommendation fails closed and cancellation applies even if the adapter ignores it', async () => {
  const adapter: ModelRouterAdapter = { routingMetadata: metadata, selectRoute: async () => null }
  const args = { node: unusedNode, adapter, request, peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal }
  await assert.rejects(executeRouterSelection(args), /no eligible/)
  const abort = new AbortController()
  adapter.selectRoute = () => new Promise(() => {})
  const pending = executeRouterSelection({ ...args, signal: abort.signal })
  abort.abort(new Error('client disconnected'))
  await assert.rejects(pending, /client disconnected/)
})

test('routing purchases cannot substitute a different routing-service peer', async () => {
  let sent = false
  const adapter: ModelRouterAdapter = {
    routingMetadata: metadata,
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, { ...request, requestId: 'routing-request' }, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { sent = true; throw new Error('must not send') } }, adapter, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal,
    selection: { kind: 'router', service: { peerId: 'b'.repeat(40), provider: 'levanto', serviceId: 'levanto-route' } },
  }), /selected routing-service peer/)
  assert.equal(sent, false)
})

test('candidate construction enforces buyer restrictions and required parameters', () => {
  assert.equal(eligibleRouterCandidates(request, [peer], [], null, () => false).length, 0)
  assert.equal(eligibleRouterCandidates(request, [peer], ['tools'], null, () => true).length, 0)
  assert.equal(eligibleRouterCandidates(request, [peer], [], {
    preferFreePeers: false, maxInputUsdPerMillion: 0.5, minTrustScore: 0, allowedPeerIds: [], blockedPeerIds: [],
  }, () => true).length, 0)
})

test('routing purchases are registered before dispatch with their own request ID', async () => {
  const tracked: string[] = []
  const adapter: ModelRouterAdapter = {
    routingMetadata: metadata,
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, { ...request, requestId: 'routing-purchase' }, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await executeRouterSelection({
    node: { sendRequest: async (_peer, serviceRequest) => {
      assert.deepEqual(tracked, ['routing-purchase'])
      assert.equal(serviceRequest.requestId, 'routing-purchase')
      return { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new Uint8Array() }
    } }, adapter, request, peers: [peer], candidates: candidates(), conversationKey: 'chat',
    signal: new AbortController().signal, onRoutingRequest: requestId => tracked.push(requestId),
  })
})

test('routing purchases cannot reuse the parent inference request ID', async () => {
  const adapter: ModelRouterAdapter = {
    routingMetadata: metadata,
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, request, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('must not dispatch') } }, adapter, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal,
  }), /distinct request ID/)
})
