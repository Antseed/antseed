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
  assert.equal(computeResponseTelemetry(request, { statusCode: 200, headers, body }, peer).estimatedCostUsd, 3)
  assert.equal(computeResponseTelemetry(request, { statusCode: 200, headers: { ...headers, 'X-Antseed-Free-Tier': 'covered' }, body }, peer).estimatedCostUsd, 0)
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
    {}, selected, computeResponseTelemetry(speech, { statusCode: 200, headers: {}, body: Buffer.from('audio') }, selected), 'r1', 10,
  )['x-antseed-unit-priced']
  assert.equal(unitPriced(speechPeer(0.000015)), '1')
  assert.equal(unitPriced(speechPeer(0)), '0')
  assert.equal(attachStreamingAntseedHeaders({}, speechPeer(0.000015), speech)['x-antseed-unit-priced'], '1')
  // A token-priced chat model publishes no unit price.
  assert.equal(attachAntseedTelemetryHeaders({}, peer, computeResponseTelemetry(request, { statusCode: 200, headers: {}, body }, peer), 'r1', 10)['x-antseed-unit-priced'], '0')
})

const zeroUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
const sealed = 'Zm9yIGV4YW1wbGUgb25seQ'.repeat(200)
const answer = (message: Record<string, unknown>) => Buffer.from(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: zeroUsage }))

test('the cost shown for an answer with no usage figure follows what the buyer signs, not the size of the body', () => {
  const headers = { 'content-type': 'application/json' }
  const plain = computeResponseTelemetry(request, { statusCode: 200, headers, body: answer({ role: 'assistant', content: 'The sky is blue.' }) }, peer)
  // The signed charge ignores reasoning metadata beside the text (estimated-usage.ts), so both answers are signed the same.
  const withMetadata = computeResponseTelemetry(request, { statusCode: 200, headers, body: answer({
    role: 'assistant',
    content: 'The sky is blue.',
    reasoning_details: [{ type: 'reasoning.encrypted', format: 'openai-responses-v1', index: 0, data: sealed }],
  }) }, peer)
  assert.equal(
    withMetadata.estimatedCostUsd,
    plain.estimatedCostUsd,
    `shown ${withMetadata.estimatedCostUsd} (${withMetadata.usage.outputTokens} output tokens) for an answer signed like one shown at ${plain.estimatedCostUsd} (${plain.usage.outputTokens})`,
  )
})

test('an error reply, which is never signed, is shown at no cost', () => {
  const headers = { 'content-type': 'application/json' }
  const largeRequest: SerializedHttpRequest = { ...request, body: Buffer.from(JSON.stringify({ model: 'k3', messages: [{ role: 'user', content: 'seed '.repeat(40_000) }] })) }
  const rejected = Buffer.from(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } }))
  const telemetry = computeResponseTelemetry(largeRequest, { statusCode: 401, headers, body: rejected }, peer)
  assert.equal(
    telemetry.estimatedCostUsd,
    0,
    `a 401 reply shown at ${telemetry.estimatedCostUsd} USD (${telemetry.usage.inputTokens} input tokens, source ${telemetry.usage.source})`,
  )
})

test('the cost shown for an answer with a usage figure is the one the buyer signs', () => {
  const headers = { 'content-type': 'text/event-stream' }
  // An upstream's early estimate, marked as one, then the real usage: the charge reads only the real one.
  const chunk = (usage: Record<string, unknown>) => `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Blue.' } }], usage })}\n\n`
  const stream = Buffer.from(`${chunk({ prompt_tokens: 4_200, completion_tokens: 50, total_tokens: 4_250, estimated: true })}${chunk({ prompt_tokens: 4_000, completion_tokens: 6, total_tokens: 4_006, prompt_tokens_details: { cached_tokens: 3_000 } })}data: [DONE]\n\n`)
  const cachedPeer = { ...peer, providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 } } } } as unknown as PeerInfo
  const telemetry = computeResponseTelemetry(request, { statusCode: 200, headers, body: stream }, cachedPeer)
  assert.deepEqual(
    { ...telemetry.usage, cost: telemetry.estimatedCostUsd?.toFixed(6) },
    { inputTokens: 4_000, freshInputTokens: 1_000, cachedInputTokens: 3_000, outputTokens: 6, totalTokens: 4_006, source: 'usage', cost: '0.001312' },
  )
})

test('the cost header is rounded to base units as the buyer signs', () => {
  const cheap = { ...peer, providerPricing: { openai: { defaults: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 0.5 } } } } as unknown as PeerInfo
  const oneToken = Buffer.from(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } }))
  const telemetry = computeResponseTelemetry(request, { statusCode: 200, headers: { 'content-type': 'application/json' }, body: oneToken }, cheap)
  assert.equal(attachAntseedTelemetryHeaders({}, cheap, telemetry, 'r1', 10)['x-antseed-estimated-cost-usd'], '0.000001')
})
