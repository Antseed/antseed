import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { SPEND_ATTRIBUTION_DB_FILE, SPEND_ATTRIBUTION_HEADER, SpendAttributionFeed } from '../proxy/spend-attribution.js'
import { GATEWAY_CONTROL_HEADER } from '../routing-policy/policy.js'
import { GatewayAccounting } from './accounting.js'
import { GatewayServer } from './server.js'
import { parseGrouping, listRequestPage, usageReport } from './services/usage.js'
import { SpendFeedPoller } from './spend-feed.js'
import { GatewayStore } from './store.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }
const HOUR = 60 * 60 * 1000
const SECRET = 'a'.repeat(64)

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const SPEND = { sellerPeerId: 'seller', amountUsdc: '10', inputTokens: '100', cachedInputTokens: '40', outputTokens: '20', outputImages: '0' }

// ── Buyer side: the feed survives a restart ──────────────────────────────

test('a file-backed feed keeps its id, events and sequence across a restart', (context) => {
  const { dir, cleanup } = tempDir('antseed-feed-')
  context.after(cleanup)
  const path = join(dir, SPEND_ATTRIBUTION_DB_FILE)
  const first = new SpendAttributionFeed(() => 1000, { path })
  first.track('req-1', 'gw_a')
  first.record({ ...SPEND, requestId: 'req-1' })
  first.record({ ...SPEND, requestId: 'req-1', amountUsdc: '5' })
  const bootId = first.bootId
  first.close()

  const second = new SpendAttributionFeed(() => 2000, { path })
  context.after(() => second.close())
  assert.equal(second.bootId, bootId)
  // Request tags survive too: late spend for a request from before the restart keeps its tag.
  second.record({ ...SPEND, requestId: 'req-1', amountUsdc: '3' })
  const page = second.page(0)
  assert.deepEqual(page.events.map((event) => [event.seq, event.tag, event.amountUsdc]), [[1, 'gw_a', '10'], [2, 'gw_a', '5'], [3, 'gw_a', '3']])
  assert.equal(page.oldestSeq, 1)
  assert.deepEqual(second.page(2).events.map((event) => event.seq), [3])
})

test('an in-memory feed gets a new id per instance', (context) => {
  const a = new SpendAttributionFeed()
  const b = new SpendAttributionFeed()
  context.after(() => { a.close(); b.close() })
  assert.notEqual(a.bootId, b.bootId)
})

test('acknowledged events are pruned after an hour, unacknowledged ones after 7 days', (context) => {
  const { dir, cleanup } = tempDir('antseed-feed-')
  context.after(cleanup)
  let now = 0
  const feed = new SpendAttributionFeed(() => now, { path: join(dir, SPEND_ATTRIBUTION_DB_FILE) })
  context.after(() => feed.close())
  feed.track('req-1', 'gw_a')
  for (let index = 0; index < 4; index++) feed.record({ ...SPEND, requestId: 'req-1' })
  // An unauthenticated reader's cursor acknowledges nothing.
  feed.page(4)
  // A bogus cursor past the last event acknowledges nothing either.
  feed.page(1000, { ack: true })
  now = 2 * HOUR
  feed.track('req-2', 'gw_b')
  assert.equal(feed.page(0).events.length, 4)

  feed.page(2, { ack: true })
  now = 2 * HOUR + 2 * 60 * 1000
  feed.track('req-3', 'gw_c')
  const page = feed.page(0)
  assert.deepEqual(page.events.map((event) => event.seq), [3, 4])
  assert.equal(page.oldestSeq, 3)

  // Acknowledging 5 acknowledges 3 and 4 too (signed over an hour ago, so
  // they go); 5 was signed just now and stays for an hour.
  feed.record({ ...SPEND, requestId: 'req-3' })
  feed.page(5, { ack: true })
  now = 2 * HOUR + 30 * 60 * 1000
  feed.track('req-4', 'gw_d')
  assert.deepEqual(feed.page(0).events.map((event) => event.seq), [5])

  now = 8 * 24 * HOUR
  feed.track('req-5', 'gw_e')
  const empty = feed.page(0)
  assert.deepEqual(empty.events, [])
  assert.equal(empty.oldestSeq, 6, 'the next sequence number survives an empty table')
  feed.record({ ...SPEND, requestId: 'req-5' })
  assert.deepEqual(feed.page(0).events.map((event) => event.seq), [6])
})

// ── Gateway + buyer: spend signed before a buyer restart still arrives ──

/** A fake buyer backed by a file feed in `dataDir`, answering model requests with `respond`. */
async function fileBuyer(dataDir: string, port: number, respond: (res: http.ServerResponse) => void) {
  const feed = new SpendAttributionFeed(undefined, { path: join(dataDir, SPEND_ATTRIBUTION_DB_FILE) })
  const acks: boolean[] = []
  let counter = 0
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/_antseed/attributed-spend')) {
      const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after') ?? '0')
      const ack = req.headers[GATEWAY_CONTROL_HEADER] === SECRET
      acks.push(ack)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...feed.page(after, { ack }) }))
      return
    }
    req.resume()
    req.on('end', () => {
      const tag = req.headers[SPEND_ATTRIBUTION_HEADER] as string | undefined
      const requestId = `req-${Date.now()}-${++counter}`
      if (tag) {
        feed.track(requestId, tag)
        feed.record({ ...SPEND, requestId, buyerIdentity: DEFAULT_BUYER_IDENTITY })
      }
      respond(res)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const actualPort = (server.address() as { port: number }).port
  return {
    port: actualPort,
    acks,
    /** Like a crash: the process goes, the file stays. */
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { feed.close(); resolve() }) }),
  }
}

async function postJson(port: number, key: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

function sseUsage(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }], usage: null })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } })}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function gatewayFor(store: GatewayStore, buyerPort: number) {
  const accounting = new GatewayAccounting(store, { holdUsdc: 300_000, settleGraceMs: 50 })
  const feed = new SpendFeedPoller({
    buyerPort,
    controlSecret: SECRET,
    onPage: (page) => { accounting.ingest(page.bootId, page.events) },
    intervalMs: 60_000,
  })
  const server = new GatewayServer({
    store, accounting, buyerPort, topup: null,
    identityAddress: async () => null,
    spendFeedState: () => feed.state,
    refreshSpendFeed: () => feed.pollOnce(),
  })
  const port = await server.start()
  return { port, feed, stop: async () => { await server.stop(); accounting.dispose() } }
}

test('spend signed before a buyer restart reaches the ledger after it, exactly once', async (context) => {
  const buyerDir = tempDir('antseed-buyer-')
  const gatewayDir = tempDir('antseed-gateway-')
  const store = new GatewayStore(gatewayDir.dir)
  context.after(() => { store.close(); gatewayDir.cleanup(); buyerDir.cleanup() })
  const { key, secret } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })

  let buyer = await fileBuyer(buyerDir.dir, 0, sseUsage)
  const buyerPort = buyer.port
  const gateway = await gatewayFor(store, buyerPort)
  context.after(() => gateway.stop())

  // The gateway knows the feed before the request (its cursor is 0).
  await gateway.feed.pollOnce()
  const response = await postJson(gateway.port, secret, { model: 'test-model', messages: [], stream: true })
  assert.equal(response.status, 200)

  // Before the spend arrives: tokens from the response itself, cost pending.
  let [row] = listRequestPage(store, { keyIds: null }).requests
  assert.equal(row!.spent, null)
  assert.equal(row!.costPending, true)
  assert.deepEqual([row!.inputTokens, row!.cachedInputTokens, row!.outputTokens], [100, 40, 20])

  // The buyer dies before the gateway polls, and comes back on the same port.
  await buyer.stop()
  await gateway.feed.pollOnce()
  assert.equal(gateway.feed.state, 'unreachable')
  buyer = await fileBuyer(buyerDir.dir, buyerPort, sseUsage)
  context.after(() => buyer.stop())
  await gateway.feed.pollOnce()

  ;[row] = listRequestPage(store, { keyIds: null }).requests
  assert.equal(row!.spent, '0.000010')
  assert.equal(row!.costPending, undefined)
  assert.deepEqual([row!.inputTokens, row!.cachedInputTokens, row!.outputTokens], [100, 40, 20])
  assert.ok(buyer.acks.every(Boolean), 'the gateway polls with its control secret')

  // A gateway restart reads the feed from 0 again: nothing counts twice.
  const fresh = new SpendFeedPoller({
    buyerPort, controlSecret: SECRET, intervalMs: 60_000,
    onPage: (page) => { new GatewayAccounting(store, { holdUsdc: 0 }).ingest(page.bootId, page.events) },
  })
  await fresh.pollOnce()
  const report = usageReport(store, { keyIds: null, keyId: key.id }, { now: Date.now() + 1000 })
  assert.equal(report.totals.requests, 1)
  assert.equal(report.totals.spent, '0.000010')
  assert.deepEqual([report.totals.inputTokens, report.totals.cachedInputTokens, report.totals.outputTokens], [100, 40, 20])
})

// ── Store: response tokens vs ledger tokens, pending cost ───────────────

function storeWithRequest(context: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir('antseed-gateway-')
  const store = new GatewayStore(dir)
  context.after(() => { store.close(); cleanup() })
  const { key } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
  const start = (tag: string, startedAt: number, model: string | null = 'm') =>
    store.startRequest({ tag, keyId: key.id, buyerIdentity: key.buyerIdentity, method: 'POST', path: '/v1/chat/completions', model, startedAt })
  const spend = (tag: string, ref: string, amount: number, tokens: [number, number, number], createdAt: number) => store.recordLedgerEntry({
    kind: 'spend', keyId: key.id, buyerIdentity: key.buyerIdentity, amountUsdc: amount, externalRef: ref, requestTag: tag,
    inputTokens: tokens[0], cachedInputTokens: tokens[1], outputTokens: tokens[2], createdAt,
  })
  return { store, key, start, spend }
}

test('usage uses ledger tokens when the spend has them, else the response tokens, never both', (context) => {
  const { store, key, start, spend } = storeWithRequest(context)
  const t0 = Date.UTC(2026, 9, 8, 10)
  start('gw_a', t0)
  store.finishRequest('gw_a', { status: 200, buyerRequestId: null })
  store.recordResponseUsage('gw_a', { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 })
  start('gw_b', t0 + 1)
  store.finishRequest('gw_b', { status: 200, buyerRequestId: null })
  store.recordResponseUsage('gw_b', { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3 })
  start('gw_c', t0 + 2)
  store.finishRequest('gw_c', { status: 200, buyerRequestId: null })
  store.recordResponseUsage('gw_c', { inputTokens: 50, cachedInputTokens: 0, outputTokens: 5 })

  const filter = { keyIds: null, keyId: key.id }
  const totals = () => store.usageReport({ ...filter, from: t0, to: t0 + HOUR }, null).totals
  assert.deepEqual([totals().inputTokens, totals().cachedInputTokens, totals().outputTokens], [157, 40, 28])

  // Spend with tokens replaces gw_a's response tokens (no double count).
  spend('gw_a', 'spend:x:1', 10, [101, 40, 21], t0 + 5)
  // Spend without token counts leaves gw_b on its response tokens.
  spend('gw_b', 'spend:x:2', 4, [0, 0, 0], t0 + 6)
  assert.deepEqual([totals().inputTokens, totals().cachedInputTokens, totals().outputTokens, totals().spentUsdc], [158, 40, 29, 14])

  const rows = new Map(store.listRequests({ ...filter, limit: 10 }).map((row) => [row.tag, row]))
  assert.deepEqual([rows.get('gw_a')!.inputTokens, rows.get('gw_a')!.outputTokens, rows.get('gw_a')!.costPending], [101, 21, false])
  assert.deepEqual([rows.get('gw_b')!.inputTokens, rows.get('gw_b')!.outputTokens, rows.get('gw_b')!.costPending], [7, 3, false])
  assert.deepEqual([rows.get('gw_c')!.inputTokens, rows.get('gw_c')!.spentUsdc, rows.get('gw_c')!.costPending], [50, null, true])
})

test('only model requests that did not fail wait for a cost', (context) => {
  const { store, key, start } = storeWithRequest(context)
  start('gw_flight', 1)
  start('gw_failed', 2)
  store.finishRequest('gw_failed', { status: 502, buyerRequestId: null })
  start('gw_nomodel', 3, null)
  store.finishRequest('gw_nomodel', { status: 200, buyerRequestId: null })
  const pending = Object.fromEntries(store.listRequests({ keyIds: null, keyId: key.id, limit: 10 }).map((row) => [row.tag, row.costPending]))
  assert.deepEqual(pending, { gw_flight: true, gw_failed: false, gw_nomodel: false })
})

test('a usage report groups by hour or day and splits each group by model in one query', (context) => {
  const { store, key, start, spend } = storeWithRequest(context)
  const day1 = Date.UTC(2026, 9, 7, 9, 15)
  const day2 = Date.UTC(2026, 9, 8, 14, 5)
  for (const [tag, at, model] of [['gw_1', day1, 'm1'], ['gw_2', day1 + 60_000, 'm2'], ['gw_3', day2, 'm1']] as const) {
    start(tag, at, model)
    store.finishRequest(tag, { status: 200, buyerRequestId: null })
  }
  spend('gw_1', 'spend:y:1', 1_000, [10, 4, 1], day1 + 1000)
  spend('gw_2', 'spend:y:2', 2_000, [20, 0, 2], day1 + 61_000)
  store.recordResponseUsage('gw_3', { inputTokens: 30, cachedInputTokens: 3, outputTokens: 3 })

  const report = usageReport(store, { keyIds: null, keyId: key.id }, { from: day1 - HOUR, to: day2 + HOUR, groupBy: 'day', splitBy: 'model', now: day2 + HOUR })
  assert.deepEqual(report.groups.map((group) => [group.group, group.requests, group.spent, group.inputTokens, group.cachedInputTokens, group.outputTokens]), [
    ['2026-10-07', 2, '0.003000', 30, 4, 3],
    ['2026-10-08', 1, '0.000000', 30, 3, 3],
  ])
  assert.deepEqual(report.groups[0]!.splits!.map((split) => [split.group, split.label, split.requests, split.spent]), [['m2', 'm2', 1, '0.002000'], ['m1', 'm1', 1, '0.001000']])
  assert.deepEqual(report.groups[1]!.splits!.map((split) => [split.group, split.inputTokens]), [['m1', 30]])

  const hourly = usageReport(store, { keyIds: null, keyId: key.id }, { from: day1 - HOUR, to: day2 + HOUR, groupBy: 'hour', now: day2 + HOUR })
  assert.deepEqual(hourly.groups.map((group) => [group.group, group.requests]), [['2026-10-07T09', 2], ['2026-10-08T14', 1]])
  assert.equal(hourly.groups[0]!.splits, undefined)
})

test('groupBy and splitBy parse together', () => {
  assert.deepEqual(parseGrouping('day,model', null), { groupBy: 'day', splitBy: 'model' })
  assert.deepEqual(parseGrouping('hour', 'model'), { groupBy: 'hour', splitBy: 'model' })
  assert.deepEqual(parseGrouping(null, null), { groupBy: null, splitBy: null })
  assert.throws(() => parseGrouping(null, 'model'), /needs a groupBy/)
  assert.throws(() => parseGrouping('day,day', null), /must differ/)
  assert.throws(() => parseGrouping('day,model', 'key'), /not both/)
  assert.throws(() => parseGrouping('day,model,key', null), /at most two/)
  assert.throws(() => parseGrouping('week', null), /groupBy must be one of/)
  assert.throws(() => parseGrouping('day', 'nope'), /splitBy must be one of/)
})

test('a database from an earlier draft of v3 gains the response usage columns', (context) => {
  const { dir, cleanup } = tempDir('antseed-gateway-')
  context.after(cleanup)
  const store = new GatewayStore(dir)
  store.database.exec('ALTER TABLE gateway_requests DROP COLUMN usage_input_tokens; ALTER TABLE gateway_requests DROP COLUMN usage_output_tokens')
  store.close()
  const reopened = new GatewayStore(dir)
  context.after(() => reopened.close())
  const columns = (reopened.database.prepare('PRAGMA table_info(gateway_requests)').all() as Array<{ name: string }>).map((column) => column.name)
  for (const column of ['usage_input_tokens', 'usage_cached_input_tokens', 'usage_output_tokens']) assert.ok(columns.includes(column), column)
})
