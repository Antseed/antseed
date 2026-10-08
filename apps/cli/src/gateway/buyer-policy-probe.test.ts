import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GATEWAY_CONTROL_HEADER, ROUTING_POLICY_HEADER } from '../routing-policy/policy.js'
import { GatewayAccounting } from './accounting.js'
import { BuyerPolicyProbe, probeBuyerPolicySupport } from './buyer-policy-probe.js'
import { GatewayServer } from './server.js'
import { GatewayStore } from './store.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('the probe sends an authenticated route preview and classifies the answer', async () => {
  const seen: http.IncomingHttpHeaders[] = []
  let status = 200
  const buyer = await listen((req, res) => {
    seen.push(req.headers)
    assert.equal(req.url, '/_antseed/route-preview?model=__probe__')
    if (status !== 200) return void res.writeHead(status).end('{}')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: '__probe__', candidates: [] }))
  })
  try {
    const options = { buyerPort: buyer.port, secret: 's3cret' }
    assert.equal(await probeBuyerPolicySupport(options), 'supported')
    assert.equal(seen[0]![GATEWAY_CONTROL_HEADER], 's3cret')
    assert.ok(seen[0]![ROUTING_POLICY_HEADER], 'a policy is sent so decoding is exercised too')
    status = 401 // wrong secret
    assert.equal(await probeBuyerPolicySupport(options), 'unsupported')
    status = 404 // older buyer without the endpoint
    assert.equal(await probeBuyerPolicySupport(options), 'unsupported')
  } finally {
    await buyer.close()
  }
  assert.equal(await probeBuyerPolicySupport({ buyerPort: buyer.port, secret: 'x' }), 'unknown')
})

test('the probe logs loudly while policies are unsupported and notices recovery', async () => {
  const logs: string[] = []
  let answer = 404
  const probe = new BuyerPolicyProbe({
    buyerPort: 1,
    secret: 'x',
    onLog: (message) => logs.push(message),
    fetchPreview: async () => answer === 200
      ? new Response(JSON.stringify({ candidates: [] }), { status: 200 })
      : new Response('{}', { status: answer }),
  })
  try {
    assert.equal(await probe.start(), 'unsupported')
    assert.equal(probe.policyUnsupported(), true)
    assert.match(logs[0]!, /^WARNING: .*buyer_policy_unsupported/)
    answer = 200
    await probe.check()
    assert.equal(probe.policyUnsupported(), false)
    assert.equal(logs.at(-1), 'The buyer now applies routing policies.')
  } finally {
    probe.stop()
  }

  const unreachable = new BuyerPolicyProbe({ buyerPort: 1, secret: 'x', onLog: (message) => logs.push(message), fetchPreview: async () => { throw new Error('ECONNREFUSED') } })
  try {
    assert.equal(await unreachable.start(), 'unknown')
    assert.equal(unreachable.policyUnsupported(), true, 'unconfirmed counts as unsupported')
    assert.match(logs.at(-1)!, /^WARNING: cannot reach the buyer/)
  } finally {
    unreachable.stop()
  }
})

test('the server refuses paid requests from seller-restricting keys while the buyer cannot apply policies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-gw-probe-'))
  const store = new GatewayStore(dir)
  let forwarded = 0
  const buyer = await listen((req, res) => {
    req.resume()
    req.on('end', () => {
      forwarded += 1
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  const accounting = new GatewayAccounting(store, { holdUsdc: 100_000, settleGraceMs: 20 })
  let unsupported = true
  const server = new GatewayServer({
    store,
    accounting,
    buyerPort: buyer.port,
    identityAddress: async () => null,
    spendFeedState: () => 'ok' as never,
    refreshSpendFeed: async () => {},
    controlSecret: 'control-secret',
    buyerPolicyUnsupported: () => unsupported,
  })
  const port = await server.start()
  const send = (secret: string) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm' }),
  })
  try {
    const restricted = store.createKey({ label: 'r', limits: NO_LIMITS, expiresAt: null, routingPolicy: { requireTee: true } })
    const modelsOnly = store.createKey({ label: 'm', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['m'] } })

    const refused = await send(restricted.secret)
    assert.equal(refused.status, 503)
    assert.equal(((await refused.json()) as any).error.code, 'buyer_policy_unsupported')
    assert.equal(forwarded, 0)
    // allowedModels is enforced by the gateway itself, so it does not need the buyer.
    assert.equal((await send(modelsOnly.secret)).status, 200)

    unsupported = false
    assert.equal((await send(restricted.secret)).status, 200)
  } finally {
    await server.stop()
    accounting.dispose()
    await buyer.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
