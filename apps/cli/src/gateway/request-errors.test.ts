import assert from 'node:assert/strict'
import * as http from 'node:http'
import { test } from 'node:test'
import { GatewayAccounting } from './accounting.js'
import { OtlpExporter, type RequestSpan } from './observability.js'
import { GatewayServer, parseErrorBody } from './server.js'
import { tempDataDir } from './console-api/test-support.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

test('error bodies: OpenAI, Anthropic, plain-string and non-JSON envelopes', () => {
  const parse = (body: string, status = 400) => parseErrorBody(Buffer.from(body), status)
  assert.deepEqual(parse('{"error":{"message":"Bad model","type":"invalid_request_error","code":"model_not_found"}}'), { code: 'model_not_found', message: 'Bad model' })
  assert.deepEqual(parse('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 529), { code: 'overloaded_error', message: 'Overloaded' })
  assert.deepEqual(parse('{"ok":false,"error":"no_peers_available"}', 503), { code: 'http_503', message: 'no_peers_available' })
  assert.deepEqual(parse('<html>Bad   Gateway</html>', 502), { code: 'http_502', message: '<html>Bad Gateway</html>' })
  assert.deepEqual(parse('', 500), { code: 'http_500', message: null })
  assert.equal(parse(JSON.stringify({ error: { message: 'y'.repeat(2_000) } })).message!.length, 500)
})

async function fakeBuyer(respond: (res: http.ServerResponse) => void, port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => respond(res))
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

async function post(port: number, secret: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end('{"model":"open-model"}')
  })
}

test('failed requests keep the seller\'s error code and message, and buyer outages are recorded as such', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await fakeBuyer((res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end('{"error":{"type":"rate_limit_error","message":"Slow down"}}')
  })
  const accounting = new GatewayAccounting(store, { holdUsdc: 1_000, settleGraceMs: 10 })
  const options = { store, accounting, identityAddress: async () => null, spendFeedState: () => 'reporting' as const, refreshSpendFeed: async () => {} }
  const gateway = new GatewayServer({ ...options, buyerPort: buyer.port })
  const deadBuyer = new GatewayServer({ ...options, buyerPort: 1, buyerRestartHoldMs: 0 })
  try {
    const { secret } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    assert.equal(await post(await gateway.start(), secret), 429)
    assert.equal(await post(await deadBuyer.start(), secret), 502)
    const [outage, limited] = store.listRequests({})
    assert.deepEqual([limited!.status, limited!.errorCode, limited!.errorMessage], [429, 'rate_limit_error', 'Slow down'])
    assert.deepEqual([outage!.status, outage!.errorCode], [502, 'buyer_unavailable'])
    assert.equal(store.usageReport({}, null).totals.failedRequests, 2)
  } finally {
    await gateway.stop()
    await deadBuyer.stop()
    await buyer.close()
    accounting.dispose()
    cleanup()
  }
})

test('a client that leaves before the buyer answers is recorded as its cancel, not a buyer outage', async () => {
  const { store, cleanup } = tempDataDir()
  let buyerGotRequest: () => void = () => {}
  const reached = new Promise<void>((resolve) => { buyerGotRequest = resolve })
  // The buyer never answers, like a seller still thinking.
  const buyer = await fakeBuyer(() => buyerGotRequest())
  const accounting = new GatewayAccounting(store, { holdUsdc: 1_000, settleGraceMs: 10 })
  const gateway = new GatewayServer({ store, accounting, buyerPort: buyer.port, identityAddress: async () => null, spendFeedState: () => 'reporting' as const, refreshSpendFeed: async () => {} })
  try {
    const { secret } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    const port = await gateway.start()
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' } })
    req.on('error', () => {})
    req.end('{"model":"open-model"}')
    await reached
    req.destroy()
    for (let attempt = 0; attempt < 100 && store.listRequests({})[0]?.status == null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const [cancelled] = store.listRequests({})
    assert.deepEqual([cancelled!.status, cancelled!.errorCode], [499, 'client_closed_request'])
  } finally {
    await gateway.stop()
    await buyer.close()
    accounting.dispose()
    cleanup()
  }
})

/** A port nothing listens on, like a buyer between its old process and the new one. */
async function closedPort(): Promise<number> {
  const probe = await fakeBuyer(() => {})
  await probe.close()
  return probe.port
}

const ok = (res: http.ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
}

test('a request waits for a restarting buyer instead of failing, and gives up after the hold', async () => {
  const { store, cleanup } = tempDataDir()
  const buyerPort = await closedPort()
  const accounting = new GatewayAccounting(store, { holdUsdc: 1_000, settleGraceMs: 10 })
  const gateway = new GatewayServer({ store, accounting, buyerPort, buyerRestartHoldMs: 5_000, identityAddress: async () => null, spendFeedState: () => 'reporting' as const, refreshSpendFeed: async () => {} })
  const shortHold = new GatewayServer({ store, accounting, buyerPort: await closedPort(), buyerRestartHoldMs: 300, identityAddress: async () => null, spendFeedState: () => 'reporting' as const, refreshSpendFeed: async () => {} })
  let buyer: Awaited<ReturnType<typeof fakeBuyer>> | null = null
  try {
    const { secret } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    const port = await gateway.start()
    const answered = post(port, secret)
    await new Promise((resolve) => setTimeout(resolve, 800))
    buyer = await fakeBuyer(ok, buyerPort)
    assert.equal(await answered, 200, 'the request reaches the buyer once it is back')
    assert.deepEqual(store.listRequests({}).map((row) => row.status), [200], 'one request, recorded once')

    assert.equal(await post(await shortHold.start(), secret), 502)
    assert.equal(store.listRequests({})[0]!.errorCode, 'buyer_unavailable')
  } finally {
    await gateway.stop()
    await shortHold.stop()
    await buyer?.close()
    accounting.dispose()
    cleanup()
  }
})

test('a client that leaves while its request waits for the buyer is recorded as its cancel', async () => {
  const { store, cleanup } = tempDataDir()
  const accounting = new GatewayAccounting(store, { holdUsdc: 1_000, settleGraceMs: 10 })
  const gateway = new GatewayServer({ store, accounting, buyerPort: await closedPort(), buyerRestartHoldMs: 5_000, identityAddress: async () => null, spendFeedState: () => 'reporting' as const, refreshSpendFeed: async () => {} })
  try {
    const { secret } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    const port = await gateway.start()
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' } })
    req.on('error', () => {})
    req.end('{"model":"open-model"}')
    await new Promise((resolve) => setTimeout(resolve, 600))
    req.destroy()
    for (let attempt = 0; attempt < 100 && store.listRequests({})[0]?.status == null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const [cancelled] = store.listRequests({})
    assert.deepEqual([cancelled!.status, cancelled!.errorCode], [499, 'client_closed_request'])
    assert.equal(accounting.heldUsdc(cancelled!.keyId), 0)
  } finally {
    await gateway.stop()
    accounting.dispose()
    cleanup()
  }
})

test('a capped key waits for the spend feed of a restarting buyer instead of failing closed at once', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await fakeBuyer(ok)
  const accounting = new GatewayAccounting(store, { holdUsdc: 1_000, settleGraceMs: 10 })
  let state: 'reporting' | 'unreachable' = 'unreachable'
  let polls = 0
  const gateway = new GatewayServer({
    store, accounting, buyerPort: buyer.port, buyerRestartHoldMs: 5_000, identityAddress: async () => null,
    spendFeedState: () => state,
    refreshSpendFeed: async () => { polls += 1; if (polls >= 3) state = 'reporting' },
  })
  try {
    const { secret } = store.createKey({ label: 'capped', limits: { ...NO_LIMITS, monthly: 5_000_000 }, expiresAt: null })
    assert.equal(await post(await gateway.start(), secret), 200)
    assert.equal(polls, 3)
  } finally {
    await gateway.stop()
    await buyer.close()
    accounting.dispose()
    cleanup()
  }
})

test('stopping lets requests in flight finish, and closes the ones that outlast the drain', async () => {
  const { store, cleanup } = tempDataDir()
  const slow = await fakeBuyer((res) => { setTimeout(() => ok(res), 300) })
  const stuck = await fakeBuyer(() => {})
  const accounting = new GatewayAccounting(store, { holdUsdc: 1_000, settleGraceMs: 10 })
  const options = { store, accounting, identityAddress: async () => null, spendFeedState: () => 'reporting' as const, refreshSpendFeed: async () => {} }
  const draining = new GatewayServer({ ...options, buyerPort: slow.port })
  const bounded = new GatewayServer({ ...options, buyerPort: stuck.port, shutdownDrainMs: 200 })
  try {
    const { secret } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    const answered = post(await draining.start(), secret)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await draining.stop()
    assert.equal(await answered, 200, 'the request in flight finished before the gateway stopped')

    const cut = post(await bounded.start(), secret).catch(() => 'closed')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const startedStop = Date.now()
    await bounded.stop()
    assert.ok(Date.now() - startedStop < 2_000, 'a request that never ends does not hold the stop')
    assert.equal(await cut, 'closed')
    for (let attempt = 0; attempt < 100 && store.listRequests({})[0]?.status == null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const [closed] = store.listRequests({})
    assert.deepEqual([closed!.status, closed!.errorCode], [503, 'gateway_stopping'], 'the gateway closed it, not the client')
  } finally {
    await slow.close()
    await stuck.close().catch(() => {})
    accounting.dispose()
    cleanup()
  }
})

test('admission reads only capped periods, and a request that fails to start releases its hold', () => {
  const { store, cleanup } = tempDataDir()
  const accounting = new GatewayAccounting(store, { holdUsdc: 1_000, settleGraceMs: 10 })
  try {
    const owner = store.createOwner({ label: 'O', email: null })
    store.updateMember(owner.id, { limits: { monthly: 1_000 } })
    const { key } = store.createKey({ label: 'k', ownerMemberId: owner.id, limits: NO_LIMITS, expiresAt: null })
    const asked: string[][] = []
    const original = store.spendByPeriod.bind(store)
    store.spendByPeriod = (scope, now, periods) => {
      asked.push([Object.keys(scope)[0]!, ...(periods ?? [])])
      return original(scope, now, periods)
    }
    const first = accounting.admit(key)
    assert.ok(first.ok)
    assert.deepEqual(asked, [['memberId', 'monthly']], 'the uncapped key and workspace cost no query')
    assert.equal(accounting.admit(key).ok, false, 'the first hold leaves no room')
    accounting.release(first.ok ? first.tag : '')
    assert.equal(accounting.heldForMember(owner.id), 0)
    assert.equal(accounting.admit(key).ok, true)
  } finally {
    accounting.dispose()
    cleanup()
  }
})

test('the OTLP exporter keeps sending while a full batch is queued', async () => {
  const batches: number[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    batches.push(JSON.parse(String(init.body)).resourceSpans[0].scopeSpans[0].spans.length)
    return new Response(null, { status: 200 })
  }) as unknown as typeof fetch
  const settings = { otlpEndpoint: 'https://otel.example.test', otlpHeaders: {}, logContent: false, retentionDays: null }
  const exporter = new OtlpExporter(() => settings, { fetchImpl, flushIntervalMs: 60_000 })
  const span: RequestSpan = {
    tag: 'gw_1', method: 'POST', path: '/v1/responses', model: 'm', status: 200, startedAt: 1, finishedAt: 2,
    keyId: 'key_1', workspaceId: 'ws_default', memberId: null, endUser: null, sellerPeerId: null, latencyMs: 1,
  }
  for (let index = 0; index < 250; index += 1) exporter.record(span)
  await exporter.flush()
  assert.deepEqual(batches, [100, 100], 'one flush drains every full batch')
  await exporter.stop()
  assert.deepEqual(batches, [100, 100, 50], 'stop sends the rest')
})
