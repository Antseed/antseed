import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareVideoRequest, recordVideoAcceptance } from './native-video-proxy.js'
import { ResourceRoutes } from './resource-routes.js'

const seller = 'a'.repeat(40)
const response = (body: object) => ({ requestId: 'r', statusCode: 200, headers: {} as Record<string, string>, body: Buffer.from(JSON.stringify(body)) })

test('video status and cancel pin the seller that accepted the job, and unknown jobs return 404', () => {
  const routes = new ResourceRoutes()
  const accepted = response({ id: 'task-1' })
  const create = { protocol: 'seedance-video', action: 'create' } as const
  assert.equal(recordVideoAcceptance(create, accepted, { peerId: seller, provider: 'seedance', service: 'seedance-2-0' }, routes), true)
  assert.equal(accepted.headers['x-antseed-seller-peer'], seller)

  const status = prepareVideoRequest({ protocol: 'seedance-video', action: 'status', resourceId: 'task-1' }, {}, routes)
  assert.deepEqual(status, { headers: { 'x-antseed-pin-peer': seller, 'x-antseed-provider': 'seedance', 'x-antseed-service': 'seedance-2-0' } })
  const unknown = prepareVideoRequest({ protocol: 'seedance-video', action: 'status', resourceId: 'other' }, {}, routes)
  assert.ok('error' in unknown && unknown.error.statusCode === 404)
})

test('only accepted creates are recorded', () => {
  const routes = new ResourceRoutes()
  const create = { protocol: 'seedance-video', action: 'create' } as const
  const info = { peerId: seller, provider: 'seedance', service: 'seedance-2-0' }
  assert.equal(recordVideoAcceptance(create, { ...response({ id: 'task' }), statusCode: 500 }, info, routes), false)
  assert.equal(recordVideoAcceptance({ protocol: 'seedance-video', action: 'status', resourceId: 'task' }, response({ id: 'task' }), info, routes), false)
  assert.equal(routes.snapshot().length, 0)
})

test('Venice retrieve and complete route by the body queue_id to the accepting seller', () => {
  const routes = new ResourceRoutes()
  const create = { protocol: 'venice-video', action: 'create' } as const
  const accepted = response({ model: 'wan-2.5', queue_id: 'queue-1' })
  assert.equal(recordVideoAcceptance(create, accepted, { peerId: seller, provider: 'venice', service: 'wan-2.5' }, routes), true)
  const pinned = { headers: { 'x-antseed-pin-peer': seller, 'x-antseed-provider': 'venice', 'x-antseed-service': 'wan-2.5' } }
  assert.deepEqual(prepareVideoRequest({ protocol: 'venice-video', action: 'download', resourceId: 'queue-1' }, {}, routes), pinned)
  assert.deepEqual(prepareVideoRequest({ protocol: 'venice-video', action: 'cancel', resourceId: 'queue-1' }, {}, routes), pinned)
  for (const resourceId of ['other', undefined]) {
    const unknown = prepareVideoRequest({ protocol: 'venice-video', action: 'download', resourceId }, {}, routes)
    assert.ok('error' in unknown && unknown.error.statusCode === 404)
  }
})

test('a Seedance final video from a draft is pinned to the seller that ran the draft', () => {
  const routes = new ResourceRoutes()
  const info = { peerId: seller, provider: 'seedance', service: 'seedance-2-5' }
  assert.equal(recordVideoAcceptance({ protocol: 'seedance-video', action: 'create' }, response({ id: 'cgt-draft' }), info, routes), true)
  const final = prepareVideoRequest({ protocol: 'seedance-video', action: 'create', referencedResourceIds: ['cgt-draft'] }, {}, routes)
  assert.ok('headers' in final && final.headers['x-antseed-pin-peer'] === seller && final.headers['x-antseed-service'] === 'seedance-2-5')
  for (const referencedResourceIds of [['cgt-other'], ['']]) {
    const unknown = prepareVideoRequest({ protocol: 'seedance-video', action: 'create', referencedResourceIds }, {}, routes)
    assert.ok('error' in unknown && unknown.error.statusCode === 404)
  }
})
