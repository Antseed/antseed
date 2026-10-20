import assert from 'node:assert/strict'
import test from 'node:test'
import { ROUTER_PEER_ID_HEADER, withoutRouterHeaders } from './telemetry.js'
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
