import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareVideoRequest, recordVideoAcceptance } from './native-video-proxy.js'
import { ResourceRoutes } from './resource-routes.js'

const seller = 'a'.repeat(40)
const response = (body: object) => ({ requestId: 'r', statusCode: 200, headers: {} as Record<string, string>, body: Buffer.from(JSON.stringify(body)) })

test('video status pins the seller that accepted the Venice job, and unknown jobs return 404', () => {
  const routes = new ResourceRoutes()
  const accepted = response({ model: 'wan-2.5', queue_id: 'queue-1' })
  assert.equal(recordVideoAcceptance({ protocol: 'venice-video', action: 'create' }, accepted, { peerId: seller, provider: 'venice', service: 'wan-2.5' }, routes), true)
  assert.equal(accepted.headers['x-antseed-seller-peer'], seller)
  assert.deepEqual(prepareVideoRequest({ protocol: 'venice-video', action: 'download', resourceId: 'queue-1' }, {}, routes), { headers: { 'x-antseed-pin-peer': seller, 'x-antseed-provider': 'venice', 'x-antseed-service': 'wan-2.5' } })
  const unknown = prepareVideoRequest({ protocol: 'venice-video', action: 'download', resourceId: 'other' }, {}, routes)
  assert.ok('error' in unknown && unknown.error.statusCode === 404)
})

test('only accepted Venice creates are recorded', () => {
  const routes = new ResourceRoutes()
  const info = { peerId: seller, provider: 'venice', service: 'wan-2.5' }
  assert.equal(recordVideoAcceptance({ protocol: 'venice-video', action: 'create' }, { ...response({ queue_id: 'queue-1' }), statusCode: 500 }, info, routes), false)
  assert.equal(recordVideoAcceptance({ protocol: 'venice-video', action: 'download', resourceId: 'queue-1' }, response({ queue_id: 'queue-1' }), info, routes), false)
  assert.equal(routes.snapshot().length, 0)
})
