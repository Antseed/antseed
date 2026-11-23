import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ANTSEED_REQUIRE_ZERO_DATA_ACCESS_HEADER } from '@antseed/node'
import { GATEWAY_CONTROL_HEADER, ROUTING_POLICY_HEADER, ZERO_DATA_ACCESS_POLICY_CAPABILITY, decodePolicyHeader } from '../routing-policy/policy.js'
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

test('a confirmed buyer keeps policy support through probes that get no answer, for two minutes', async () => {
  const logs: string[] = []
  let now = 1_000_000
  let answer: 'ok' | 'silent' | 'refuse' = 'ok'
  const probe = new BuyerPolicyProbe({
    buyerPort: 1,
    secret: 'x',
    now: () => now,
    onLog: (message) => logs.push(message),
    fetchPreview: async () => {
      if (answer === 'silent') throw new Error('timeout')
      return answer === 'ok'
        ? new Response(JSON.stringify({ candidates: [] }), { status: 200 })
        : new Response('{}', { status: 404 })
    },
  })
  try {
    assert.equal(await probe.start(), 'supported')
    answer = 'silent'
    now += 60_000
    await probe.check()
    assert.equal(probe.policyUnsupported(), false, 'one unanswered probe does not refuse keys')
    assert.deepEqual(logs, [])
    now += 59_000
    await probe.check()
    assert.equal(probe.policyUnsupported(), false)
    now += 1_000
    await probe.check()
    assert.equal(probe.policyUnsupported(), true, 'two minutes of silence does')
    assert.match(logs.at(-1)!, /^WARNING: cannot reach the buyer/)

    answer = 'ok'
    await probe.check()
    assert.equal(probe.policyUnsupported(), false)
    answer = 'refuse'
    await probe.check()
    assert.equal(probe.policyUnsupported(), true, 'a refusing answer takes effect at once')
    answer = 'silent'
    await probe.check()
    assert.equal(probe.state, 'unknown', 'no grace after a refusal')
  } finally {
    probe.stop()
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

test('a buyer that applies policies but not the zero data access requirement gets no request that needs it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-gw-probe-'))
  const store = new GatewayStore(dir)
  // A buyer from before the requirement: it previews routes, decodes any policy and routes by the fields it knows.
  let upgraded = false
  const forwarded: Array<ReturnType<typeof decodePolicyHeader>> = []
  const buyer = await listen((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url!.startsWith('/_antseed/route-preview')) {
        const preview = { model: '__probe__', candidates: [], ...(upgraded ? { capabilities: [ZERO_DATA_ACCESS_POLICY_CAPABILITY] } : {}) }
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(preview))
      }
      const policy = req.headers[ROUTING_POLICY_HEADER]
      forwarded.push(typeof policy === 'string' ? decodePolicyHeader(policy) : null)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  const accounting = new GatewayAccounting(store, { holdUsdc: 100_000, settleGraceMs: 20 })
  const probe = new BuyerPolicyProbe({ buyerPort: buyer.port, secret: 'control-secret' })
  const server = new GatewayServer({
    store,
    accounting,
    buyerPort: buyer.port,
    identityAddress: async () => null,
    spendFeedState: () => 'ok' as never,
    refreshSpendFeed: async () => {},
    controlSecret: 'control-secret',
    buyerPolicyUnsupported: () => probe.policyUnsupported(),
    buyerZeroDataAccessUnsupported: () => probe.zeroDataAccessUnsupported(),
  })
  const port = await server.start()
  const send = (secret: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'm' }),
  })
  try {
    assert.equal(await probe.start(), 'supported', 'the older buyer applies ordinary policies')
    const blind = store.createKey({ label: 'z', limits: NO_LIMITS, expiresAt: null, routingPolicy: { requireZeroDataAccess: true } })
    const tee = store.createKey({ label: 't', limits: NO_LIMITS, expiresAt: null, routingPolicy: { requireTee: true } })
    const open = store.createKey({ label: 'o', limits: NO_LIMITS, expiresAt: null })

    for (const refused of [await send(blind.secret), await send(open.secret, { [ANTSEED_REQUIRE_ZERO_DATA_ACCESS_HEADER]: 'true' })]) {
      assert.equal(refused.status, 503)
      assert.equal(((await refused.json()) as any).error.code, 'buyer_policy_unsupported')
    }
    assert.deepEqual(forwarded, [], 'nothing that needs zero data access reaches the older buyer')
    // What the older buyer does apply still goes through.
    assert.equal((await send(tee.secret)).status, 200)
    assert.equal((await send(open.secret)).status, 200)
    assert.deepEqual(forwarded, [{ requireTee: true }, null])

    upgraded = true
    await probe.check()
    assert.equal((await send(blind.secret)).status, 200)
    assert.deepEqual(forwarded.at(-1), { requireZeroDataAccess: true })
  } finally {
    probe.stop()
    await server.stop()
    accounting.dispose()
    await buyer.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** How a buyer from before the zero data access requirement reads a policy header: a JSON object, of which it applies the fields it knows. */
function olderBuyerPolicy(header: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const { requireZeroDataAccess: _unknown, ...known } = parsed as Record<string, unknown>
  return known
}

test('a buyer replaced by one from before the zero data access requirement routes nothing that needs it, before the gateway has probed it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-gw-probe-'))
  const store = new GatewayStore(dir)
  let replaced = false
  let previews = 0
  const routed: unknown[] = []
  const buyer = await listen((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url!.startsWith('/_antseed/route-preview')) {
        previews += 1
        const preview = { model: '__probe__', candidates: [], ...(replaced ? {} : { capabilities: [ZERO_DATA_ACCESS_POLICY_CAPABILITY] }) }
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(preview))
      }
      const header = req.headers[ROUTING_POLICY_HEADER]
      const policy = typeof header !== 'string' ? {} : replaced ? olderBuyerPolicy(header) : decodePolicyHeader(header)
      if (!policy) {
        return void res.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_routing_policy', message: 'not a valid routing policy' } }))
      }
      routed.push(policy)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  const accounting = new GatewayAccounting(store, { holdUsdc: 100_000, settleGraceMs: 20 })
  const probe = new BuyerPolicyProbe({ buyerPort: buyer.port, secret: 'control-secret' })
  const server = new GatewayServer({
    store,
    accounting,
    buyerPort: buyer.port,
    identityAddress: async () => null,
    spendFeedState: () => 'ok' as never,
    refreshSpendFeed: async () => {},
    controlSecret: 'control-secret',
    buyerPolicyUnsupported: () => probe.policyUnsupported(),
    buyerZeroDataAccessUnsupported: () => probe.zeroDataAccessUnsupported(),
    recheckBuyerPolicy: () => probe.recheck(),
  })
  const port = await server.start()
  const send = (secret: string) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm' }),
  })
  try {
    assert.equal(await probe.start(), 'supported')
    const blind = store.createKey({ label: 'z', limits: NO_LIMITS, expiresAt: null, routingPolicy: { requireZeroDataAccess: true, requireTee: true } })
    const tee = store.createKey({ label: 't', limits: NO_LIMITS, expiresAt: null, routingPolicy: { requireTee: true } })
    assert.equal((await send(blind.secret)).status, 200)
    assert.deepEqual(routed, [{ requireZeroDataAccess: true, requireTee: true }])

    // An older buyer takes the port, with the same control secret. The gateway still holds the first one's answer.
    replaced = true
    assert.equal(probe.zeroDataAccessUnsupported(), false)
    const refused = await send(blind.secret)
    const refusal = await refused.text()
    assert.deepEqual(routed.slice(1), [], 'the older buyer routed a request that requires zero data access without the requirement')
    assert.equal(refused.status, 400, refusal)
    assert.match(refusal, /invalid_routing_policy/)
    // That refusal makes the gateway probe the buyer again, so the next such request is refused by the gateway itself.
    const probed = previews
    for (let waited = 0; previews === probed && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
    for (let waited = 0; !probe.zeroDataAccessUnsupported() && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
    const next = await send(blind.secret)
    assert.equal(next.status, 503)
    assert.equal(((await next.json()) as any).error.code, 'buyer_policy_unsupported')
    // What the older buyer does apply still reaches it.
    assert.equal((await send(tee.secret)).status, 200)
    assert.deepEqual(routed.slice(1), [{ requireTee: true }])
  } finally {
    probe.stop()
    await server.stop()
    accounting.dispose()
    await buyer.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
