import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, RoutingUsageObservation, SerializedHttpRequest } from '@antseed/node'
import { recordRouterUsage } from './routing-usage.js'

const peer = { peerId: 'a'.repeat(40), providers: ['openai'], lastSeen: Date.now() } as PeerInfo
const request: SerializedHttpRequest = { requestId: 'inference', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', 'x-antseed-provider': 'openai' }, body: Buffer.from('{"model":"model-a","messages":[]}') }
const response = { requestId: 'inference', statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":80}}}') }

test('records completed native usage once with the exact request, model, peer and conversation', () => {
  const observed: RoutingUsageObservation[] = []
  const routers = { recordUsage: (entry: RoutingUsageObservation) => { observed.push(entry) } }
  recordRouterUsage(routers, 'tool:chat', request, response, peer, new AbortController().signal)
  assert.deepEqual(observed, [{ conversationKey: 'tool:chat', requestId: 'inference', peerId: peer.peerId, provider: 'openai', serviceId: 'model-a', inputTokens: 100, cachedInputTokens: 80 }])
})

test('does not learn from errors, cancellation, untracked conversations, estimates or routing-service calls', () => {
  let observations = 0
  const routers = { recordUsage: () => { observations++ } }
  recordRouterUsage(routers, 'chat', request, { ...response, statusCode: 500 }, peer, new AbortController().signal)
  recordRouterUsage(routers, 'chat', request, response, peer, AbortSignal.abort())
  recordRouterUsage(routers, null, request, response, peer, new AbortController().signal)
  recordRouterUsage(routers, 'chat', request, { ...response, body: Buffer.from('{"choices":[]}') }, peer, new AbortController().signal)
  recordRouterUsage(routers, 'chat', { ...request, path: '/_antseed/route' }, response, peer, new AbortController().signal)
  assert.equal(observations, 0)
})

test('collects streaming cache usage from the completed native response, not individual frames', () => {
  const observed: RoutingUsageObservation[] = []
  const routers = { recordUsage: (entry: RoutingUsageObservation) => { observed.push(entry) } }
  const body = 'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":80}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":10}}\n\ndata: {"type":"message_stop"}\n\n'
  recordRouterUsage(routers, 'chat', { ...request, path: '/v1/messages' }, { ...response, headers: { 'content-type': 'text/event-stream' }, body: Buffer.from(body) }, peer, new AbortController().signal)
  assert.equal(observed.length, 1)
  assert.equal(observed[0]!.inputTokens, 100)
  assert.equal(observed[0]!.cachedInputTokens, 80)
})
