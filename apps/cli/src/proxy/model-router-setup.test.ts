import assert from 'node:assert/strict'
import test from 'node:test'
import localPlugin from '@antseed/router-local'
import type { PeerInfo } from '@antseed/node'
import { createBuyerModelRouterRegistry } from './model-router-setup.js'

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

test('buyer router registry setup performs no network work and leaves the local plugin independent', async context => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network call') })
  const router = localPlugin.createRouter({})
  const registry = createBuyerModelRouterRegistry()
  const adapter = registry.resolve(target, peers)
  assert.equal(adapter, registry.resolve(target, peers))
  assert.equal(adapter.getCatalog, undefined)
  assert.equal(fetchMock.mock.callCount(), 0)
  for (const key of ['selectRoute', 'getModelRouterAdapter', 'recordUsage', 'autoRouteServiceId', 'getCatalog']) {
    assert.equal(key in router, false, key)
  }
  assert.notEqual(adapter, createBuyerModelRouterRegistry().resolve(target, peers))
})
