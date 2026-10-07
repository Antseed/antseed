import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node'
import type { ModelRoutingClientApi } from '@antseed/router-core'
import { RouterCannotRankError } from '@antseed/router-core'
import { eligibleRouterCandidates, executeRouterSelection, requestForRecommendation, resolveRouterRecommendations, RoutingModelsCache } from './router-execution.js'

const peer = {
  peerId: 'a'.repeat(40) as PeerInfo['peerId'], providers: ['openai'], lastSeen: Date.now(), reputationScore: 90,
  providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'model-a': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } },
  providerServiceApiProtocols: { openai: { services: { 'model-a': ['openai-chat-completions'] } } },
} as PeerInfo
const request: SerializedHttpRequest = {
  requestId: 'original', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ model: 'antseed', messages: [{ role: 'user', content: 'Hello' }], stream: true })),
}
const candidates = () => eligibleRouterCandidates(request, [peer], [], null, () => true)

const listAll = async () => ['model-a', 'model-b']
const routingService = { peerId: peer.peerId, provider: 'routing-vendor', serviceId: 'route' }
const routerSelection = { kind: 'router' as const, service: routingService }
const unusedNode = { sendRequest: async () => { throw new Error('unused') } }

test('recommendations keep allowed destinations in router order, each naming its provider', () => {
  const first = candidates()[0]!
  const available = [first, { ...first, serviceId: 'model-b' }, { ...first, peerId: 'b'.repeat(40), provider: 'other' }]
  assert.deepEqual(resolveRouterRecommendations([{ serviceId: 'model-a', peerId: 'c'.repeat(40) }], available), [])
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
  assert.equal(JSON.parse(Buffer.from(request.body).toString()).model, 'antseed')
})

test('router model lists restrict candidates, are cached, and refresh once after a 422', async () => {
  let models = ['model-a']
  let listCalls = 0
  let unrankableOnce = false
  const seen: string[][] = []
  const client: ModelRoutingClientApi = {
    async listModels() { listCalls++; return [...models] },
    async selectRoute(_request, _peers, context) {
      seen.push(context.candidates.map(candidate => candidate.serviceId))
      if (unrankableOnce) { unrankableOnce = false; throw new RouterCannotRankError('cannot rank') }
      return [{ serviceId: 'model-a' }]
    },
  }
  const modelsCache = new RoutingModelsCache()
  const args = { node: unusedNode, client, request, modelsCache, peers: [peer],
    candidates: [candidates()[0]!, { ...candidates()[0]!, serviceId: 'model-b' }], conversationKey: null,
    signal: new AbortController().signal, selection: routerSelection }
  assert.deepEqual(await executeRouterSelection(args), [{ serviceId: 'model-a', provider: 'openai' }])
  await executeRouterSelection(args)
  assert.equal(listCalls, 1)
  assert.deepEqual(seen, [['model-a'], ['model-a']])
  unrankableOnce = true
  assert.deepEqual(await executeRouterSelection(args), [{ serviceId: 'model-a', provider: 'openai' }])
  assert.equal(listCalls, 2)
  models = ['model-z']
  await assert.rejects(executeRouterSelection({ ...args, modelsCache: new RoutingModelsCache() }), /supported by this router/)
})

test('seller model names are sent under the router\'s own name for that model', async () => {
  const sent: Array<[string, string | undefined]> = []
  const client: ModelRoutingClientApi = {
    listModels: async () => ['anthropic/claude-opus-5', 'openai/gpt-5'],
    async selectRoute(_request, _peers, context) {
      for (const candidate of context.candidates) sent.push([candidate.serviceId, candidate.routerModel])
      return [{ serviceId: 'claude-opus-5' }]
    },
  }
  const base = candidates()[0]!
  const available = [{ ...base, serviceId: 'claude-opus-5' }, { ...base, serviceId: 'openai/gpt-5' }, { ...base, serviceId: 'mistral-large' }]
  assert.deepEqual(await executeRouterSelection({ node: unusedNode, client, request, peers: [peer], candidates: available,
    conversationKey: null, signal: new AbortController().signal, selection: routerSelection }), [{ serviceId: 'claude-opus-5', provider: 'openai' }])
  assert.deepEqual(sent, [['claude-opus-5', 'anthropic/claude-opus-5'], ['openai/gpt-5', 'openai/gpt-5']])
})

test('concurrent model lists share one request and refresh after invalidation or expiry', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const client: Pick<ModelRoutingClientApi, 'listModels'> = { async listModels() { calls++; await gate; return ['model-a'] } }
  const modelsCache = new RoutingModelsCache()
  const pending = Promise.all([1, 2, 3].map(() => modelsCache.get(client, routingService, [peer], unusedNode)))
  release()
  const results = await pending
  assert.equal(calls, 1)
  results[0]!.push('mutated')
  assert.deepEqual(await modelsCache.get(client, routingService, [peer], unusedNode), ['model-a'])
  assert.equal(calls, 1)
  modelsCache.invalidate(routingService)
  await modelsCache.get(client, routingService, [peer], unusedNode)
  assert.equal(calls, 2)
  const uncached = new RoutingModelsCache(0)
  await uncached.get(client, routingService, [peer], unusedNode)
  await uncached.get(client, routingService, [peer], unusedNode)
  assert.equal(calls, 4)
})

test('model-list requests are free control-plane calls to the selected routing peer', async () => {
  const sent: Array<{ peerId: string; options: unknown }> = []
  const client: ModelRoutingClientApi = {
    async listModels(target, peers, context) {
      await context.sendRequest(peers.find(entry => entry.peerId === target.peerId)!, { ...request, requestId: 'models', method: 'GET', path: '/v1/routing/models' })
      return ['model-a']
    },
    async selectRoute() { return [{ serviceId: 'model-a' }] },
  }
  const node = { sendRequest: async (target: PeerInfo, serviceRequest: SerializedHttpRequest, options?: unknown) => {
    sent.push({ peerId: target.peerId, options })
    return { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new Uint8Array() }
  } }
  await executeRouterSelection({ node, client, request, peers: [peer], candidates: candidates(), conversationKey: null,
    signal: new AbortController().signal, selection: routerSelection })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.peerId, peer.peerId)
  assert.equal((sent[0]!.options as { controlPlane?: boolean }).controlPlane, true)
})

test('model allowlists restrict routing candidates and returned recommendations', async () => {
  const first = candidates()[0]!
  const available = [first, { ...first, serviceId: 'model-b' }, { ...first, provider: 'other' }]
  const allowedModels = [{ provider: 'openai', serviceId: 'model-a' }]
  let calls = 0
  let forbiddenOnly = false
  const client: ModelRoutingClientApi = { listModels: listAll,
    async selectRoute(_request, _peers, context) {
      calls++
      assert.deepEqual(context.candidates.map(({ provider, serviceId }) => ({ provider, serviceId })), allowedModels)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-b' }]), false)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-a' }]), true)
      return forbiddenOnly ? [{ serviceId: 'model-b' }] : [{ serviceId: 'model-b' }, { serviceId: 'model-a' }]
    },
  }
  const args = { node: unusedNode, client, request, peers: [peer], candidates: available, conversationKey: null, signal: new AbortController().signal }
  assert.deepEqual(await executeRouterSelection({ ...args, selection: { ...routerSelection, allowedModels } }), [{ serviceId: 'model-a', provider: 'openai' }])
  forbiddenOnly = true
  await assert.rejects(executeRouterSelection({ ...args, selection: { ...routerSelection, allowedModels } }), /no eligible recommendation/)
  const before = calls
  for (const blocked of [[], [{ provider: 'missing', serviceId: 'model-a' }]]) {
    await assert.rejects(executeRouterSelection({ ...args, selection: { ...routerSelection, allowedModels: blocked } }), /model allowlist/)
  }
  assert.equal(calls, before)
})

test('the selection tradeoff is passed to the routing client, and omitted when unset', async () => {
  const seen: Array<number | undefined> = []
  const client: ModelRoutingClientApi = {
    listModels: async () => ['model-a'],
    async selectRoute(_request, _peers, context) {
      seen.push(context.costQualityTradeoff)
      assert.equal('costQualityTradeoff' in context, context.costQualityTradeoff !== undefined)
      return [{ serviceId: 'model-a' }]
    },
  }
  const args = { node: unusedNode, client, request, peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal }
  await executeRouterSelection({ ...args, selection: { ...routerSelection, costQualityTradeoff: 0 } })
  await executeRouterSelection({ ...args, selection: routerSelection })
  assert.deepEqual(seen, [0, undefined])
})

test('a declined recommendation fails closed and cancellation applies even if the client ignores it', async () => {
  const client: ModelRoutingClientApi = { listModels: listAll, selectRoute: async () => null }
  const args = { node: unusedNode, client, request, peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal, selection: routerSelection }
  await assert.rejects(executeRouterSelection(args), /no eligible/)
  const abort = new AbortController()
  client.selectRoute = () => new Promise(() => {})
  const pending = executeRouterSelection({ ...args, signal: abort.signal })
  abort.abort(new Error('client disconnected'))
  await assert.rejects(pending, /client disconnected/)
})

test('routing purchases cannot substitute a different routing-service peer', async () => {
  let sent = false
  const client: ModelRoutingClientApi = {
    listModels: listAll,
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, { ...request, requestId: 'routing-request' }, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { sent = true; throw new Error('must not send') } }, client, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal,
    selection: { kind: 'router', service: { ...routingService, peerId: 'b'.repeat(40) } },
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
  const client: ModelRoutingClientApi = {
    listModels: listAll,
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
    } }, client, request, peers: [peer], candidates: candidates(), conversationKey: 'chat',
    signal: new AbortController().signal, onRoutingRequest: requestId => tracked.push(requestId), selection: routerSelection,
  })
})

test('routing purchases cannot reuse the parent inference request ID', async () => {
  const client: ModelRoutingClientApi = {
    listModels: listAll,
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, request, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('must not dispatch') } }, client, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal, selection: routerSelection,
  }), /distinct request ID/)
})
