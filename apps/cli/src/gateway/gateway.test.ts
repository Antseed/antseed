import assert from 'node:assert/strict'
import * as http from 'node:http'
import { test } from 'node:test'
import { SPEND_ATTRIBUTION_HEADER, SpendAttributionFeed } from '../proxy/spend-attribution.js'
import { GatewayAccounting, videoJobKey } from './accounting.js'
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
import { tempDataDir } from './console-api/test-support.js'
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

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

/** Resolves once `check` holds; fails after `timeoutMs`. */
async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
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
      res.on('error', reject)
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
  const captured: Array<{ url: string; auth?: string; source?: string; tag?: string; identity?: string; headers: http.IncomingHttpHeaders }> = []
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
        headers: req.headers,
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
      if (req.url?.endsWith('/video/retrieve')) {
        // A finished video: the MP4 streams back, with no usage in it.
        res.writeHead(200, { 'content-type': 'video/mp4', 'x-antseed-request-id': requestId, 'x-antseed-peer-id': 'seller' })
        res.end(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), randomBytes(4096)]))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-antseed-request-id': requestId })
      res.end(JSON.stringify(req.url?.endsWith('/video/queue') ? { queue_id: 'job-1' } : { ok: true }))
    })
  })
  const port = await listen(server)
  return { port, captured, close: () => new Promise<void>((resolve) => server.close(() => { feed.close(); resolve() })) }
}

async function startGateway(store: GatewayStore, buyerPort: number, holdUsdc = 300_000, topup: GatewayTopupOptions | null = null, settleGraceMs = 50) {
  const accounting = new GatewayAccounting(store, { holdUsdc, settleGraceMs })
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
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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

test('gateway passes native video jobs to the buyer and books their spend to the key', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await fakeBuyer({ costUsdc: 250_000 })
  const { key, secret } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    for (const base of ['/api/v1/video', '/fal/v1/video']) {
      const queued = await request(gateway.port, `${base}/queue`, { method: 'POST', key: secret, body: '{"model":"seedance","prompt":"An ant"}' })
      assert.equal(queued.status, 200)
      assert.equal(JSON.parse(queued.body).queue_id, 'job-1')
      const video = await request(gateway.port, `${base}/retrieve`, { method: 'POST', key: secret, body: base.startsWith('/fal') ? '{"model":"seedance","request_id":"job-1"}' : '{"model":"seedance","queue_id":"job-1"}' })
      assert.equal(video.status, 200)
      assert.ok(video.body.includes('ftypisom'), 'the MP4 streams through')
    }
    assert.equal((await request(gateway.port, '/v1/videos', { method: 'POST', key: secret, body: '{}' })).status, 404)
    assert.deepEqual(buyer.captured.map(({ url }) => url), ['/api/v1/video/queue', '/api/v1/video/retrieve', '/fal/v1/video/queue', '/fal/v1/video/retrieve'])
    await gateway.feed.pollOnce()
    assert.equal(store.periodSpend(key.id).total, 1_000_000)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

/**
 * Buyer for one video job, as a seller bills it: the create and a status poll
 * cost nothing (and carry zero token prices: video is priced per second), the
 * retrieve that streams the file is charged.
 */
async function videoJobBuyer(costUsdc: number) {
  const feed = new SpendAttributionFeed()
  let polls = 0
  let requestCounter = 0
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/_antseed/attributed-spend')) {
      const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...feed.page(after) }))
      return
    }
    req.resume()
    req.on('end', () => {
      const requestId = `req-${++requestCounter}`
      const tag = req.headers[SPEND_ATTRIBUTION_HEADER] as string
      feed.track(requestId, tag)
      const headers = {
        'x-antseed-request-id': requestId, 'x-antseed-peer-id': 'seller',
        'x-antseed-input-usd-per-million': '0', 'x-antseed-output-usd-per-million': '0',
      }
      if (req.url?.endsWith('/queue')) {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: 'seedance', queue_id: 'job-7', status: 'IN_QUEUE' }))
      } else if (++polls === 1) {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'PROCESSING' }))
      } else {
        if (costUsdc > 0) feed.record({ requestId, buyerIdentity: DEFAULT_BUYER_IDENTITY, sellerPeerId: 'seller', amountUsdc: String(costUsdc), inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0' })
        res.writeHead(200, { ...headers, 'content-type': 'video/mp4' })
        res.end(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), randomBytes(1024)]))
      }
    })
  })
  const port = await listen(server)
  return { port, close: () => new Promise<void>((resolve) => server.close(() => { feed.close(); resolve() })) }
}

test('a video job is charged on its delivery: the create shows that charge and neither it nor a status poll is pending or free', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await videoJobBuyer(330_000)
  const { key, secret } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    const retrieve = '{"model":"seedance","queue_id":"job-7"}'
    assert.equal((await request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: secret, body: '{"model":"seedance","prompt":"An ant"}' })).status, 200)
    const byAction = () => Object.fromEntries(store.listRequests({ keyIds: null, keyId: key.id }).map((row) => [row.video!.action, row]))
    assert.deepEqual(byAction()['create']!.video, { action: 'create', jobId: 'job-7', chargedUsdc: null })
    assert.equal((await request(gateway.port, '/api/v1/video/retrieve', { method: 'POST', key: secret, body: retrieve })).status, 200)
    assert.equal((await request(gateway.port, '/api/v1/video/retrieve', { method: 'POST', key: secret, body: retrieve })).status, 200)
    await gateway.feed.pollOnce()

    const rows = byAction()
    assert.deepEqual(Object.keys(rows).sort(), ['create', 'delivery', 'poll'])
    assert.deepEqual(
      [rows['create']!.spentUsdc, rows['create']!.video!.chargedUsdc, rows['create']!.servedFree, rows['create']!.costPending],
      [null, 330_000, false, false],
    )
    assert.deepEqual([rows['poll']!.spentUsdc, rows['poll']!.servedFree, rows['poll']!.costPending], [null, false, false])
    assert.deepEqual([rows['delivery']!.spentUsdc, rows['delivery']!.video!.jobId, rows['delivery']!.costPending], [330_000, 'job-7', false])
    assert.equal(store.periodSpend(key.id).total, 330_000, 'the job is counted once')
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('a video create tells the buyer what is left of the key caps; other requests and uncapped keys do not', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await fakeBuyer()
  const capped = store.createKey({ label: 'Capped', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 2_000_000, monthly: 1_500_000, total: null }, expiresAt: null })
  const open = store.createKey({ label: 'Open', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    const create = '{"model":"seedance","prompt":"An ant","duration":"5s"}'
    assert.equal((await request(gateway.port, '/v1/chat/completions', { method: 'POST', key: capped.secret, body: '{"model":"m"}' })).status, 200)
    await waitFor(() => gateway.accounting.heldUsdc(capped.key.id) === 0, 2_000)
    assert.equal((await request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: capped.secret, body: create })).status, 200)
    assert.equal((await request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: open.secret, body: create })).status, 200)
    // A client cannot raise its own cap.
    assert.equal((await request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: open.secret, body: create, headers: { 'x-antseed-max-video-usdc': '99000000' } })).status, 200)
    assert.deepEqual(buyer.captured.map(({ headers }) => headers['x-antseed-max-video-usdc'] ?? null), [null, '1500000', null, null])
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('video creates, polls and deliveries hold no request hold once answered; a job the buyer does not price holds its whole allowance', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await videoJobBuyer(0)
  const { key, secret } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
  const gateway = await startGateway(store, buyer.port, 300_000, null, 60_000)
  const job = videoJobKey('venice-video', 'job-7')
  try {
    assert.equal((await request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: secret, body: '{"model":"seedance","prompt":"An ant"}' })).status, 200)
    // No price from the buyer: the $1 the create was allowed stays held for the job.
    await waitFor(() => gateway.accounting.heldUsdc(key.id) === 1_000_000)
    // The job's own poll and delivery are admitted although its price fills the cap, and leave no request hold.
    assert.equal((await request(gateway.port, '/api/v1/video/retrieve', { method: 'POST', key: secret, body: '{"model":"seedance","queue_id":"job-7"}' })).status, 200)
    await waitFor(() => gateway.accounting.heldUsdc(key.id, job) === 0)
    assert.equal((await request(gateway.port, '/api/v1/video/retrieve', { method: 'POST', key: secret, body: '{"model":"seedance","queue_id":"job-7"}' })).status, 200)
    await waitFor(() => store.listRequests({ keyIds: null, keyId: key.id }).some((row) => row.video?.action === 'delivery'))
    // Until the delivery's charge arrives (none does here) the job itself still holds its price.
    await waitFor(() => gateway.accounting.heldUsdc(key.id, job) === 0)
    assert.equal(gateway.accounting.heldUsdc(key.id), 1_000_000)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

/**
 * Buyer that prices every video at `priceUsdc` and refuses one above the cap
 * the gateway sends, as the real buyer does. A create names its job with the
 * body's `job` and answers after `createDelayMs`; a retrieve for a job ending
 * in `-fail` reports a failed job, one ending in `-done` delivers the file, one
 * ending in `-cut` breaks off mid-file, one ending in `-gone` is unknown to the
 * buyer, one ending in `-bad` is refused as a malformed request, any other is
 * still processing.
 */
async function pricedVideoBuyer(priceUsdc: number, createDelayMs = 0, priceHeader: string | string[] = String(priceUsdc)) {
  const caps: Array<string | null> = []
  const feed = new SpendAttributionFeed()
  const retired = { 'x-antseed-video-job-retired': '1' }
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/_antseed/attributed-spend')) {
      const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...feed.page(after) }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { job?: string; queue_id?: string }
      const headers = { 'x-antseed-request-id': `req-${randomBytes(4).toString('hex')}`, 'x-antseed-peer-id': 'seller' }
      if (req.url?.endsWith('/queue')) {
        const cap = (req.headers['x-antseed-max-video-usdc'] as string | undefined) ?? null
        caps.push(cap)
        if (cap !== null && priceUsdc > Number(cap)) {
          res.writeHead(422, { ...headers, 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'buyer-budget-too-low', message: 'Video costs more than the spend limit has left' } }))
          return
        }
        setTimeout(() => {
          res.writeHead(200, { ...headers, 'content-type': 'application/json', 'x-antseed-video-price-usdc': priceHeader })
          res.end(JSON.stringify({ queue_id: body.job }))
        }, createDelayMs)
        return
      }
      if (body.queue_id?.endsWith('-gone') || body.queue_id?.endsWith('-bad')) {
        const gone = body.queue_id.endsWith('-gone')
        res.writeHead(gone ? 404 : 400, { ...headers, 'content-type': 'application/json', ...(gone ? retired : {}) })
        res.end(JSON.stringify({ error: gone ? { code: 'video_route_not_found', message: 'Unknown video job' } : { code: 'invalid_required_parameters', message: 'Malformed' } }))
        return
      }
      if (body.queue_id?.endsWith('-cut')) {
        res.writeHead(200, { ...headers, 'content-type': 'video/mp4' })
        res.write(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]))
        setTimeout(() => res.destroy(), 20)
        return
      }
      if (body.queue_id?.endsWith('-done')) {
        // The buyer charges the delivery; its spend reaches the gateway through the feed.
        feed.track(headers['x-antseed-request-id'], req.headers[SPEND_ATTRIBUTION_HEADER] as string)
        feed.record({ requestId: headers['x-antseed-request-id'], buyerIdentity: DEFAULT_BUYER_IDENTITY, sellerPeerId: 'seller', amountUsdc: String(priceUsdc), inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0' })
        res.writeHead(200, { ...headers, 'content-type': 'video/mp4' })
        res.end(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), randomBytes(64)]))
        return
      }
      const failed = body.queue_id?.endsWith('-fail') === true
      res.writeHead(200, { ...headers, 'content-type': 'application/json', ...(failed ? retired : {}) })
      res.end(JSON.stringify({ status: failed ? 'failed' : 'processing' }))
    })
  })
  const port = await listen(server)
  return { port, caps, close: () => new Promise<void>((resolve) => server.close(() => { feed.close(); resolve() })) }
}

async function videoGateway(priceUsdc: number, dailyCap: number, createDelayMs = 0, priceHeader?: string | string[]) {
  const { store, cleanup } = tempDataDir()
  const buyer = await pricedVideoBuyer(priceUsdc, createDelayMs, priceHeader)
  const { key, secret } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: dailyCap, monthly: null, total: null }, expiresAt: null })
  const other = store.createKey({ label: 'Other', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port, 100_000, null, 60_000)
  return {
    store, key, buyer, gateway,
    create: (job: string) => request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: secret, body: JSON.stringify({ model: 'seedance', prompt: 'An ant', duration: '8s', job }) }),
    poll: (job: string, as: string = secret) => request(gateway.port, '/api/v1/video/retrieve', { method: 'POST', key: as, body: JSON.stringify({ model: 'seedance', queue_id: job }) }),
    otherSecret: other.secret,
    close: async () => {
      await gateway.stop()
      await buyer.close()
      cleanup()
    },
  }
}

test('an accepted video stays counted against the caps, so two videos cannot share the same room', async () => {
  const video = await videoGateway(600_000, 1_000_000)
  const held = () => video.gateway.accounting.heldUsdc(video.key.id)
  try {
    assert.equal((await video.create('job-1')).status, 200)
    await waitFor(() => held() === 600_000)
    // Only $0.40 is left once the first job is counted: the buyer refuses a second $0.60 video before it starts.
    assert.equal((await video.create('job-2')).status, 422)
    assert.deepEqual(video.buyer.caps, ['1000000', '400000'])
    await waitFor(() => held() === 600_000)
    // The job's own polls are admitted without counting its price twice, and hold nothing.
    const own = video.gateway.accounting.admit(video.key, undefined, { videoJob: videoJobKey('venice-video', 'job-1') })
    assert.ok(own.ok)
    assert.equal(video.gateway.accounting.heldUsdc(video.key.id), 600_000)
    video.gateway.accounting.release(own.tag)
    assert.equal((await video.poll('job-1')).status, 200)
    await waitFor(() => held() === 600_000)
  } finally {
    await video.close()
  }
})

test('video creates in flight at once cannot both be told the same room', async () => {
  const video = await videoGateway(600_000, 1_000_000, 100)
  try {
    // The first create holds the whole $1 it may spend until its price is known, so the second is refused at once.
    const [first, second] = await Promise.all([video.create('job-1'), new Promise((resolve) => setTimeout(resolve, 20)).then(() => video.create('job-2'))])
    assert.deepEqual([first.status, second.status], [200, 402])
    assert.deepEqual(video.buyer.caps, ['1000000'])
    // Once priced, only the job's $0.60 stays committed.
    await waitFor(() => video.gateway.accounting.heldUsdc(video.key.id) === 600_000)
  } finally {
    await video.close()
  }
})

test('a malformed poll keeps the job committed; a job the buyer does not know stops counting', async () => {
  const video = await videoGateway(600_000, 1_000_000)
  const held = () => video.gateway.accounting.heldUsdc(video.key.id)
  try {
    assert.equal((await video.create('job-bad')).status, 200)
    await waitFor(() => held() === 600_000)
    assert.equal((await video.poll('job-bad')).status, 400)
    await waitFor(() => held() === 600_000)
    // The job is still worth $0.60: a second $0.60 video is refused.
    assert.equal((await video.create('job-2')).status, 422)
    assert.equal((await video.create('job-gone')).status, 422)
    video.gateway.accounting.dropVideo(videoJobKey('venice-video', 'job-bad'))
    assert.equal((await video.create('job-gone')).status, 200)
    await waitFor(() => held() === 600_000)
    assert.equal((await video.poll('job-gone')).status, 404)
    await waitFor(() => held() === 0)
  } finally {
    await video.close()
  }
})

test('a video download that breaks off keeps the job committed', async () => {
  const video = await videoGateway(400_000, 1_000_000)
  const job = videoJobKey('venice-video', 'job-cut')
  try {
    assert.equal((await video.create('job-cut')).status, 200)
    await waitFor(() => video.gateway.accounting.heldUsdc(video.key.id) === 400_000)
    await video.poll('job-cut').catch(() => null)
    // No request holds remain, and the job's price is still a commitment (leaving the job out drops it).
    await waitFor(() => video.gateway.accounting.heldUsdc(video.key.id, job) === 0)
    assert.equal(video.gateway.accounting.heldUsdc(video.key.id), 400_000)
  } finally {
    await video.close()
  }
})

test('a job the buyer retires stops counting, and a delivered one counts until its charge arrives', async () => {
  const video = await videoGateway(400_000, 1_000_000)
  const held = () => video.gateway.accounting.heldUsdc(video.key.id)
  try {
    assert.equal((await video.create('job-fail')).status, 200)
    assert.equal((await video.create('job-done')).status, 200)
    await waitFor(() => held() === 800_000)
    assert.equal((await video.poll('job-fail')).status, 200)
    await waitFor(() => held() === 400_000)
    // Delivered: the job still holds its price (no request hold) until the buyer's charge arrives, then the ledger has it.
    assert.equal((await video.poll('job-done')).status, 200)
    await waitFor(() => video.store.listRequests({ keyIds: null, keyId: video.key.id }).some((row) => row.video?.action === 'delivery'))
    assert.equal(held(), 400_000)
    await video.gateway.feed.pollOnce()
    assert.equal(held(), 0)
    assert.equal(video.store.periodSpend(video.key.id).total, 400_000, 'counted once, as spend')
    // Its owner may download it again (the buyer does not charge twice).
    assert.equal((await video.poll('job-done')).status, 200)
  } finally {
    await video.close()
  }
})

test('only the key that created a video job may retrieve it', async () => {
  const video = await videoGateway(400_000, 1_000_000)
  try {
    assert.equal((await video.create('job-done')).status, 200)
    const stolen = await video.poll('job-done', video.otherSecret)
    assert.equal(stolen.status, 404)
    assert.equal(JSON.parse(stolen.body).error.code, 'video_route_not_found')
    assert.equal((await video.poll('job-unknown')).status, 404, 'a job this gateway never created is refused too')
    assert.equal((await video.poll('job-done')).status, 200)
  } finally {
    await video.close()
  }
})

test('without a single readable price from the buyer, an accepted job holds its whole allowance', async () => {
  // A seller copy of the price header next to the buyer's arrives joined ("1, 400000"): not a price.
  for (const header of [['1', '400000'], 'lots']) {
    const video = await videoGateway(400_000, 1_000_000, 0, header)
    try {
      assert.equal((await video.create('job-1')).status, 200)
      await waitFor(() => video.gateway.accounting.heldUsdc(video.key.id) === 1_000_000)
    } finally {
      await video.close()
    }
  }
  // A price above the allowance is held at the allowance.
  const video = await videoGateway(400_000, 1_000_000, 0, '9000000')
  try {
    assert.equal((await video.create('job-1')).status, 200)
    await waitFor(() => video.gateway.accounting.heldUsdc(video.key.id) === 1_000_000)
  } finally {
    await video.close()
  }
})

test('a revoked key\'s jobs stop counting against its workspace', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
    const accounting = new GatewayAccounting(store, { holdUsdc: 100_000 })
    const create = accounting.admit(key)
    assert.ok(create.ok)
    accounting.commitVideo(create.tag, videoJobKey('venice-video', 'job-1'), 600_000)
    accounting.release(create.tag)
    assert.equal(accounting.heldForWorkspace(key.workspaceId), 600_000)
    store.revokeKey(key.id)
    assert.equal(accounting.heldForWorkspace(key.workspaceId), 0)
    accounting.dispose()
  } finally {
    cleanup()
  }
})

test('a video delivery whose spend has not arrived is pending, like any charged request', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await videoJobBuyer(0)
  const { key, secret } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    const retrieve = '{"model":"seedance","queue_id":"job-7"}'
    await request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: secret, body: '{"model":"seedance","prompt":"An ant"}' })
    await request(gateway.port, '/api/v1/video/retrieve', { method: 'POST', key: secret, body: retrieve })
    await request(gateway.port, '/api/v1/video/retrieve', { method: 'POST', key: secret, body: retrieve })
    const delivery = store.listRequests({ keyIds: null, keyId: key.id }).find((row) => row.video?.action === 'delivery')
    assert.equal(delivery?.costPending, true)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('gateway never forwards client credential headers to the buyer (#1104)', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await fakeBuyer()
  const { secret } = store.createKey({ label: 'Remote', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port)
  try {
    const res = await request(gateway.port, '/v1/messages', {
      method: 'POST', key: secret, body: '{"model":"m"}',
      headers: {
        'x-api-key': 'sk-ant-real',
        'x-goog-api-key': 'AIza-real',
        'api-key': 'azure-real',
        'proxy-authorization': 'Basic cHJveHk6c2VjcmV0',
        cookie: 'session=real',
        'anthropic-version': '2023-06-01',
      },
    })
    assert.equal(res.status, 200)
    const forwarded = buyer.captured[0]!.headers
    for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-goog-api-key', 'api-key']) {
      assert.equal(forwarded[name], undefined, `${name} must not reach the buyer`)
    }
    assert.equal(forwarded['anthropic-version'], '2023-06-01')
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('gateway rejects revoked and expired keys', async () => {
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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

test('GET /v1/key reports the caps admission enforces: the lower of the admins\' and the owner\'s', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await fakeBuyer({ costUsdc: 400_000 })
  const shared = store.createKey({
    label: 'Shared',
    buyerIdentity: DEFAULT_BUYER_IDENTITY,
    limits: { daily: 5_000_000, monthly: 2_000_000, total: null },
    ownerLimits: { daily: 1_000_000, weekly: null, monthly: 3_000_000, total: null },
    expiresAt: null,
  })
  const gateway = await startGateway(store, buyer.port)
  try {
    assert.equal((await request(gateway.port, '/v1/chat/completions', { method: 'POST', key: shared.secret, body: '{"model":"deepseek-v4-flash"}' })).status, 200)
    await gateway.feed.pollOnce()
    const { limits } = JSON.parse((await request(gateway.port, '/v1/key', { key: shared.secret })).body).data
    // The owner's daily cap is the lower one.
    assert.equal(limits.daily.limit_usd, '1.000000')
    assert.equal(limits.daily.remaining_usd, '0.600000')
    // The admins' monthly cap is the lower one.
    assert.equal(limits.monthly.limit_usd, '2.000000')
    assert.equal(limits.monthly.remaining_usd, '1.600000')
    assert.equal(limits.total.limit_usd, null)
    assert.equal(limits.total.remaining_usd, null)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('gateway holds block concurrent requests from slipping under a cap', () => {
  const { store, cleanup } = tempDataDir()
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

test('an accepted video stays committed across a gateway restart until it is dropped', () => {
  const { store, cleanup } = tempDataDir()
  const job = videoJobKey('venice-video', 'job-1')
  try {
    const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
    const before = new GatewayAccounting(store, { holdUsdc: 100_000 })
    const create = before.admit(key, undefined, { videoCreate: true })
    assert.ok(create.ok)
    before.commitVideo(create.tag, job, 600_000)
    before.release(create.tag)
    before.dispose()

    const after = new GatewayAccounting(store, { holdUsdc: 100_000 })
    assert.equal(after.heldUsdc(key.id), 600_000)
    const next = after.admit(key, undefined, { videoCreate: true })
    assert.ok(next.ok)
    assert.equal(next.remainingUsdc, 400_000, 'a second create is told only what the first job leaves')
    after.release(next.tag)
    after.dropVideo(job)
    after.dispose()
    assert.equal(new GatewayAccounting(store, { holdUsdc: 100_000 }).heldUsdc(key.id), 0)
  } finally {
    cleanup()
  }
})

test('an undelivered video stays committed for as long as the buyer can still charge it (30 days)', () => {
  const { store, cleanup } = tempDataDir()
  let now = Date.UTC(2026, 0, 1)
  const day = 24 * 60 * 60_000
  try {
    const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: null, monthly: null, total: 1_000_000 }, expiresAt: null })
    const accounting = new GatewayAccounting(store, { holdUsdc: 100_000, now: () => now })
    const create = accounting.admit(key, undefined, { videoCreate: true })
    assert.ok(create.ok)
    accounting.commitVideo(create.tag, videoJobKey('venice-video', 'old-job'), 600_000)
    accounting.release(create.tag)
    now += 29 * day
    const later = accounting.admit(key, undefined, { videoCreate: true })
    assert.ok(later.ok)
    assert.equal(later.remainingUsdc, 400_000, 'a month-old job that can still be downloaded still counts')
    accounting.release(later.tag)
    now += 2 * day
    assert.equal(accounting.heldUsdc(key.id), 0)
    accounting.dispose()
  } finally {
    cleanup()
  }
})

test('a charge on a video job lowers what the job holds by that much, whatever request of the job it names', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 5_000_000, monthly: null, total: null }, expiresAt: null })
    const accounting = new GatewayAccounting(store, { holdUsdc: 100_000 })
    const job = videoJobKey('venice-video', 'job-1')
    const create = accounting.admit(key, undefined, { videoCreate: true })
    assert.ok(create.ok)
    accounting.commitVideo(create.tag, job, 5_000_000)
    accounting.release(create.tag)
    // A status poll of the job that the seller bills $0.30 (for example a headroom request) frees only $0.30.
    store.startRequest({ tag: 'poll-tag', keyId: key.id, buyerIdentity: DEFAULT_BUYER_IDENTITY, method: 'POST', path: '/api/v1/video/retrieve', model: null, startedAt: 0, video: { action: 'poll', jobId: 'job-1' } })
    const event = { seq: 1, tag: 'poll-tag', requestId: 'r', buyerIdentity: DEFAULT_BUYER_IDENTITY, sellerPeerId: 's', amountUsdc: '300000', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0', at: Date.now() }
    accounting.ingest('boot', [event])
    assert.equal(accounting.heldUsdc(key.id), 4_700_000)
    assert.equal(store.periodSpend(key.id).daily, 300_000, 'spend plus what the job holds is still $5')
    accounting.dispose()
  } finally {
    cleanup()
  }
})

test('an opening fee charged on a video create is never held twice, whether it arrives before or after the job is accepted', () => {
  for (const feeFirst of [true, false]) {
    const { store, cleanup } = tempDataDir()
    try {
      const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 5_000_000, monthly: null, total: null }, expiresAt: null })
      const accounting = new GatewayAccounting(store, { holdUsdc: 100_000 })
      const job = videoJobKey('venice-video', 'job-1')
      const create = accounting.admit(key, undefined, { videoCreate: true })
      assert.ok(create.ok)
      store.startRequest({ tag: create.tag, keyId: key.id, buyerIdentity: DEFAULT_BUYER_IDENTITY, method: 'POST', path: '/api/v1/video/queue', model: null, startedAt: 0, video: { action: 'create', jobId: null } })
      // The one-off channel's $0.30 opening fee counts toward the $4.20 video.
      const fee = { seq: 1, tag: create.tag, requestId: 'r', buyerIdentity: DEFAULT_BUYER_IDENTITY, sellerPeerId: 's', amountUsdc: '300000', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0', at: Date.now() }
      if (feeFirst) accounting.ingest('boot', [fee])
      store.recordRequestOutcome(create.tag, { sellerPeerId: 's', latencyMs: 1, firstTokenMs: null, tokensPerSecond: null, endUser: null, servedFree: false, videoJobId: 'job-1', videoDelivered: false })
      accounting.commitVideo(create.tag, job, 4_200_000)
      accounting.release(create.tag)
      if (!feeFirst) accounting.ingest('boot', [fee])
      assert.equal(accounting.heldUsdc(key.id), 3_900_000, 'only what is not spent yet is held')
      assert.equal(store.periodSpend(key.id).daily, 300_000)
      // The delivery charges the rest: nothing stays held.
      store.startRequest({ tag: 'delivery', keyId: key.id, buyerIdentity: DEFAULT_BUYER_IDENTITY, method: 'POST', path: '/api/v1/video/retrieve', model: null, startedAt: 0, video: { action: 'poll', jobId: 'job-1' } })
      store.recordRequestOutcome('delivery', { videoDelivered: true })
      accounting.ingest('boot', [{ ...fee, seq: 2, tag: 'delivery', amountUsdc: '3900000' }])
      assert.equal(accounting.heldUsdc(key.id), 0)
      assert.equal(store.periodSpend(key.id).daily, 4_200_000)
      accounting.dispose()
    } finally {
      cleanup()
    }
  }
})

test('a job that holds its price can always be polled and downloaded, even after other spend fills the cap', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: null, monthly: null, total: 1_000_000 }, expiresAt: null })
    const accounting = new GatewayAccounting(store, { holdUsdc: 100_000 })
    const job = videoJobKey('venice-video', 'job-1')
    const create = accounting.admit(key, undefined, { videoCreate: true })
    assert.ok(create.ok)
    accounting.commitVideo(create.tag, job, 600_000)
    accounting.release(create.tag)
    // A late charge of earlier work fills what is left.
    store.startRequest({ tag: 'late', keyId: key.id, buyerIdentity: DEFAULT_BUYER_IDENTITY, method: 'POST', path: '/v1/chat/completions', model: null, startedAt: 0 })
    accounting.ingest('boot', [{ seq: 1, tag: 'late', requestId: 'r', buyerIdentity: DEFAULT_BUYER_IDENTITY, sellerPeerId: 's', amountUsdc: '500000', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0', at: Date.now() }])
    assert.equal(accounting.admit(key).ok, false, 'other requests are refused')
    const poll = accounting.admit(key, undefined, { videoJob: job })
    assert.ok(poll.ok, 'the job itself is not: its price already covers its charge')
    assert.equal(accounting.heldUsdc(key.id, job), 0, 'and it adds nothing to what is held')
    accounting.release(poll.tag)
    accounting.dispose()
  } finally {
    cleanup()
  }
})

test('capped requests are refused while a video commitment cannot be stored or loaded, and resume once it can', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await pricedVideoBuyer(400_000)
  const { key, secret } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
  const save = store.saveVideoCommitment.bind(store)
  let failWrites = true
  store.saveVideoCommitment = (record) => { if (failWrites) throw new Error('database is locked'); save(record) }
  const gateway = await startGateway(store, buyer.port, 100_000, null, 60_000)
  try {
    assert.equal((await request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: secret, body: '{"model":"seedance","prompt":"An ant","duration":"8s","job":"job-1"}' })).status, 200)
    await waitFor(() => gateway.accounting.heldUsdc(key.id) === 400_000)
    // The job is held in memory but not stored: a restart could forget it, so capped requests wait.
    const refused = await request(gateway.port, '/v1/chat/completions', { method: 'POST', key: secret, body: '{"model":"m"}' })
    assert.equal(refused.status, 503)
    assert.equal(JSON.parse(refused.body).error.code, 'spend_tracking_unavailable')
    failWrites = false
    assert.equal((await request(gateway.port, '/v1/chat/completions', { method: 'POST', key: secret, body: '{"model":"m"}' })).status, 200)
    assert.equal(store.listVideoCommitments(Date.now()).length, 1, 'stored on the retry')
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('stored video commitments that cannot be read at startup are read before any capped request', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
    store.saveVideoCommitment({ job: videoJobKey('venice-video', 'job-1'), keyId: key.id, memberId: null, workspaceId: key.workspaceId, amountUsdc: 600_000, expiresAt: Date.now() + 60_000, deliveredAt: null })
    const list = store.listVideoCommitments.bind(store)
    let failReads = true
    store.listVideoCommitments = (now) => { if (failReads) throw new Error('database is locked'); return list(now) }
    const accounting = new GatewayAccounting(store, { holdUsdc: 100_000 })
    assert.equal(accounting.videoCommitmentsReady(), false)
    failReads = false
    assert.equal(accounting.videoCommitmentsReady(), true)
    assert.equal(accounting.heldUsdc(key.id), 600_000)
    accounting.dispose()
  } finally {
    cleanup()
  }
})

test('a free video holds nothing for its job', async () => {
  const video = await videoGateway(0, 1_000_000)
  try {
    assert.equal((await video.create('job-free')).status, 200)
    await waitFor(() => video.gateway.accounting.heldUsdc(video.key.id) === 0)
    assert.equal(video.gateway.accounting.videoJobOwner(videoJobKey('venice-video', 'job-free')), video.key.id)
  } finally {
    await video.close()
  }
})

test('a delivered video that is never charged stops holding its price an hour after delivery', () => {
  const { store, cleanup } = tempDataDir()
  let now = Date.UTC(2026, 0, 1)
  try {
    const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 1_000_000, monthly: null, total: null }, expiresAt: null })
    const accounting = new GatewayAccounting(store, { holdUsdc: 100_000, now: () => now })
    const job = videoJobKey('venice-video', 'job-1')
    const create = accounting.admit(key, undefined, { videoCreate: true })
    assert.ok(create.ok)
    accounting.commitVideo(create.tag, job, 600_000)
    accounting.release(create.tag)
    accounting.videoDelivered(job)
    now += 59 * 60_000
    assert.equal(accounting.heldUsdc(key.id), 600_000, 'its charge may still be on the way')
    now += 2 * 60_000
    assert.equal(accounting.heldUsdc(key.id), 0)
    assert.equal(accounting.videoJobOwner(job), key.id, 'its owner can still download it again')
    accounting.dispose()
    assert.equal(new GatewayAccounting(store, { holdUsdc: 100_000, now: () => now }).heldUsdc(key.id), 0, 'stored that way')
  } finally {
    cleanup()
  }
})

test('a job created while its key had no caps counts once caps are added', async () => {
  const { store, cleanup } = tempDataDir()
  const buyer = await pricedVideoBuyer(600_000)
  const { key, secret } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  const gateway = await startGateway(store, buyer.port, 100_000, null, 60_000)
  try {
    assert.equal((await request(gateway.port, '/api/v1/video/queue', { method: 'POST', key: secret, body: '{"model":"seedance","prompt":"An ant","duration":"8s","job":"job-1"}' })).status, 200)
    await waitFor(() => gateway.accounting.heldUsdc(key.id) === 600_000)
    const capped = store.updateKey(key.id, { limits: { daily: 1_000_000, monthly: null, total: null } })
    const next = gateway.accounting.admit(capped, undefined, { videoCreate: true })
    assert.ok(next.ok)
    assert.equal(next.remainingUsdc, 400_000)
    gateway.accounting.release(next.tag)
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
})

test('a video create reserves up to the buyer video limit, configured or default', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const { key } = store.createKey({ label: 'Video', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: { daily: 20_000_000, monthly: null, total: null }, expiresAt: null })
    for (const [maxVideoRequestUsdc, reserved] of [[undefined, 5_000_000], [10_000_000, 10_000_000], [50_000_000, 20_000_000]] as const) {
      const accounting = new GatewayAccounting(store, { holdUsdc: 100_000, ...(maxVideoRequestUsdc ? { maxVideoRequestUsdc } : {}) })
      const admission = accounting.admit(key, undefined, { videoCreate: true })
      assert.ok(admission.ok)
      assert.equal(admission.remainingUsdc, reserved)
      assert.equal(accounting.heldUsdc(key.id), reserved)
      accounting.dispose()
    }
  } finally {
    cleanup()
  }
})

test('a finished request keeps its remaining hold after its first spend delta', () => {
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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
    const malformed = decodeHeaderJson<PaymentPayload>(await signPayment(payer, required))!
    malformed.payload.authorization.validBefore = 'never'
    assert.equal(await reasonFor(encodeHeaderJson(malformed)), 'invalid_payload')
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
  const { store, cleanup } = tempDataDir()
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
  const { store, cleanup } = tempDataDir()
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
