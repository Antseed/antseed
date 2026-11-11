import assert from 'node:assert/strict'
import test from 'node:test'
import { requestBodyService } from '@antseed/node'
import { overrideRoutedModelInBody, rewritePeerPinnedServiceInBody, substituteRoutedModelAlias } from './request-utils.js'

const PEER = 'a'.repeat(40)
const JSON_HEADERS = { 'content-type': 'application/json' }
const BOUNDARY = 'form-boundary'
const MULTIPART_HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }

const json = (fields: Record<string, unknown>): Uint8Array => new TextEncoder().encode(JSON.stringify(fields))
const form = (fields: Array<[string, string]>): Uint8Array => new TextEncoder().encode(
  `${fields.map(([name, value]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')}--${BOUNDARY}--\r\n`,
)

/** The body rewrites the proxy applies to a request, in order, before it goes to the seller. */
function asSent(body: Uint8Array, headers: Record<string, string>, routedService: string, defaultRoute = `${PEER}@${routedService}`) {
  const alias = substituteRoutedModelAlias(body, headers, defaultRoute)
  const pinned = rewritePeerPinnedServiceInBody(alias.body, alias.headers)
  const routed = overrideRoutedModelInBody(pinned.body, pinned.headers, routedService)
  return { body: routed.body, headers: routed.headers }
}

// The seller refuses a body that names more than one service, so what the buyer
// sends must always name exactly the service it routed to.
for (const [label, fields, routed] of [
  ['a model', { model: 'glm-5' }, 'glm-5'],
  ['a model spelled differently from the service', { model: 'GLM-5' }, 'glm-5'],
  ['service and model together', { service: 'GLM-5', model: 'GLM-5' }, 'glm-5'],
  ['a pinned model', { model: `${PEER}@glm-5` }, 'glm-5'],
  ['a pinned model spelled differently', { model: `${PEER}@GLM-5` }, 'glm-5'],
  ['a pinned service', { service: `${PEER}@glm-5` }, 'glm-5'],
  ['a pinned model next to its service', { model: `${PEER}@glm-5`, service: 'glm-5' }, 'glm-5'],
  ['the routed-model alias', { model: 'antseed' }, 'glm-5'],
  ['the routed-model alias in both fields', { model: 'antseed', service: 'antseed' }, 'glm-5'],
  ['a model next to the service it routes by', { model: 'other-model', service: 'glm-5' }, 'glm-5'],
] as const) {
  test(`a request with ${label} reaches the seller naming the routed service`, () => {
    assert.equal(requestBodyService(asSent(json(fields), JSON_HEADERS, routed)), routed)
  })
}

test('a multipart request reaches the seller naming the routed service', () => {
  assert.equal(requestBodyService(asSent(form([['model', 'glm-5'], ['prompt', 'x']]), MULTIPART_HEADERS, 'glm-5')), 'glm-5')
  assert.equal(requestBodyService(asSent(form([['model', `${PEER}@glm-5`], ['prompt', 'x']]), MULTIPART_HEADERS, 'glm-5')), 'glm-5')
})
