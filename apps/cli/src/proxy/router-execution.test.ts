import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, ModelRouterAdapter, SerializedHttpRequest } from '@antseed/node'
import { eligibleRouterCandidates, executeRouterSelection, requestForRecommendation, resolveRouterRecommendations, RoutingDescriptionCache } from './router-execution.js'
import { RoutingDescriptionChangedError, type RoutingDescribeResponseV1, type RoutingPreferenceSchema } from '@antseed/node'

const emptySchema: RoutingPreferenceSchema = { type: 'object', properties: {}, additionalProperties: false }
function describeRouter(supportedServiceIds: string[], preferencesSchema = emptySchema, revision = 'rev-1'): RoutingDescribeResponseV1 {
  return { version: 1, revision, supportedServiceIds, preferencesSchema }
}

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

const describeAll = async () => describeRouter(['model-a', 'model-b'])
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

test('router descriptions restrict candidates, are cached, and refresh once after a changed description', async () => {
  let description = describeRouter(['model-a'])
  let describeCalls = 0
  let staleOnce = false
  const seen: string[][] = []
  const adapter: ModelRouterAdapter = {
    async describe() { describeCalls++; return description },
    async selectRoute(_request, _peers, context) {
      seen.push(context.candidates.map(candidate => candidate.serviceId))
      assert.equal(context.description.revision, description.revision)
      if (staleOnce) { staleOnce = false; throw new RoutingDescriptionChangedError() }
      return [{ serviceId: 'model-a' }]
    },
  }
  const descriptions = new RoutingDescriptionCache()
  const args = { node: unusedNode, adapter, request, descriptions, peers: [peer],
    candidates: [candidates()[0]!, { ...candidates()[0]!, serviceId: 'model-b' }], conversationKey: null,
    signal: new AbortController().signal, selection: routerSelection }
  assert.deepEqual(await executeRouterSelection(args), [{ serviceId: 'model-a', provider: 'openai' }])
  await executeRouterSelection(args)
  assert.equal(describeCalls, 1)
  assert.deepEqual(seen, [['model-a'], ['model-a']])
  staleOnce = true
  assert.deepEqual(await executeRouterSelection(args), [{ serviceId: 'model-a', provider: 'openai' }])
  assert.equal(describeCalls, 2)
  description = describeRouter(['model-z'])
  await assert.rejects(executeRouterSelection({ ...args, descriptions: new RoutingDescriptionCache() }), /supported by this router/)
})

test('describe requests are free control-plane calls to the selected routing peer', async () => {
  const sent: Array<{ peerId: string; options: unknown }> = []
  const adapter: ModelRouterAdapter = {
    async describe(target, peers, context) {
      await context.sendRequest(peers.find(entry => entry.peerId === target.peerId)!, { ...request, requestId: 'describe', method: 'GET', path: '/v1/routing/describe' })
      return describeRouter(['model-a'])
    },
    async selectRoute() { return [{ serviceId: 'model-a' }] },
  }
  const node = { sendRequest: async (target: PeerInfo, serviceRequest: SerializedHttpRequest, options?: unknown) => {
    sent.push({ peerId: target.peerId, options })
    return { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new Uint8Array() }
  } }
  await executeRouterSelection({ node, adapter, request, peers: [peer], candidates: candidates(), conversationKey: null,
    signal: new AbortController().signal, selection: routerSelection })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.peerId, peer.peerId)
  assert.equal((sent[0]!.options as { controlPlane?: boolean }).controlPlane, true)
})

test('model allowlists restrict adapter candidates and returned recommendations', async () => {
  const first = candidates()[0]!
  const available = [first, { ...first, serviceId: 'model-b' }, { ...first, provider: 'other' }]
  const allowedModels = [{ provider: 'openai', serviceId: 'model-a' }]
  let calls = 0
  let forbiddenOnly = false
  const adapter: ModelRouterAdapter = { describe: describeAll,
    async selectRoute(_request, _peers, context) {
      calls++
      assert.deepEqual(context.candidates.map(({ provider, serviceId }) => ({ provider, serviceId })), allowedModels)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-b' }]), false)
      assert.equal(context.acceptRecommendations([{ serviceId: 'model-a' }]), true)
      return forbiddenOnly ? [{ serviceId: 'model-b' }] : [{ serviceId: 'model-b' }, { serviceId: 'model-a' }]
    },
  }
  const args = { node: unusedNode, adapter, request, peers: [peer], candidates: available, conversationKey: null, signal: new AbortController().signal }
  assert.deepEqual(await executeRouterSelection({ ...args, selection: { ...routerSelection, allowedModels } }), [{ serviceId: 'model-a', provider: 'openai' }])
  forbiddenOnly = true
  await assert.rejects(executeRouterSelection({ ...args, selection: { ...routerSelection, allowedModels } }), /no eligible recommendation/)
  const before = calls
  for (const blocked of [[], [{ provider: 'missing', serviceId: 'model-a' }]]) {
    await assert.rejects(executeRouterSelection({ ...args, selection: { ...routerSelection, allowedModels: blocked } }), /model allowlist/)
  }
  assert.equal(calls, before)
})

test('preferences are validated against the router-supplied schema with defaults before invoking an adapter', async () => {
  let calls = 0
  const adapter: ModelRouterAdapter = {
    describe: async () => describeRouter(['model-a'], { type: 'object', additionalProperties: false,
      properties: { policy: { type: 'string', enum: ['cost', 'quality'], default: 'cost' } } }),
    async selectRoute(_request, _peers, context) {
      calls++
      return [{ serviceId: String(context.preferences.policy === 'quality' ? 'model-a' : 'missing') }]
    },
  }
  const args = { node: unusedNode, adapter, request, peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal }
  await assert.rejects(executeRouterSelection({ ...args, selection: { ...routerSelection, preferences: { policy: 'invalid' } } }), /enum/)
  assert.equal(calls, 0)
  assert.deepEqual(await executeRouterSelection({ ...args, selection: { ...routerSelection, preferences: { policy: 'quality' } } }), [{ serviceId: 'model-a', provider: 'openai' }])
  await assert.rejects(executeRouterSelection({ ...args, selection: routerSelection }), /no eligible/)
})

test('a declined recommendation fails closed and cancellation applies even if the adapter ignores it', async () => {
  const adapter: ModelRouterAdapter = { describe: describeAll, selectRoute: async () => null }
  const args = { node: unusedNode, adapter, request, peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal, selection: routerSelection }
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
    describe: describeAll,
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, { ...request, requestId: 'routing-request' }, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { sent = true; throw new Error('must not send') } }, adapter, request,
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
  const adapter: ModelRouterAdapter = {
    describe: describeAll,
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
    signal: new AbortController().signal, onRoutingRequest: requestId => tracked.push(requestId), selection: routerSelection,
  })
})

test('routing purchases cannot reuse the parent inference request ID', async () => {
  const adapter: ModelRouterAdapter = {
    describe: describeAll,
    async selectRoute(_request, _peers, context) {
      await context.sendRequest(peer, request, {})
      return [{ serviceId: 'model-a' }]
    },
  }
  await assert.rejects(executeRouterSelection({
    node: { sendRequest: async () => { throw new Error('must not dispatch') } }, adapter, request,
    peers: [peer], candidates: candidates(), conversationKey: null, signal: new AbortController().signal, selection: routerSelection,
  }), /distinct request ID/)
})
