import assert from 'node:assert/strict'
import test from 'node:test'
import type { SerializedHttpRequest, ServiceCapabilities } from '@antseed/node'
import type { BuyerReasoningEffortConfig } from '../config/types.js'
import type { ServiceApiProtocol } from './service-api-adapter.js'
import {
  applyDefaultReasoningEffort,
  isReasoningEffortSetting,
  type DefaultReasoningEffortInput,
} from './default-reasoning-effort.js'

const CONFIG: BuyerReasoningEffortConfig = {
  default: 'medium',
  models: { 'model-b': 'high', 'model-c': 'off', 'model-d': 'max' },
}
const LISTS_ALL: ServiceCapabilities = { reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'max'] }

const PATHS: Record<string, string> = {
  'openai-chat-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
}

function request(body: unknown, raw?: string, path = '/v1/chat/completions', method = 'POST'): SerializedHttpRequest {
  const bytes = Buffer.from(raw ?? JSON.stringify(body))
  return {
    requestId: 'request-1',
    method,
    path,
    headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) },
    body: new Uint8Array(bytes),
  }
}

function input(overrides: Partial<DefaultReasoningEffortInput> & { body?: unknown; path?: string }): DefaultReasoningEffortInput {
  const { body, path, ...rest } = overrides
  const requestProtocol = rest.requestProtocol === undefined ? 'openai-chat-completions' : rest.requestProtocol
  return {
    config: CONFIG,
    header: undefined,
    model: 'model-a',
    requestProtocol,
    targetProtocol: requestProtocol,
    capabilities: LISTS_ALL,
    request: request(body ?? { model: 'model-a', messages: [] }, undefined, path ?? PATHS[requestProtocol ?? ''] ?? '/v1/chat/completions'),
    ...rest,
  }
}

function sentBody(result: { request: SerializedHttpRequest }): Record<string, unknown> {
  return JSON.parse(Buffer.from(result.request.body).toString('utf8')) as Record<string, unknown>
}

function assertUntouched(value: DefaultReasoningEffortInput, label?: string): void {
  const result = applyDefaultReasoningEffort(value)
  assert.equal(result.request, value.request, label)
  assert.equal(result.added, null, label)
}

test('returns the same request object when the setting is off', () => {
  // Not JSON: a body that is parsed would make no difference, so identity proves it never is.
  const value = input({ config: { default: 'off', models: {} }, request: request(null, '{not json') })
  assertUntouched(value)
})

test('adds the default effort to a chat request that names none', () => {
  const original = { model: 'model-a', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 }
  const result = applyDefaultReasoningEffort(input({ body: original }))
  assert.equal(result.added, 'medium')
  const body = sentBody(result)
  assert.equal(body['reasoning_effort'], 'medium')
  const { reasoning_effort: _effort, ...rest } = body
  assert.deepEqual(rest, original)
  assert.equal(result.request.headers['content-length'], String(result.request.body.length))
})

test('adds the effort inside an existing responses reasoning object', () => {
  const result = applyDefaultReasoningEffort(input({
    requestProtocol: 'openai-responses',
    body: { model: 'model-a', input: 'hi', reasoning: { summary: 'auto' } },
  }))
  assert.equal(result.added, 'medium')
  assert.deepEqual(sentBody(result)['reasoning'], { summary: 'auto', effort: 'medium' })
})

test('creates the responses reasoning object when there is none', () => {
  const result = applyDefaultReasoningEffort(input({
    requestProtocol: 'openai-responses',
    body: { model: 'model-a', input: 'hi' },
  }))
  assert.equal(result.added, 'medium')
  assert.deepEqual(sentBody(result)['reasoning'], { effort: 'medium' })
})

test("never replaces a client's own effort", () => {
  const cases: Array<[string, ServiceApiProtocol, unknown]> = [
    ['chat effort', 'openai-chat-completions', { model: 'model-a', reasoning_effort: 'low' }],
    ['chat null effort', 'openai-chat-completions', { model: 'model-a', reasoning_effort: null }],
    ['responses effort', 'openai-responses', { model: 'model-a', reasoning: { effort: 'high' } }],
    ['responses null effort', 'openai-responses', { model: 'model-a', reasoning: { effort: null } }],
    ['responses null reasoning', 'openai-responses', { model: 'model-a', reasoning: null }],
  ]
  for (const [label, protocol, body] of cases) {
    for (const targetProtocol of ['openai-chat-completions', 'openai-responses'] as const) {
      assertUntouched(input({ requestProtocol: protocol, targetProtocol, body }), `${label} \u2192 ${targetProtocol}`)
    }
  }
})

test('leaves a request that carries another reasoning control untouched', () => {
  const controls: Array<Record<string, unknown>> = [
    { thinking: { type: 'enabled' } },
    { enable_thinking: false },
    { thinking_budget: 1024 },
    { thinking_config: { budget: 0 } },
    { include_reasoning: false },
    { think: false },
    { chat_template_kwargs: { enable_thinking: false } },
    { chat_template_kwargs: { thinking: false } },
  ]
  for (const extra of controls) {
    for (const protocol of ['openai-chat-completions', 'openai-responses'] as const) {
      assertUntouched(input({ requestProtocol: protocol, body: { model: 'model-a', ...extra } }), `${protocol} ${JSON.stringify(extra)}`)
    }
  }
  assertUntouched(input({ body: { model: 'model-a', reasoning: { enabled: true } } }), 'chat reasoning object')
  // Other template arguments are not a reasoning choice.
  assert.equal(applyDefaultReasoningEffort(input({ body: { model: 'model-a', chat_template_kwargs: { foo: 1 } } })).added, 'medium')
})

test('adds nothing to a seller that announces no list', () => {
  assertUntouched(input({ capabilities: undefined }))
  assertUntouched(input({ capabilities: { reasoning: true } }))
  assertUntouched(input({ capabilities: { reasoning: false } }))
})

test("sends a level only when the seller's list has exactly that level", () => {
  const added = (model: string, capabilities: ServiceCapabilities) =>
    applyDefaultReasoningEffort(input({ model, capabilities })).added
  assert.equal(added('model-a', { reasoningEfforts: ['low', 'medium', 'high'] }), 'medium')
  assert.equal(added('model-a', { reasoningEfforts: ['low', 'high', 'max'] }), null, 'no substitute level')
  assert.equal(added('model-a', { reasoningEfforts: [] }), null, 'an empty list allows none')
  assert.equal(added('model-d', { reasoningEfforts: ['high', 'max'] }), 'max')
  assert.equal(added('model-a', { reasoningEfforts: ['Medium'] }), null, 'labels match exactly')
})

test('a model listed in models ignores the default', () => {
  const result = applyDefaultReasoningEffort(input({ model: 'model-b' }))
  assert.equal(result.added, 'high')
  assert.equal(sentBody(result)['reasoning_effort'], 'high')
  assertUntouched(input({ model: 'model-c' }))
  const vendorKey = applyDefaultReasoningEffort(input({
    config: { default: 'off', models: { 'vendor/model-b': 'low' } },
    model: 'model-b',
  }))
  assert.equal(vendorKey.added, 'low')
})

test('the request header replaces the setting for one request', () => {
  assertUntouched(input({ header: 'off' }))
  assert.equal(applyDefaultReasoningEffort(input({ header: 'high', model: 'model-c' })).added, 'high')
  assert.equal(applyDefaultReasoningEffort(input({ header: 'high', config: null })).added, 'high')
  // A header the buyer cannot read never falls back to the setting. Sent twice, it arrives joined.
  for (const header of ['not a level', 'high, off', '']) assertUntouched(input({ header }), JSON.stringify(header))
})

test('off means off in any letter case, in the setting and in the header', () => {
  for (const off of ['OFF', 'Off', 'oFf']) {
    const capabilities = { reasoningEfforts: [off, 'medium'] }
    assertUntouched(input({ config: { default: off, models: {} }, capabilities }), `default ${off}`)
    assertUntouched(input({ config: { default: 'medium', models: { 'model-a': off } }, capabilities }), `model ${off}`)
    assertUntouched(input({ header: off, capabilities }), `header ${off}`)
  }
})

test('a level that is not visible ASCII is never added, from the setting or the header', () => {
  for (const level of ['\u81ea\u52d5', 'caf\u00e9', 'very high']) {
    const capabilities = { reasoningEfforts: [level] }
    assertUntouched(input({ config: { default: level, models: {} }, capabilities }), `default ${level}`)
    assertUntouched(input({ config: null, header: level, capabilities }), `header ${level}`)
  }
})

test('adds nothing when either side speaks anthropic messages', () => {
  assertUntouched(input({ requestProtocol: 'anthropic-messages', targetProtocol: 'openai-chat-completions', path: '/v1/messages' }))
  assertUntouched(input({ requestProtocol: 'anthropic-messages', targetProtocol: 'anthropic-messages', path: '/v1/messages' }))
  assertUntouched(input({ requestProtocol: 'openai-chat-completions', targetProtocol: 'anthropic-messages' }))
  assertUntouched(input({ requestProtocol: 'openai-responses', targetProtocol: 'anthropic-messages' }))
})

test('adds nothing to requests that are not chat or responses', () => {
  for (const protocol of ['openai-images', 'openai-audio-speech', null] as const) {
    assertUntouched(input({ requestProtocol: protocol, targetProtocol: protocol }), String(protocol))
  }
})

test('adds only to a POST on the create paths, with or without a query or trailing slash', () => {
  const responses = (path: string, method = 'POST') => applyDefaultReasoningEffort(input({
    requestProtocol: 'openai-responses',
    request: request({ model: 'model-a', input: 'hi' }, undefined, path, method),
  })).added
  assert.equal(responses('/v1/responses'), 'medium')
  assert.equal(responses('/v1/responses/'), 'medium')
  assert.equal(responses('/v1/responses?stream=true'), 'medium')
  assert.equal(responses('/v1/responses/compact'), null)
  assert.equal(responses('/v1/responses/input_tokens'), null)
  assert.equal(responses('/v1/responses/resp_1'), null)
  assert.equal(responses('/v1/responses', 'GET'), null)
  assert.equal(applyDefaultReasoningEffort(input({ path: '/v1/chat/completions/' })).added, 'medium')
  assert.equal(applyDefaultReasoningEffort(input({ path: '/v1/chat/completions/chatcmpl-1' })).added, null)
})

test('a body that is not a JSON object is returned as is', () => {
  assertUntouched(input({ request: request(['model-a']) }))
  assertUntouched(input({ request: request(null, 'not json at all') }))
})

test('a body that parses but cannot be written again is returned as is', () => {
  const depth = 20_000
  const raw = `{"model":"model-a","messages":[],"metadata":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`
  assertUntouched({ ...input({}), request: request(null, raw) })
})

test('isReasoningEffortSetting accepts off and visible ASCII labels only', () => {
  const cases: Array<[unknown, boolean]> = [
    ['low', true],
    ['xhigh', true],
    ['off', true],
    ['OFF', true],
    ['effort-2.5', true],
    ['x'.repeat(64), true],
    ['x'.repeat(65), false],
    ['', false],
    ['has space', false],
    ['tab\there', false],
    ['new\nline', false],
    ['bell\u0007', false],
    ['zero\u200bwidth', false],
    ['\u81ea\u52d5', false],
    [42, false],
    [null, false],
  ]
  for (const [value, expected] of cases) {
    assert.equal(isReasoningEffortSetting(value), expected, JSON.stringify(value))
  }
})
