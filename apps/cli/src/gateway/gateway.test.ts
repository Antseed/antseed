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
import { GatewayServer, type GatewayTopupOptions } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { BUYER_IDENTITY_HEADER } from '../proxy/request-utils.js'
import { GatewayStore } from './store.js'
import { liveBuyerIdentityAddress } from './runtime.js'
import { Wallet } from 'ethers'
import { randomBytes } from 'node:crypto'
import {
  X402Facilitator,
  decodeHeaderJson,
  encodeHeaderJson,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
  type X402Asset,
} from './x402.js'

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
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

/**
 * Stand-in for `antseed buyer start`: answers API routes, records the tag the
 * gateway attaches, and serves the attributed-spend feed for tagged requests.
 */
async function fakeBuyer(options: { costUsdc?: number; spendFeed?: boolean; reportIdentity?: string } = {}) {
  const feed = new SpendAttributionFeed()
  const captured: Array<{ url: string; auth?: string; source?: string; tag?: string; identity?: string }> = []
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
      const identity = req.headers[BUYER_IDENTITY_HEADER] as string | undefined
      captured.push({
        identity,
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
          buyerIdentity: options.reportIdentity ?? identity ?? DEFAULT_BUYER_IDENTITY,
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
  return { port, captured, close: () => new Promise<void>((resolve) => server.close(() => { feed.close(); resolve() })) }
}

async function startGateway(store: GatewayStore, buyerPort: number, holdUsdc = 300_000, topup: GatewayTopupOptions | null = null) {
  const accounting = new GatewayAccounting(store, { holdUsdc, settleGraceMs: 50 })
  const feed = new SpendFeedPoller({
    buyerPort,
    onPage: (page) => { accounting.ingest(page.bootId, page.events) },
    intervalMs: 60_000,
  })
  const logs: string[] = []
  const server = new GatewayServer({
    store,
    accounting,
    buyerPort,
    topup,
    identityAddress: async (name) => (name === 'team-a' ? '0x00000000000000000000000000000000000000aa' : null),
    spendFeedState: () => feed.state,
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
    const { key, secret } = store.createKey({ label: 'Alice', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
    assert.equal(store.findKeyBySecret(secret)?.id, key.id)
    assert.equal(store.findKeyBySecret(`${secret}x`), null)
    assert.ok(!JSON.stringify(store.listKeys()).includes(secret))

    const envKey = store.syncEnvironmentKey('antseed_legacy_tunnel_key_1')
    assert.equal(envKey.source, 'tunnel-env')
    assert.equal(store.syncEnvironmentKey('antseed_rotated_tunnel_key_2').id, envKey.id)
    assert.equal(store.findKeyBySecret('antseed_legacy_tunnel_key_1'), null)
    assert.equal(store.findKeyBySecret('antseed_rotated_tunnel_key_2')?.id, envKey.id)
    assert.equal(store.retireEnvironmentKey()?.status, 'revoked')
    assert.equal(store.retireEnvironmentKey(), null)
    assert.equal(store.getKey(key.id)?.status, 'active')
    assert.equal(store.syncEnvironmentKey('antseed_rotated_tunnel_key_2').status, 'active')

    const entry = {
      kind: 'spend' as const,
      keyId: key.id,
      buyerIdentity: DEFAULT_BUYER_IDENTITY,
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

test('gateway pays with the key\'s buyer identity and ignores the client\'s choice', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer({ costUsdc: 100_000 })
  const team = store.createKey({ label: 'Team', buyerIdentity: 'team-a', limits: { daily: 5_000_000, monthly: null, total: null }, expiresAt: null })
  const owner = store.createKey({ label: 'Owner', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    const spoof = { [BUYER_IDENTITY_HEADER]: 'someone-else' }
    assert.equal((await request(gateway.port, '/v1/responses', { method: 'POST', key: team.secret, body: '{}', headers: spoof })).status, 200)
    assert.equal((await request(gateway.port, '/v1/responses', { method: 'POST', key: owner.secret, body: '{}', headers: spoof })).status, 200)
    assert.deepEqual(buyer.captured.map((entry) => entry.identity), ['team-a', undefined])

    await gateway.feed.pollOnce()
    assert.equal(store.periodSpend(team.key.id).total, 100_000)
    assert.equal(store.periodSpend(owner.key.id).total, 100_000)

    const info = JSON.parse((await request(gateway.port, '/v1/key', { key: team.secret })).body).data
    assert.equal(info.buyer_address, '0x00000000000000000000000000000000000000aa')
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('spend signed by a different identity than the key\'s is not booked to the key', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer({ costUsdc: 100_000, reportIdentity: 'other' })
  const team = store.createKey({ label: 'Team', buyerIdentity: 'team-a', limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    assert.equal((await request(gateway.port, '/v1/responses', { method: 'POST', key: team.secret, body: '{}' })).status, 200)
    await gateway.feed.pollOnce()
    assert.equal(store.periodSpend(team.key.id).total, 0)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('spend attribution feed reports only tagged requests and pages by cursor', (context) => {
  const feed = new SpendAttributionFeed(() => 1000)
  context.after(() => feed.close())
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

test('spend signed without a request id goes to the latest tag on that seller', (context) => {
  const feed = new SpendAttributionFeed()
  context.after(() => feed.close())
  feed.track('req-1', 'gw_a')
  const spend = { sellerPeerId: 's', amountUsdc: '10', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0' }
  feed.record({ ...spend, requestId: null })
  feed.record({ ...spend, requestId: 'req-1' })
  feed.record({ ...spend, requestId: null, amountUsdc: '7' })
  feed.record({ ...spend, requestId: null, sellerPeerId: 'other' })
  assert.deepEqual(feed.page(0).events.map((event) => [event.tag, event.amountUsdc]), [['gw_a', '10'], ['gw_a', '7']])
})

test('spend without a request id is not guessed when several tags share the identity and seller', (context) => {
  let now = 0
  const feed = new SpendAttributionFeed(() => now)
  context.after(() => feed.close())
  feed.track('req-a', 'gw_a')
  feed.track('req-b', 'gw_b')
  const spend = { sellerPeerId: 's', amountUsdc: '10', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0' }
  feed.record({ ...spend, requestId: 'req-a' })
  feed.record({ ...spend, requestId: 'req-b' })
  feed.record({ ...spend, requestId: null, amountUsdc: '7' })
  assert.deepEqual(feed.page(0).events.map((event) => event.tag), ['gw_a', 'gw_b'])
  now = 6 * 60 * 1000
  feed.record({ ...spend, requestId: 'req-b' })
  feed.record({ ...spend, requestId: null, amountUsdc: '3' })
  assert.deepEqual(feed.page(0).events.map((event) => [event.tag, event.amountUsdc]).slice(2), [['gw_b', '10'], ['gw_b', '3']])
})

test('late spend keeps its tag after more than 2048 newer requests', (context) => {
  const feed = new SpendAttributionFeed()
  context.after(() => feed.close())
  feed.track('long-running', 'gw_original')
  for (let index = 0; index < 4096; index++) feed.track(`request-${index}`, `gw_${index}`)
  const spend = { requestId: 'long-running', sellerPeerId: 'seller', amountUsdc: '10', inputTokens: '1', cachedInputTokens: '0', outputTokens: '1', outputImages: '0' }
  feed.record(spend)
  feed.record(spend)
  assert.deepEqual(feed.page(0).events.map((event) => event.tag), ['gw_original', 'gw_original'])
})

test('request tags are dropped an hour after they were tracked', (context) => {
  let now = 0
  const feed = new SpendAttributionFeed(() => now)
  context.after(() => feed.close())
  feed.track('old', 'gw_old')
  now = 59 * 60 * 1000
  feed.track('recent', 'gw_recent')
  now = 61 * 60 * 1000
  feed.track('new', 'gw_new')
  const spend = { sellerPeerId: 's', amountUsdc: '1', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0' }
  feed.record({ ...spend, requestId: 'old', sellerPeerId: 'a' })
  feed.record({ ...spend, requestId: 'recent' })
  assert.deepEqual(feed.page(0).events.map((event) => event.tag), ['gw_recent'])
})

test('gateway wallet lookup follows the live buyer until it reloads an identity', async () => {
  let address = 'original-wallet'
  let status = 200
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/_antseed/buyer-identities')
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ identities: [{ name: 'customer', address }] }))
  })
  const port = await listen(server)
  try {
    assert.equal(await liveBuyerIdentityAddress(port, 'customer'), 'original-wallet')
    assert.equal(await liveBuyerIdentityAddress(port, 'missing'), null)
    address = 'recreated-wallet'
    assert.equal(await liveBuyerIdentityAddress(port, 'customer'), 'recreated-wallet')
    status = 503
    assert.equal(await liveBuyerIdentityAddress(port, 'customer'), null)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await assert.rejects(liveBuyerIdentityAddress(port, 'customer'))
})

test('gateway exposes only authenticated supported API routes', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const { secret } = store.createKey({ label: 'Cursor', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
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
  const revoked = store.createKey({ label: 'Old', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const expired = store.createKey({ label: 'Trial', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: Date.now() - 1 })
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

test('gateway answers 413 to oversized bodies without forwarding them', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const { secret } = store.createKey({ label: 'Big', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    const response = await request(gateway.port, '/v1/chat/completions', { method: 'POST', key: secret, body: 'x'.repeat(64 * 1024 * 1024 + 1) })
    assert.equal(response.status, 413)
    assert.equal(JSON.parse(response.body).error.code, 'request_too_large')
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
  const limited = store.createKey({ label: 'Friend', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
  const unlimited = store.createKey({ label: 'Owner', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
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
    const { key } = store.createKey({ label: 'Burst', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 500_000, monthly: null, total: null }, expiresAt: null })
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

test('a finished request keeps its remaining hold after its first spend delta', () => {
  const { store, cleanup } = tempStore()
  const accounting = new GatewayAccounting(store, { holdUsdc: 300_000, settleGraceMs: 60_000 })
  try {
    const { key } = store.createKey({ label: 'Stream', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
    const admission = accounting.admit(key)
    assert.ok(admission.ok)
    store.startRequest({ tag: admission.tag, keyId: key.id, buyerIdentity: DEFAULT_BUYER_IDENTITY, method: 'POST', path: '/v1/chat/completions', model: null, startedAt: 0 })
    accounting.finish(admission.tag)
    const event = { seq: 1, tag: admission.tag, requestId: 'r', buyerIdentity: DEFAULT_BUYER_IDENTITY, sellerPeerId: 's', amountUsdc: '100000', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0', at: 0 }
    accounting.ingest('boot', [event])
    assert.equal(accounting.heldUsdc(key.id), 200_000, 'later deltas of the same request stay covered')
  } finally {
    accounting.dispose()
    cleanup()
  }
})

test('free routes neither reserve holds nor count against caps', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const { key, secret } = store.createKey({ label: 'Poller', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 400_000, monthly: null, total: null }, expiresAt: null })
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
  const capped = store.createKey({ label: 'Capped', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: null, monthly: 5_000_000, total: null }, expiresAt: null })
  const open = store.createKey({ label: 'Open', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
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

const TEAM_WALLET = '0x00000000000000000000000000000000000000aa'
const USDC: X402Asset = {
  network: 'eip155:8453',
  chainId: 8453,
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  name: 'USD Coin',
  version: '2',
}

/** Facilitator stand-in: accepts each EIP-3009 nonce once, like the USDC contract. */
async function fakeFacilitator() {
  const calls: string[] = []
  const used = new Set<string>()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const { paymentPayload } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { paymentPayload: PaymentPayload }
      const { nonce, from } = paymentPayload.payload.authorization
      calls.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/verify') {
        res.end(JSON.stringify(used.has(nonce) ? { isValid: false, invalidReason: 'invalid_transaction_state', payer: from } : { isValid: true, payer: from }))
        return
      }
      used.add(nonce)
      res.end(JSON.stringify({ success: true, transaction: '0xabc', network: USDC.network, payer: from }))
    })
  })
  const port = await listen(server)
  return {
    calls,
    topup: (): GatewayTopupOptions => ({
      asset: async () => USDC,
      facilitator: new X402Facilitator({ url: `http://127.0.0.1:${port}` }),
      minUsdc: 1_000_000,
      maxUsdc: 100_000_000,
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function signPayment(payer: Pick<Wallet, 'address' | 'signTypedData'>, required: PaymentRequired, overrides: Partial<{ value: string; to: string }> = {}): Promise<string> {
  const accepted = required.accepts[0]!
  const now = Math.floor(Date.now() / 1000)
  const authorization = {
    from: payer.address,
    to: overrides.to ?? accepted.payTo,
    value: overrides.value ?? accepted.amount,
    validAfter: String(now - 5),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const signature = await payer.signTypedData(
    { name: USDC.name, version: USDC.version, chainId: USDC.chainId, verifyingContract: USDC.address },
    {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    authorization,
  )
  const payment: PaymentPayload = { x402Version: 2, resource: required.resource, accepted, payload: { signature, authorization } }
  return encodeHeaderJson(payment)
}

test('x402 top-up: 402 names the key wallet, a signed payment is settled and credited once', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const facilitator = await fakeFacilitator()
  const team = store.createKey({ label: 'Team', buyerIdentity: 'team-a', limits: NO_LIMITS, expiresAt: null, topupEnabled: true })
  const gateway = await startGateway(store, buyer.port, 300_000, facilitator.topup())
  const topup = (headers: http.OutgoingHttpHeaders = {}) =>
    request(gateway.port, '/v1/key/topup', { method: 'POST', key: team.secret, body: '{"amount_usd":"5"}', headers })
  try {
    const challenge = await topup()
    assert.equal(challenge.status, 402)
    const required = decodeHeaderJson<PaymentRequired>(challenge.headers['payment-required'] as string)!
    assert.equal(required.x402Version, 2)
    assert.equal(required.accepts[0]!.payTo.toLowerCase(), TEAM_WALLET)
    assert.equal(required.accepts[0]!.amount, '5000000')
    assert.equal(required.accepts[0]!.network, 'eip155:8453')

    const payer = Wallet.createRandom()
    const signature = await signPayment(payer, required)
    const paid = await topup({ 'payment-signature': signature })
    assert.equal(paid.status, 200)
    assert.equal(JSON.parse(paid.body).data.topped_up_usd, '5.000000')
    const settlement = decodeHeaderJson<SettlementResponse>(paid.headers['payment-response'] as string)!
    assert.equal(settlement.success, true)
    assert.equal(settlement.payer, payer.address)
    assert.deepEqual(facilitator.calls, ['/verify', '/settle'])
    assert.equal(store.usageStats(team.key.id).creditedUsdc, 5_000_000)

    // Replaying the same authorization fails on-chain and is not credited twice.
    const replay = await topup({ 'payment-signature': signature })
    assert.equal(replay.status, 402)
    assert.equal(store.usageStats(team.key.id).creditedUsdc, 5_000_000)

    const info = JSON.parse((await request(gateway.port, '/v1/key', { key: team.secret })).body).data
    assert.equal(info.usage.topped_up_usd, '5.000000')
    assert.equal(buyer.captured.length, 0, 'top-ups never reach the buyer')
  } finally {
    await gateway.stop()
    await buyer.close()
    await facilitator.close()
    cleanup()
  }
})

test('x402 top-up rejects payments that do not match before asking the facilitator', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const facilitator = await fakeFacilitator()
  const team = store.createKey({ label: 'Team', buyerIdentity: 'team-a', limits: NO_LIMITS, expiresAt: null, topupEnabled: true })
  const gateway = await startGateway(store, buyer.port, 300_000, facilitator.topup())
  const topup = (headers: http.OutgoingHttpHeaders = {}, body = '{"amount_usd":"5"}') =>
    request(gateway.port, '/v1/key/topup', { method: 'POST', key: team.secret, body, headers })
  try {
    const required = decodeHeaderJson<PaymentRequired>((await topup()).headers['payment-required'] as string)!
    const payer = Wallet.createRandom()
    const reasonFor = async (signature: string) =>
      decodeHeaderJson<PaymentRequired>((await topup({ 'payment-signature': signature })).headers['payment-required'] as string)!.error

    assert.equal(await reasonFor(await signPayment(payer, required, { value: '1000000' })), 'invalid_exact_evm_payload_authorization_value_mismatch')
    assert.equal(await reasonFor(await signPayment(payer, required, { to: Wallet.createRandom().address })), 'invalid_exact_evm_payload_recipient_mismatch')
    const forged = decodeHeaderJson<PaymentPayload>(await signPayment(payer, required))!
    forged.payload.authorization.from = Wallet.createRandom().address
    assert.equal(await reasonFor(encodeHeaderJson(forged)), 'invalid_exact_evm_payload_signature')
    assert.deepEqual(facilitator.calls, [])

    assert.equal((await topup({}, '{"amount_usd":"0.5"}')).status, 400)
    assert.equal(store.usageStats(team.key.id).creditedUsdc, 0)
  } finally {
    await gateway.stop()
    await buyer.close()
    await facilitator.close()
    cleanup()
  }
})

test('x402 top-up still answers 200 when the settled payment cannot be booked', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const facilitator = await fakeFacilitator()
  const team = store.createKey({ label: 'Team', buyerIdentity: 'team-a', limits: NO_LIMITS, expiresAt: null, topupEnabled: true })
  const gateway = await startGateway(store, buyer.port, 300_000, facilitator.topup())
  const topup = (headers: http.OutgoingHttpHeaders = {}) =>
    request(gateway.port, '/v1/key/topup', { method: 'POST', key: team.secret, body: '{"amount_usd":"5"}', headers })
  try {
    const required = decodeHeaderJson<PaymentRequired>((await topup()).headers['payment-required'] as string)!
    store.recordLedgerEntry = () => { throw new Error('disk full') }
    const paid = await topup({ 'payment-signature': await signPayment(Wallet.createRandom(), required) })
    assert.equal(paid.status, 200)
    assert.equal(decodeHeaderJson<SettlementResponse>(paid.headers['payment-response'] as string)!.success, true)
    assert.ok(gateway.logs.some((line) => line.includes('NOT recorded in the ledger')))
  } finally {
    await gateway.stop()
    await buyer.close()
    await facilitator.close()
    cleanup()
  }
})

test('x402 top-up is unavailable without a facilitator, for keys on the operator wallet, or when the owner has not allowed it', async () => {
  const { store, cleanup } = tempStore()
  const buyer = await fakeBuyer()
  const facilitator = await fakeFacilitator()
  const owner = store.createKey({ label: 'Owner', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null, topupEnabled: true })
  const team = store.createKey({ label: 'Team', buyerIdentity: 'team-a', limits: NO_LIMITS, expiresAt: null, topupEnabled: true })
  const notAllowed = store.createKey({ label: 'Friend', buyerIdentity: 'team-a', limits: NO_LIMITS, expiresAt: null })
  const withTopup = await startGateway(store, buyer.port, 300_000, facilitator.topup())
  const withoutTopup = await startGateway(store, buyer.port)
  try {
    const ownerResponse = await request(withTopup.port, '/v1/key/topup', { method: 'POST', key: owner.secret, body: '{"amount_usd":"5"}' })
    assert.equal(ownerResponse.status, 403)
    assert.equal(JSON.parse(ownerResponse.body).error.code, 'topup_not_available')
    const disabled = await request(withoutTopup.port, '/v1/key/topup', { method: 'POST', key: team.secret, body: '{"amount_usd":"5"}' })
    assert.equal(disabled.status, 501)
    const blocked = await request(withTopup.port, '/v1/key/topup', { method: 'POST', key: notAllowed.secret, body: '{"amount_usd":"5"}' })
    assert.equal(blocked.status, 403)
    assert.equal(JSON.parse(blocked.body).error.code, 'topup_not_allowed')
    assert.equal(JSON.parse((await request(withTopup.port, '/v1/key', { key: notAllowed.secret })).body).data.topup_enabled, false)
    assert.equal(JSON.parse((await request(withTopup.port, '/v1/key', { key: team.secret })).body).data.topup_enabled, true)

    store.setTopupEnabled(notAllowed.key.id, true)
    const allowed = await request(withTopup.port, '/v1/key/topup', { method: 'POST', key: notAllowed.secret, body: '{"amount_usd":"5"}' })
    assert.equal(allowed.status, 402, 'enabling takes effect without a restart')
  } finally {
    await withTopup.stop()
    await withoutTopup.stop()
    await buyer.close()
    await facilitator.close()
    cleanup()
  }
})
