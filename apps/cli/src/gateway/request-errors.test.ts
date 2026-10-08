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

async function fakeBuyer(respond: (res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => respond(res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
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
  const deadBuyer = new GatewayServer({ ...options, buyerPort: 1 })
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
