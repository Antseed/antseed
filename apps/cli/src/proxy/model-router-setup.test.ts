import assert from 'node:assert/strict'
import test from 'node:test'
import localPlugin from '@antseed/router-local'
import type { PeerInfo, RoutingCatalogV1 } from '@antseed/node'
import { createBuyerModelRouters, resolveBuyerModelRouterOptions } from './model-router-setup.js'

const target = { peerId: 'a'.repeat(40) as PeerInfo['peerId'], provider: 'levanto', serviceId: 'route' }
const peers: PeerInfo[] = [{
  peerId: target.peerId,
  providers: [target.provider],
  lastSeen: Date.now(),
  metadata: { peerId: target.peerId, version: 12, timestamp: Date.now(), signature: '', region: 'test', providers: [{
    provider: target.provider, services: [target.serviceId], maxConcurrency: 1, currentLoad: 0,
    defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    serviceApiProtocols: { route: ['levanto-routing'] },
  }] },
}]

test('buyer adapter setup performs no network work and leaves the local plugin independent', async context => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network call') })
  const router = localPlugin.createRouter({})
  const registry = createBuyerModelRouters()
  const adapter = registry.resolve(target, peers)
  assert.equal(adapter, registry.resolve(target, peers))
  assert.equal(await adapter.getCatalog!(target, peers, new AbortController().signal), undefined)
  assert.equal(fetchMock.mock.callCount(), 0)
  for (const key of ['selectRoute', 'getModelRouterAdapter', 'recordUsage', 'autoRouteServiceId', 'getCatalog']) {
    assert.equal(key in router, false, key)
  }
  assert.equal(localPlugin.configSchema?.some(field => field.key === 'LEVANTO_ROUTING_PEER_URL'), false)
  assert.notEqual(adapter, createBuyerModelRouters().resolve(target, peers))
})

test('explicit buyer catalog configuration is used only when a catalog is requested', async context => {
  const catalog: RoutingCatalogV1 = {
    version: 1, revision: 'catalog-1',
    preferencesSchema: { type: 'object', properties: {}, additionalProperties: false },
    models: [{ provider: 'openai', serviceId: 'model-a' }],
  }
  const fetchMock = context.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://catalog.example')
    assert.equal(url.pathname, '/v1/levanto-route/catalog')
    assert.equal(url.searchParams.get('provider'), target.provider)
    assert.equal(url.searchParams.get('service'), target.serviceId)
    return Response.json(catalog)
  })
  const registry = createBuyerModelRouters({ levantoRoutingPeerUrl: ' https://catalog.example/ ' })
  const adapter = registry.resolve(target, peers)
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.deepEqual(await adapter.getCatalog!(target, peers, new AbortController().signal), catalog)
  assert.equal(fetchMock.mock.callCount(), 1)
})

test('buyer catalog configuration retains environment precedence over legacy instance settings', () => {
  const instance = { LEVANTO_ROUTING_PEER_URL: 'https://instance.example' }
  assert.deepEqual(resolveBuyerModelRouterOptions({}, instance), { levantoRoutingPeerUrl: instance.LEVANTO_ROUTING_PEER_URL })
  assert.deepEqual(resolveBuyerModelRouterOptions({ LEVANTO_ROUTING_PEER_URL: 'https://env.example' }, instance), { levantoRoutingPeerUrl: 'https://env.example' })
  assert.deepEqual(resolveBuyerModelRouterOptions({ LEVANTO_ROUTING_PEER_URL: '' }, instance), { levantoRoutingPeerUrl: '' })
  assert.deepEqual(resolveBuyerModelRouterOptions({}, { LEVANTO_ROUTING_PEER_URL: 42 }), { levantoRoutingPeerUrl: undefined })
})
