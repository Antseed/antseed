import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SPEND_ATTRIBUTION_HEADER, SpendAttributionFeed } from '../proxy/spend-attribution.js'
import { GatewayAccounting } from './accounting.js'
import { generateApiKey } from './keys.js'
import { findLimitBreach, periodResetsAt, periodStart } from './limits.js'
import { formatUsdc, parseUsdToUsdc, usdcToDecimalString } from './money.js'
import { GatewayServer } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import { DEFAULT_IDENTITY_ID, GatewayStore, type GatewayIdentity } from './store.js'

const NO_LIMITS = { daily: null, monthly: null, total: null }

function tempStore(): { store: GatewayStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-gateway-'))
  const store = new GatewayStore(dir)
  return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

async function request(port: number, path: string, options: { method?: string; key?: string; body?: string; headers?: http.OutgoingHttpHeaders } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        ...(options.key ? { authorization: `Bearer ${options.key}`, 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

/**
 * Stand-in for `antseed buyer start`: answers API routes, records the tag the
 * gateway attaches, and serves the attributed-spend feed for tagged requests.
 */
async function fakeBuyer(options: { costUsdc?: number; spendFeed?: boolean } = {}) {
  const feed = new SpendAttributionFeed()
  const captured: Array<{ url: string; auth?: string; source?: string; tag?: string }> = []
  let requestCounter = 0
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/_antseed/attributed-spend')) {
      if (options.spendFeed === false) {
        res.writeHead(404).end()
        return
      }
      const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...feed.page(after) }))
      return
    }
    req.resume()
    req.on('end', () => {
      const tag = req.headers[SPEND_ATTRIBUTION_HEADER] as string | undefined
      captured.push({
        url: req.url ?? '',
        auth: req.headers.authorization,
        source: req.headers['x-antseed-system-proxy-source'] as string | undefined,
        tag,
      })
      const requestId = `req-${++requestCounter}`
      if (tag && options.costUsdc) {
        feed.track(requestId, tag)
        feed.record({
          requestId,
          sellerPeerId: 'seller',
          amountUsdc: String(options.costUsdc),
          inputTokens: '100',
          cachedInputTokens: '0',
          outputTokens: '20',
          outputImages: '0',
        })
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-antseed-request-id': requestId })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  const port = await listen(server)
  return { port, captured, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function startGateway(store: GatewayStore, buyerPort: number, holdUsdc = 300_000) {
  const accounting = new GatewayAccounting(store, { holdUsdc, settleGraceMs: 50 })
  const feed = new SpendFeedPoller({
    targets: () => [{ identityId: DEFAULT_IDENTITY_ID, port: buyerPort }],
    onPage: (identityId, page) => accounting.ingest(identityId, page.bootId, page.events),
    intervalMs: 60_000,
  })
  const logs: string[] = []
  const server = new GatewayServer({
    store,
    accounting,
    resolveBuyerPort: (_identity: GatewayIdentity) => buyerPort,
    spendFeedState: (identityId) => feed.state(identityId),
    refreshSpendFeed: () => feed.pollOnce(),
    onLog: (message) => logs.push(message),
  })
  const port = await server.start()
  return {
    port,
    logs,
    feed,
    accounting,
    stop: async () => {
      await server.stop()
      accounting.dispose()
    },
  }
}

test('money parses and formats USD amounts as USDC base units', () => {
  assert.equal(parseUsdToUsdc('5'), 5_000_000)
  assert.equal(parseUsdToUsdc('$0.25'), 250_000)
  assert.equal(parseUsdToUsdc('12.000001'), 12_000_001)
  assert.throws(() => parseUsdToUsdc('-1'))
  assert.throws(() => parseUsdToUsdc('1.0000001'))
  assert.equal(usdcToDecimalString(1_500_000), '1.500000')
  assert.equal(formatUsdc(1_500_000), '$1.50')
  assert.equal(formatUsdc(1_234), '$0.0012')
})

test('limits use UTC calendar periods and count in-flight holds', () => {
  const now = Date.UTC(2026, 9, 6, 15, 30)
  assert.equal(periodStart('daily', now), Date.UTC(2026, 9, 6))
  assert.equal(periodStart('monthly', now), Date.UTC(2026, 9, 1))
  assert.equal(periodResetsAt('monthly', now), Date.UTC(2026, 10, 1))
  assert.equal(periodResetsAt('total', now), null)

  const limits = { daily: 1_000_000, monthly: null, total: 5_000_000 }
  assert.equal(findLimitBreach(limits, { daily: 600_000, monthly: 600_000, total: 600_000 }, 300_000, now), null)
  const breach = findLimitBreach(limits, { daily: 600_000, monthly: 600_000, total: 600_000 }, 400_000, now)
  assert.equal(breach?.period, 'daily')
  assert.equal(breach?.resetsAt, Date.UTC(2026, 9, 7))
})

test('store keeps keys hashed, syncs the tunnel env key, and records ledger entries idempotently', () => {
  const { store, cleanup } = tempStore()
  try {
    const { key, secret } = store.createKey({ label: 'Alice', identityId: DEFAULT_IDENTITY_ID, limits: NO_LIMITS, expiresAt: null })
    assert.equal(store.findKeyBySecret(secret)?.id, key.id)
    assert.equal(store.findKeyBySecret(`${secret}x`), null)
    assert.ok(!JSON.stringify(store.listKeys()).includes(secret))

    const envKey = store.syncEnvironmentKey('antseed_legacy_tunnel_key_1')
    assert.equal(envKey.source, 'tunnel-env')
    assert.equal(store.syncEnvironmentKey('antseed_rotated_tunnel_key_2').id, envKey.id)
    assert.equal(store.findKeyBySecret('antseed_legacy_tunnel_key_1'), null)
    assert.equal(store.findKeyBySecret('antseed_rotated_tunnel_key_2')?.id, envKey.id)

    const entry = {
      kind: 'spend' as const,
      keyId: key.id,
      identityId: DEFAULT_IDENTITY_ID,
      amountUsdc: 250_000,
      externalRef: 'spend:default:boot:1',
      createdAt: Date.now(),
    }
    assert.equal(store.recordLedgerEntry(entry), true)
    assert.equal(store.recordLedgerEntry(entry), false)
    assert.equal(store.recordLedgerEntry({ ...entry, kind: 'credit', amountUsdc: 1_000_000, externalRef: 'credit:test' }), true)
    assert.deepEqual(store.periodSpend(key.id), { daily: 250_000, monthly: 250_000, total: 250_000 })
    const stats = store.usageStats(key.id)
    assert.equal(stats.spentUsdc, 250_000)
    assert.equal(stats.creditedUsdc, 1_000_000)

    store.revokeKey(key.id)
    assert.equal(store.getKey(key.id)?.status, 'revoked')
    assert.equal(store.countActiveKeys(), 1)
  } finally {
    cleanup()
  }
})

test('store refuses to remove identities that back keys', () => {
  const { store, dir, cleanup } = tempStore()
  try {
    const identity = store.createIdentity({ id: 'team-a', dataDir: join(dir, 'team-a'), buyerPort: store.nextManagedBuyerPort([]), address: null })
    assert.equal(identity.buyerPort, 8390)
    assert.equal(store.nextManagedBuyerPort([]), 8391)
    store.createKey({ label: 'Bob', identityId: 'team-a', limits: NO_LIMITS, expiresAt: null })
    assert.deepEqual([...store.identitiesWithActiveKeys()], ['team-a'])
    assert.throws(() => store.removeIdentity('team-a'), /kept for their ledger/)
    assert.throws(() => store.removeIdentity(DEFAULT_IDENTITY_ID))
    assert.throws(() => store.createIdentity({ id: 'Bad Name', dataDir: join(dir, 'x'), buyerPort: 8400, address: null }))
  } finally {
    cleanup()
  }
})

test('spend attribution feed reports only tagged requests and pages by cursor', () => {
  const feed = new SpendAttributionFeed(() => 1000)
  feed.track('req-1', 'gw_a')
  const spend = { sellerPeerId: 's', amountUsdc: '10', inputTokens: '1', cachedInputTokens: '0', outputTokens: '1', outputImages: '0' }
  feed.record({ ...spend, requestId: 'req-1' })
  feed.record({ ...spend, requestId: 'req-untagged' })
  feed.record({ ...spend, requestId: 'req-1', amountUsdc: '5' })
  const first = feed.page(0)
  assert.deepEqual(first.events.map((event) => [event.seq, event.tag, event.amountUsdc]), [[1, 'gw_a', '10'], [2, 'gw_a', '5']])
  assert.equal(first.cursor, 2)
  assert.deepEqual(feed.page(first.cursor).events, [])
  assert.equal(feed.page(first.cursor).cursor, 2)
})

test('gateway exposes only authenticated supported API routes', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const { secret } = store.createKey({ label: 'Cursor', identityId: DEFAULT_IDENTITY_ID, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    assert.equal((await request(gateway.port, '/_antseed/status', { key: secret })).status, 404)
    assert.equal((await request(gateway.port, '/v1/models')).status, 401)
    assert.equal((await request(gateway.port, '/v1/models', { key: 'wrong' })).status, 401)
    assert.equal((await request(gateway.port, '/v1/models', { key: secret })).status, 200)
    assert.equal((await request(gateway.port, '/messages/count_tokens', { method: 'POST', key: secret, body: '{}' })).status, 200)
    assert.equal((await request(gateway.port, '/v1/responses', {
      method: 'POST', key: secret, body: '{"model":"m"}', headers: { originator: 'Cursor Agent' },
    })).status, 200)
    assert.equal((await request(gateway.port, '/responses', {
      method: 'POST', key: secret, body: '{}', headers: { 'x-cursor-client-version': '1.0.0' },
    })).status, 200)
    assert.equal((await request(gateway.port, '/v1/v1/responses?cursor=1', {
      method: 'POST', key: secret, body: '{}', headers: { 'user-agent': 'Cursor/1.0.0', [SPEND_ATTRIBUTION_HEADER]: 'spoofed' },
    })).status, 200)
    assert.equal((await request(gateway.port, '/responses/other', { method: 'POST', key: secret, body: '{}' })).status, 404)

    assert.deepEqual(buyer.captured.map(({ url, auth, source }) => ({ url, auth, source })), [
      { url: '/v1/models', auth: undefined, source: 'public-tunnel' },
      { url: '/v1/messages/count_tokens', auth: undefined, source: 'public-tunnel' },
      { url: '/v1/responses', auth: undefined, source: 'cursor' },
      { url: '/v1/responses', auth: undefined, source: 'cursor' },
      { url: '/v1/responses?cursor=1', auth: undefined, source: 'cursor' },
    ])
    // Every forwarded request carries a gateway tag, never the client's.
    assert.ok(buyer.captured.every((entry) => entry.tag?.startsWith('gw_')))
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('gateway rejects revoked and expired keys', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const revoked = store.createKey({ label: 'Old', identityId: DEFAULT_IDENTITY_ID, limits: NO_LIMITS, expiresAt: null })
  const expired = store.createKey({ label: 'Trial', identityId: DEFAULT_IDENTITY_ID, limits: NO_LIMITS, expiresAt: Date.now() - 1 })
  store.revokeKey(revoked.key.id)
  const gateway = await startGateway(store, buyer.port)
  try {
    const revokedResponse = await request(gateway.port, '/v1/models', { key: revoked.secret })
    assert.equal(revokedResponse.status, 401)
    assert.equal(JSON.parse(revokedResponse.body).error.code, 'key_revoked')
    const expiredResponse = await request(gateway.port, '/v1/models', { key: expired.secret })
    assert.equal(expiredResponse.status, 401)
    assert.equal(JSON.parse(expiredResponse.body).error.code, 'key_expired')
    assert.equal(buyer.captured.length, 0)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('gateway settles reported spend per key and answers 402 once a cap is reached', async () => {
  const { store, cleanup } = tempStore()
  // Each request costs $0.40 against a $1.00 daily cap.
  const buyer = await fakeBuyer({ costUsdc: 400_000 })
  const limited = store.createKey({ label: 'Friend', identityId: DEFAULT_IDENTITY_ID, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
  const unlimited = store.createKey({ label: 'Owner', identityId: DEFAULT_IDENTITY_ID, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port, 300_000)
  const send = (key: string) => request(gateway.port, '/v1/chat/completions', { method: 'POST', key, body: '{"model":"deepseek-v4-flash"}' })
  try {
    assert.equal((await send(limited.secret)).status, 200)
    await gateway.feed.pollOnce()
    assert.equal((await send(limited.secret)).status, 200)
    await gateway.feed.pollOnce()
    // $0.80 settled; the next request is admitted (0.80 < 1.00) and overshoots by one request.
    assert.equal((await send(limited.secret)).status, 200)
    await gateway.feed.pollOnce()
    const blocked = await send(limited.secret)
    assert.equal(blocked.status, 402)
    const error = JSON.parse(blocked.body).error
    assert.equal(error.code, 'spend_limit_reached')
    assert.equal(error.limit.period, 'daily')
    assert.equal(error.limit.spent_usd, '1.200000')

    // Spend is attributed per key: the other key on the same buyer is unaffected.
    assert.equal((await send(unlimited.secret)).status, 200)
    await gateway.feed.pollOnce()
    assert.equal(store.periodSpend(limited.key.id).total, 1_200_000)
    assert.equal(store.periodSpend(unlimited.key.id).total, 400_000)

    const info = await request(gateway.port, '/v1/key', { key: limited.secret })
    assert.equal(info.status, 200)
    const data = JSON.parse(info.body).data
    assert.equal(data.id, limited.key.id)
    // The rejected request never reached the buyer and is not logged.
    assert.equal(data.usage.requests, 3)
    assert.equal(data.usage.spent_usd, '1.200000')
    assert.equal(data.limits.daily.limit_usd, '1.000000')
    assert.equal(data.limits.daily.remaining_usd, '0.000000')
    assert.equal(data.limits.total.limit_usd, null)

    const stats = store.usageStats(limited.key.id)
    assert.equal(stats.failedRequests, 0)
    assert.equal(stats.inputTokens, 300)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('gateway holds block concurrent requests from slipping under a cap', () => {
  const { store, cleanup } = tempStore()
  const accounting = new GatewayAccounting(store, { holdUsdc: 300_000, settleGraceMs: 10 })
  try {
    const { key } = store.createKey({ label: 'Burst', identityId: DEFAULT_IDENTITY_ID, limits: { daily: 500_000, monthly: null, total: null }, expiresAt: null })
    assert.equal(accounting.admit(key).ok, true)
    assert.equal(accounting.admit(key).ok, true)
    const third = accounting.admit(key)
    assert.equal(third.ok, false)
    assert.equal(accounting.heldUsdc(key.id), 600_000)
  } finally {
    accounting.dispose()
    cleanup()
  }
})

test('free routes neither reserve holds nor count against caps', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const { key, secret } = store.createKey({ label: 'Poller', identityId: DEFAULT_IDENTITY_ID, limits: { daily: 400_000, monthly: null, total: null }, expiresAt: null })
  const gateway = await startGateway(store, buyer.port, 300_000)
  try {
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await request(gateway.port, '/v1/models', { key: secret })).status, 200)
    }
    assert.equal(gateway.accounting.heldUsdc(key.id), 0)
    assert.equal((await request(gateway.port, '/v1/responses', { method: 'POST', key: secret, body: '{}' })).status, 200)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('gateway fails closed for capped keys when the buyer does not report spend', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer({ spendFeed: false })
  const capped = store.createKey({ label: 'Capped', identityId: DEFAULT_IDENTITY_ID, limits: { daily: null, monthly: 5_000_000, total: null }, expiresAt: null })
  const open = store.createKey({ label: 'Open', identityId: DEFAULT_IDENTITY_ID, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    const response = await request(gateway.port, '/v1/responses', { method: 'POST', key: capped.secret, body: '{}' })
    assert.equal(response.status, 503)
    assert.equal(JSON.parse(response.body).error.code, 'spend_tracking_unavailable')
    assert.equal((await request(gateway.port, '/v1/responses', { method: 'POST', key: open.secret, body: '{}' })).status, 200)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('generated keys are long random antseed secrets', () => {
  const first = generateApiKey()
  const second = generateApiKey()
  assert.match(first.secret, /^antseed_[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first.secret, second.secret)
  assert.notEqual(first.hash, first.secret)
  assert.ok(first.hint.startsWith('antseed_') && first.hint.includes('…'))
})
