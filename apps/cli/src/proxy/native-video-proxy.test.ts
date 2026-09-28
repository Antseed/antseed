import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareVideoRequest, recordVideoAcceptance, recordVideoCreateAttempt, rewriteVideoDownloadUrls, VIDEO_IDEMPOTENCY_KEY_HEADER } from './native-video-proxy.js'
import { ResourceRoutes } from './resource-routes.js'

const seller = 'a'.repeat(40)
const response = (body: object) => ({ requestId: 'r', statusCode: 200, headers: {} as Record<string, string>, body: Buffer.from(JSON.stringify(body)) })

test('Veo download URLs point to the local proxy without changing the signed upstream response', () => {
  const route = { protocol: 'veo-video', action: 'status', resourceId: 'models/veo/operations/task' } as const
  const uri = 'https://generativelanguage.googleapis.com/v1beta/files/file:download?alt=media'
  const upstream = response({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } })
  upstream.headers['Content-Length'] = String(upstream.body.length)
  assert.equal(rewriteVideoDownloadUrls(route, upstream, 'http://127.0.0.1:8377'), upstream)
  assert.equal(rewriteVideoDownloadUrls(route, upstream, 'http://127.0.0.1:8377', 'unknown-v2'), upstream)
  const rewritten = rewriteVideoDownloadUrls(route, upstream, 'http://127.0.0.1:8377', 'video-stream-v1')
  assert.equal(JSON.parse(Buffer.from(rewritten.body).toString()).response.generateVideoResponse.generatedSamples[0].video.uri, 'http://127.0.0.1:8377/v1beta/models/veo/operations/task/videos/0:download')
  assert.equal(JSON.parse(upstream.body.toString()).response.generateVideoResponse.generatedSamples[0].video.uri, uri)
  assert.equal(rewritten.headers['Content-Length'], undefined)
  const hosted = response({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://seller.test/video' } }] } } })
  assert.equal(rewriteVideoDownloadUrls(route, hosted, 'http://127.0.0.1:8377', 'video-stream-v1'), hosted)
  const routes = new ResourceRoutes()
  routes.record({ protocol: 'veo-video', resourceId: route.resourceId, sellerPeerId: seller, provider: 'veo', service: 'veo' })
  const restarted = new ResourceRoutes()
  restarted.hydrate(routes.snapshot())
  assert.deepEqual(prepareVideoRequest({ ...route, action: 'download', resultIndex: 0 }, {}, restarted), { headers: { 'x-antseed-pin-peer': seller, 'x-antseed-provider': 'veo', 'x-antseed-service': 'veo' } })
})

test('video creates reuse a valid client idempotency key, generate one otherwise, and reject malformed keys', () => {
  const routes = new ResourceRoutes()
  const create = { protocol: 'runway-video', action: 'create' } as const
  assert.deepEqual(prepareVideoRequest(create, { 'idempotency-key': 'client-1' }, routes), { headers: { 'idempotency-key': 'client-1', [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'client-1' } })
  const generated = prepareVideoRequest(create, {}, routes)
  assert.ok('headers' in generated && generated.headers[VIDEO_IDEMPOTENCY_KEY_HEADER])
  const invalid = prepareVideoRequest(create, { [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'bad key!' }, routes)
  assert.ok('error' in invalid && invalid.error.statusCode === 400)
})

test('video status and cancel pin the seller that accepted the job, and unknown jobs return 404', () => {
  const routes = new ResourceRoutes()
  const accepted = response({ task_id: 'task-1' })
  const create = { protocol: 'minimax-video', action: 'create' } as const
  assert.equal(recordVideoAcceptance(create, { [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'key' }, accepted, { peerId: seller, provider: 'minimax', service: 'MiniMax-H3' }, routes), true)
  assert.equal(accepted.headers['x-antseed-seller-peer'], seller)
  assert.equal(accepted.headers[VIDEO_IDEMPOTENCY_KEY_HEADER], 'key')

  const status = prepareVideoRequest({ protocol: 'minimax-video', action: 'status', resourceId: 'task-1' }, {}, routes)
  assert.deepEqual(status, { headers: { 'x-antseed-pin-peer': seller, 'x-antseed-provider': 'minimax', 'x-antseed-service': 'MiniMax-H3' } })
  const unknown = prepareVideoRequest({ protocol: 'minimax-video', action: 'status', resourceId: 'other' }, {}, routes)
  assert.ok('error' in unknown && unknown.error.statusCode === 404)
})

test('only accepted creates are recorded', () => {
  const routes = new ResourceRoutes()
  const create = { protocol: 'seedance-video', action: 'create' } as const
  const info = { peerId: seller, provider: 'seedance', service: 'seedance-2-0' }
  assert.equal(recordVideoAcceptance(create, {}, { ...response({ id: 'task' }), statusCode: 500 }, info, routes), false)
  assert.equal(recordVideoAcceptance({ protocol: 'seedance-video', action: 'status', resourceId: 'task' }, {}, response({ id: 'task' }), info, routes), false)
  assert.equal(routes.snapshot().length, 0)
})

test('a create retry with the same key is pinned to the original seller, even after a restart', () => {
  const routes = new ResourceRoutes()
  const create = { protocol: 'runway-video', action: 'create' } as const
  const headers = { [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'retry-key' }
  assert.equal(recordVideoCreateAttempt(create, headers, { peerId: seller.toUpperCase(), provider: 'runway', service: 'gen4.5' }, routes), true)
  assert.equal(recordVideoCreateAttempt(create, {}, { peerId: seller, provider: 'runway', service: 'gen4.5' }, routes), false)
  const restarted = new ResourceRoutes()
  restarted.hydrate(routes.snapshot())
  assert.deepEqual(prepareVideoRequest(create, headers, restarted), {
    headers: { ...headers, 'x-antseed-pin-peer': seller, 'x-antseed-provider': 'runway', 'x-antseed-service': 'gen4.5' },
  })
  const fresh = prepareVideoRequest(create, { [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'new-key' }, restarted)
  assert.ok('headers' in fresh && fresh.headers['x-antseed-pin-peer'] === undefined)
})

test('Venice retrieve and complete route by the body queue_id to the accepting seller', () => {
  const routes = new ResourceRoutes()
  const create = { protocol: 'venice-video', action: 'create' } as const
  const accepted = response({ model: 'wan-2.5', queue_id: 'queue-1' })
  assert.equal(recordVideoAcceptance(create, { [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'k' }, accepted, { peerId: seller, provider: 'venice', service: 'wan-2.5' }, routes), true)
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
  assert.equal(recordVideoAcceptance({ protocol: 'seedance-video', action: 'create' }, { [VIDEO_IDEMPOTENCY_KEY_HEADER]: 'k' }, response({ id: 'cgt-draft' }), info, routes), true)
  const final = prepareVideoRequest({ protocol: 'seedance-video', action: 'create', referencedResourceIds: ['cgt-draft'] }, {}, routes)
  assert.ok('headers' in final && final.headers['x-antseed-pin-peer'] === seller && final.headers['x-antseed-service'] === 'seedance-2-5')
  for (const referencedResourceIds of [['cgt-other'], ['']]) {
    const unknown = prepareVideoRequest({ protocol: 'seedance-video', action: 'create', referencedResourceIds }, {}, routes)
    assert.ok('error' in unknown && unknown.error.statusCode === 404)
  }
})
