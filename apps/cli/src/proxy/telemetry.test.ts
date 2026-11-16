import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node'
import { ROUTER_PEER_ID_HEADER, withoutRouterHeaders, attachAntseedTelemetryHeaders, attachStreamingAntseedHeaders, computeResponseTelemetry, coveredByFreeAllowance } from './telemetry.js'
import { ROUTE_SELECTION_HEADER } from './route-selection.js'

test('a seller\'s upstream headers never reach the buyer\'s client', () => {
  const fromSeller = {
    'Content-Type': 'text/event-stream',
    'retry-after': '5',
    'x-antseed-input-usd-per-million': '0.44',
    'x-codex-primary-used-percent': '37',
    'x-codex-turn-state': 'secret-session-state',
    'x-oai-request-id': 'req_upstream',
    'set-cookie': '__cflb=abc',
    'server': 'cloudflare',
    'cf-ray': 'abc-ORD',
  }
  assert.deepEqual(withoutRouterHeaders(fromSeller), {
    'Content-Type': 'text/event-stream',
    'retry-after': '5',
    'x-antseed-input-usd-per-million': '0.44',
  })
})

test('a seller cannot set the buyer\'s routing headers', () => {
  assert.deepEqual(withoutRouterHeaders({ [ROUTER_PEER_ID_HEADER]: '0xabc', [ROUTE_SELECTION_HEADER]: 'forged', 'x-antseed-service': 'm' }), { 'x-antseed-service': 'm' })
})

const peer = {
  peerId: 'a'.repeat(40),
  lastSeen: 0,
  providers: ['openai'],
  providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
} as unknown as PeerInfo
const request: SerializedHttpRequest = {
  requestId: 'r1',
  method: 'POST',
  path: '/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ model: 'k3', messages: [] })),
}
const body = Buffer.from(JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }))

test('a response the seller covered from its free allowance is estimated at $0', () => {
  const headers = { 'content-type': 'application/json' }
  assert.equal(computeResponseTelemetry(request, headers, body, peer).estimatedCostUsd, 3)
  assert.equal(computeResponseTelemetry(request, { ...headers, 'X-Antseed-Free-Tier': 'covered' }, body, peer).estimatedCostUsd, 0)
})

test('coveredByFreeAllowance reads the marker in any case, and only its covered value', () => {
  assert.equal(coveredByFreeAllowance({ 'x-antseed-free-tier': ' Covered ' }), true)
  assert.equal(coveredByFreeAllowance({ 'x-antseed-free-tier': ['other', 'covered'] }), true)
  assert.equal(coveredByFreeAllowance({ 'x-antseed-free-tier': 'no' }), false)
  assert.equal(coveredByFreeAllowance({}), false)
})

test('responses say whether the served service also charges per unit', () => {
  const speechPeer = (priceUsd: number) => ({
    ...peer,
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } },
    providerServiceUnitBillingModels: { openai: { services: { 'tts-model': { 'openai-audio-speech': { version: 1, components: [{ unit: 'input_characters', priceUsd }] } } } } },
  }) as unknown as PeerInfo
  const speech: SerializedHttpRequest = { ...request, path: '/v1/audio/speech', body: Buffer.from(JSON.stringify({ model: 'tts-model', input: 'Hi' })) }
  const unitPriced = (selected: PeerInfo) => attachAntseedTelemetryHeaders(
    {}, selected, computeResponseTelemetry(speech, {}, Buffer.from('audio'), selected), 'r1', 10,
  )['x-antseed-unit-priced']
  assert.equal(unitPriced(speechPeer(0.000015)), '1')
  assert.equal(unitPriced(speechPeer(0)), '0')
  assert.equal(attachStreamingAntseedHeaders({}, speechPeer(0.000015), speech)['x-antseed-unit-priced'], '1')
  // A token-priced chat model publishes no unit price.
  assert.equal(attachAntseedTelemetryHeaders({}, peer, computeResponseTelemetry(request, {}, body, peer), 'r1', 10)['x-antseed-unit-priced'], '0')
})
