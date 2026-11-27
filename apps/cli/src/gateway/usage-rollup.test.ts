import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GatewayAccounting } from './accounting.js'
import { OBSERVABILITY_SETTING } from './observability.js'
import { GatewayServer } from './server.js'
import { MIGRATIONS } from './store-migrations.js'
import { GatewayStore, type UsageFilter, type UsageGroupBy } from './store.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }
const HOUR = 3_600_000
const BASE = Date.UTC(2026, 0, 5, 9)
const PEER_A = 'a'.repeat(40)
const PEER_B = 'b'.repeat(40)
const ROUTER = 'c'.repeat(40)

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-usage-rollup-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A small seeded generator (mulberry32), so a failing workload replays the same. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Workload {
  random: () => number
  keys: string[]
  /** Requests started and not finished yet, which a later step may finish. */
  open: string[]
  /** Requests started (finished or not), which later spend may name. */
  started: Array<{ tag: string; keyId: string; startedAt: number }>
  next: number
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

function setUp(store: GatewayStore, seed: number): Workload {
  const team = store.createWorkspace({ name: 'Team', buyerIdentity: 'team-a' })
  const keys = [
    store.createKey({ label: 'one', limits: NO_LIMITS, expiresAt: null }).key.id,
    store.createKey({ label: 'two', limits: NO_LIMITS, expiresAt: null }).key.id,
    store.createKey({ label: 'team', workspaceId: team.id, limits: NO_LIMITS, expiresAt: null }).key.id,
  ]
  return { random: seeded(seed), keys, open: [], started: [], next: 0 }
}

function spend(store: GatewayStore, w: Workload, target: { tag: string | null; keyId: string; startedAt: number }, extra: { routingFee?: boolean } = {}): void {
  const metered = w.random() < 0.6
  store.recordLedgerEntry({
    kind: 'spend',
    keyId: target.keyId,
    buyerIdentity: 'default',
    amountUsdc: 1 + Math.floor(w.random() * 5_000),
    externalRef: `spend:${w.next++}`,
    requestTag: target.tag,
    sellerPeerId: extra.routingFee ? ROUTER : pick(w.random, [PEER_A, PEER_B]),
    inputTokens: metered ? Math.floor(w.random() * 900) : 0,
    cachedInputTokens: metered ? Math.floor(w.random() * 300) : 0,
    outputTokens: metered ? 1 + Math.floor(w.random() * 400) : 0,
    // Spend reaches the ledger up to two hours after its request started, often in a later hour.
    createdAt: target.startedAt + Math.floor(w.random() * 2 * HOUR),
    routingFee: extra.routingFee ?? false,
  })
}

function finish(store: GatewayStore, w: Workload, tag: string): void {
  store.recordRequestOutcome(tag, {
    sellerPeerId: pick(w.random, [PEER_A, PEER_B, null]),
    servedModel: pick(w.random, [null, null, 'served-x']),
    router: w.random() < 0.2 ? { peerId: ROUTER, service: 'route', rank: 1 } : null,
    endUser: w.random() < 0.2 ? 'late-user' : null,
    latencyMs: Math.floor(w.random() * 5_000),
  })
  store.finishRequest(tag, { status: pick(w.random, [200, 200, 200, 429, 500]), buyerRequestId: null })
  if (w.random() < 0.6) {
    store.recordResponseUsage(tag, { inputTokens: Math.floor(w.random() * 800), cachedInputTokens: Math.floor(w.random() * 100), outputTokens: Math.floor(w.random() * 300) })
  }
}

/** `count` steps of what a gateway writes: requests, their outcomes and spend (also before the outcome), credits, stray spend. */
function run(store: GatewayStore, w: Workload, count: number, startAt: number, span = 6 * HOUR): void {
  for (let step = 0; step < count; step += 1) {
    const roll = w.random()
    if (roll < 0.55 || w.started.length === 0) {
      const tag = `gw_${w.next++}`
      const keyId = pick(w.random, w.keys)
      const startedAt = startAt + Math.floor(w.random() * span)
      store.startRequest({
        tag, keyId, buyerIdentity: 'default', method: 'POST', path: '/v1/responses', startedAt,
        model: pick(w.random, ['m1', 'm2', null, `${PEER_A}@m3`]),
        endUser: pick(w.random, [null, null, 'u1', 'u2']),
      })
      w.started.push({ tag, keyId, startedAt })
      w.open.push(tag)
    } else if (roll < 0.8 && w.open.length > 0) {
      const tag = w.open.splice(Math.floor(w.random() * w.open.length), 1)[0]!
      finish(store, w, tag)
    } else if (roll < 0.95) {
      spend(store, w, pick(w.random, w.started), { routingFee: w.random() < 0.1 })
    } else if (roll < 0.97) {
      store.recordLedgerEntry({
        kind: 'credit', keyId: pick(w.random, w.keys), buyerIdentity: 'default', amountUsdc: 10_000, externalRef: `credit:${w.next++}`,
        createdAt: startAt + Math.floor(w.random() * span),
      })
    } else {
      // Spend naming no request, or one this log never had.
      spend(store, w, { tag: w.random() < 0.5 ? null : `gone_${w.next++}`, keyId: pick(w.random, w.keys), startedAt: startAt + Math.floor(w.random() * span) })
    }
  }
}

/** Groups and splits in a fixed order (ties sort by insertion, which differs between the two reads). */
function normalized(report: ReturnType<GatewayStore['usageReport']>) {
  const byGroup = <T extends { group: string | null }>(rows: T[]) => [...rows].sort((a, b) => String(a.group).localeCompare(String(b.group)))
  return {
    totals: report.totals,
    groups: byGroup(report.groups).map((group) => ({ ...group, ...(group.splits ? { splits: byGroup(group.splits) } : {}) })),
  }
}

const GROUPINGS: Array<[UsageGroupBy | null, UsageGroupBy | null]> = [
  [null, null], ['hour', null], ['day', 'model'], ['model', 'peer'], ['key', null], ['member', null], ['peer', 'key'], ['router', null],
  ['workspace', 'user'], ['user', null],
]

const WINDOWS: Array<{ from?: number; to?: number }> = [
  {},
  { from: BASE, to: BASE + 3 * HOUR },
  { from: BASE + 17 * 60_000, to: BASE + 4 * HOUR + 5 * 60_000 },
  { from: BASE + HOUR + 5 * 60_000, to: BASE + HOUR + 40 * 60_000 },
  { from: BASE + 2 * HOUR + 1 },
  { to: BASE + 5 * HOUR - 1 },
]

/** Every read the rollup serves, against the same read from the request log and the ledger. */
function assertRollupMatchesLog(store: GatewayStore, w: Workload): void {
  assert.equal(store.usageRollupReady(), true)
  const workspace = store.getKey(w.keys[2]!)!.workspaceId!
  const filters: UsageFilter[] = [{}, { keyId: w.keys[0] }, { workspaceId: workspace }, { model: 'm1' }, { routerPeerId: ROUTER }, { keyIds: [w.keys[1]!, w.keys[2]!] }, { keyIds: [] }]
  for (const window of WINDOWS) {
    for (const filter of filters) {
      for (const [groupBy, splitBy] of GROUPINGS) {
        const scoped = { ...filter, ...window }
        const fromRollup = normalized(store.usageReport(scoped, groupBy, splitBy))
        const fromLog = normalized(store.usageFromLog(() => store.usageReport(scoped, groupBy, splitBy)))
        assert.deepEqual(fromRollup, fromLog, `usage report ${JSON.stringify({ scoped, groupBy, splitBy })}`)
      }
    }
  }
  const sinces = [0, BASE + HOUR, BASE + HOUR + 123_456, BASE + 9 * HOUR]
  for (const keyId of w.keys) {
    for (const since of sinces) {
      assert.deepEqual(store.usageStats(keyId, since), store.usageFromLog(() => store.usageStats(keyId, since)), `usage stats ${keyId} since ${since}`)
    }
  }
  for (const since of sinces) {
    assert.deepEqual(store.keyUsageSummaries(w.keys, since), store.usageFromLog(() => store.keyUsageSummaries(w.keys, since)), `key summaries since ${since}`)
  }
  const bySeller = (rows: ReturnType<GatewayStore['peerStats']>) => [...rows].sort((a, b) => a.peerId.localeCompare(b.peerId))
  for (const since of [0, BASE + 90 * 60_000]) {
    assert.deepEqual(bySeller(store.peerStats(since)), bySeller(store.usageFromLog(() => store.peerStats(since))), `peer stats since ${since}`)
  }
  // Spend and tokens per model match; requests count each billed request once (see the savings test).
  const models = (rows: ReturnType<GatewayStore['usageByModelForKeys']>) =>
    [...rows].map(({ requests: _requests, ...usage }) => usage).sort((a, b) => a.model.localeCompare(b.model))
  assert.deepEqual(models(store.usageByModelForKeys(w.keys)), models(store.usageFromLog(() => store.usageByModelForKeys(w.keys))))
}

test('the hourly rollup answers every usage read exactly as the request log and the ledger do', () => {
  for (const seed of [1, 2, 3]) {
    const { dir, cleanup } = tempDir()
    const store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    try {
      const w = setUp(store, seed)
      run(store, w, 1_500, BASE)
      assertRollupMatchesLog(store, w)
    } finally {
      store.close()
      cleanup()
    }
  }
})

test('usage reports read the rollup: they keep their totals without the rows they came from', () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir, () => BASE + 6 * HOUR)
  try {
    const w = setUp(store, 7)
    run(store, w, 400, BASE)
    const window = { from: BASE, to: BASE + 6 * HOUR }
    const report = store.usageReport(window, 'model')
    const stats = store.usageStats(w.keys[0]!)
    assert.ok(report.totals.requests > 0 && report.totals.spentUsdc > 0)
    // Gone from the log and the ledger (no trigger follows a delete): a read that scanned them would now find nothing.
    store.database.exec('DELETE FROM gateway_requests; DELETE FROM ledger_entries')
    assert.deepEqual(store.usageReport(window, 'model'), report)
    assert.deepEqual(store.usageStats(w.keys[0]!), stats)
    assert.equal(store.usageFromLog(() => store.usageReport(window, null)).totals.requests, 0)
  } finally {
    store.close()
    cleanup()
  }
})

/** Takes the rollup out of a database (its triggers, tables and version), as a gateway from before it left one. */
function beforeTheRollup(store: GatewayStore): void {
  store.database.exec(`
    DROP TRIGGER usage_hourly_request_insert; DROP TRIGGER usage_hourly_request_update;
    DROP TRIGGER usage_hourly_ledger_insert; DROP TRIGGER usage_hourly_ledger_update;
    DROP TABLE usage_hourly; DROP TABLE usage_rollup_state;
  `)
  store.database.pragma(`user_version = ${MIGRATIONS.length - 1}`)
}

/** Puts a rolled-up database back to how migration 18 finds an older one: every row so far waits for the backfill. */
function forgetRollup(dir: string): void {
  const store = new GatewayStore(dir)
  store.database.exec(`
    DELETE FROM usage_hourly;
    UPDATE usage_rollup_state SET
      requests_from = (SELECT MAX(started_at) + 1 FROM gateway_requests),
      requests_cursor = (SELECT MIN(started_at) FROM gateway_requests),
      ledger_from = COALESCE((SELECT MAX(id) FROM ledger_entries), 0),
      ledger_cursor = 0;
  `)
  store.close()
}

test('the backfill rolls up older rows exactly while new requests, outcomes and spend keep arriving', async () => {
  for (const seed of [11, 12]) {
    const { dir, cleanup } = tempDir()
    try {
      let store = new GatewayStore(dir, () => BASE + 6 * HOUR)
      const w = setUp(store, seed)
      run(store, w, 900, BASE)
      store.close()
      forgetRollup(dir)
      store = new GatewayStore(dir, () => BASE + 6 * HOUR)
      assert.equal(store.usageRollupReady(), false)
      assert.equal(await store.pruneRequests(BASE + 6 * HOUR), 0, 'retention waits for the backfill, or pruned counts would be lost')
      // Between chunks: older requests finish, spend arrives for them, and new requests start (some dated in the backfilled range).
      let chunks = 0
      const done = await store.backfillUsageRollup({
        chunkSize: 13,
        shouldStop: () => {
          chunks += 1
          run(store, w, 4, BASE + Math.floor(w.random() * 4) * HOUR, 3 * HOUR)
          return false
        },
      })
      assert.equal(done, true)
      assert.ok(chunks > 20, `the backfill ran in chunks (${chunks})`)
      run(store, w, 300, BASE)
      assertRollupMatchesLog(store, w)
      store.close()
    } finally {
      cleanup()
    }
  }
})

test('the backfill rolls up request rows a chunk at a time, also with no ledger rows to roll up', async () => {
  const { dir, cleanup } = tempDir()
  try {
    let store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    const { key } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    // 300 requests, several in the same millisecond (a chunk never splits one).
    for (let i = 0; i < 300; i += 1) {
      store.startRequest({ tag: `gw_${i}`, keyId: key.id, buyerIdentity: 'default', method: 'POST', path: '/v1/responses', model: 'm1', startedAt: BASE + Math.floor(i / 3) * 1_000 })
    }
    store.close()
    forgetRollup(dir)
    store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    try {
      const cursors: number[] = []
      const cursor = () => (store.database.prepare('SELECT requests_cursor FROM usage_rollup_state').get() as { requests_cursor: number }).requests_cursor
      assert.equal(await store.backfillUsageRollup({ chunkSize: 25, shouldStop: () => { cursors.push(cursor()); return false } }), true)
      // 300 rows in chunks of 25 (plus the ties of a chunk's last millisecond): at least 11 steps, the cursor moving each time.
      assert.ok(cursors.length >= 11, `chunks: ${cursors.length}`)
      assert.deepEqual([...cursors].sort((a, b) => a - b), cursors)
      assert.equal(new Set(cursors).size, cursors.length)
      assert.equal(store.usageReport({}, null).totals.requests, 300)
    } finally {
      store.close()
    }
  } finally {
    cleanup()
  }
})

test('a backfill stopped early resumes where it left off', async () => {
  const { dir, cleanup } = tempDir()
  try {
    let store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    const w = setUp(store, 21)
    run(store, w, 500, BASE)
    store.close()
    forgetRollup(dir)
    store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    let calls = 0
    assert.equal(await store.backfillUsageRollup({ chunkSize: 10, shouldStop: () => ++calls >= 5 }), false)
    assert.equal(store.usageRollupReady(), false)
    run(store, w, 50, BASE)
    store.close()
    store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    assert.equal(await store.backfillUsageRollup({ chunkSize: 10 }), true)
    assertRollupMatchesLog(store, w)
    store.close()
  } finally {
    cleanup()
  }
})

test('migration 18 on a database with history keeps pruned counts and rolls the rest up in the background', async () => {
  const { dir, cleanup } = tempDir()
  try {
    let store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    const w = setUp(store, 31)
    run(store, w, 600, BASE)
    // As an older gateway left it: no rollup, and request counts of rows it pruned in request_rollups.
    beforeTheRollup(store)
    store.database.prepare(`INSERT INTO request_rollups (hour_start, key_id, workspace_id, member_id, model, seller_peer_id, end_user, router_peer_id, requests, failed_requests)
      VALUES (?, ?, ?, NULL, 'm1', NULL, NULL, NULL, 40, 3)`).run(BASE - 30 * 24 * HOUR, w.keys[0], 'ws_default')
    store.close()

    store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    assert.equal(store.usageRollupReady(), false)
    const fromLog = normalized(store.usageReport({}, 'model'))
    assert.equal(await store.backfillUsageRollup({ chunkSize: 50 }), true)
    assert.deepEqual(normalized(store.usageReport({}, 'model')), fromLog, 'the same report before and after the backfill')
    assert.equal(store.usageStats(w.keys[0]!, BASE - 31 * 24 * HOUR).requests >= 40, true, 'pruned counts moved over')
    assertRollupMatchesLog(store, w)
    store.close()
  } finally {
    cleanup()
  }
})

/** What gateways before the rollup did to prune: move request counts into request_rollups, then delete the rows. */
function pruneLikeBefore(store: GatewayStore, before: number): void {
  store.database.prepare(`
    INSERT INTO request_rollups (hour_start, key_id, workspace_id, member_id, model, seller_peer_id, end_user, router_peer_id, requests, failed_requests)
    SELECT (r.started_at / ${HOUR}) * ${HOUR}, r.key_id, r.workspace_id, r.member_id, r.model, r.seller_peer_id, r.end_user, r.router_peer_id,
      COUNT(*), SUM(r.finished_at IS NOT NULL AND (r.status IS NULL OR r.status >= 400))
    FROM gateway_requests r WHERE r.started_at < ? GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  `).run(before)
  store.database.prepare('DELETE FROM gateway_requests WHERE started_at < ?').run(before)
}

/** Windows that start or end inside the pruned hours (pruned up to `BASE + 1 h 40 min`), or both. */
const PRUNED_WINDOWS: Array<{ from?: number; to?: number }> = [
  {},
  { from: BASE, to: BASE + 90 * 60_000 },
  { from: BASE, to: BASE + HOUR + 50 * 60_000 },
  { from: BASE + 20 * 60_000, to: BASE + 2 * HOUR + 10 * 60_000 },
  { from: BASE + HOUR + 10 * 60_000, to: BASE + HOUR + 50 * 60_000 },
  { to: BASE + HOUR + 30 * 60_000 },
  { from: BASE + HOUR + 30 * 60_000 },
]

test('reports over hours pruned before the rollup count them as they always did, partial edges included', async () => {
  const { dir, cleanup } = tempDir()
  try {
    let store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    const w = setUp(store, 51)
    run(store, w, 800, BASE)
    // An older gateway: no rollup yet, and its retention pruned the log up to 10:40 (mid-hour).
    beforeTheRollup(store)
    pruneLikeBefore(store, BASE + HOUR + 40 * 60_000)
    store.close()

    store = new GatewayStore(dir, () => BASE + 6 * HOUR)
    const read = () => PRUNED_WINDOWS.flatMap((window) => [
      ...GROUPINGS.map(([groupBy, splitBy]) => normalized(store.usageReport(window, groupBy, splitBy))),
      ...w.keys.map((keyId) => store.usageStats(keyId, window.from ?? 0)),
      Object.fromEntries(store.keyUsageSummaries(w.keys, window.from ?? 0)),
    ])
    assert.equal(store.usageRollupReady(), false)
    const beforeBackfill = read()
    assert.equal(await store.backfillUsageRollup({ chunkSize: 40 }), true)
    assert.deepEqual(read(), beforeBackfill)
    store.close()
  } finally {
    cleanup()
  }
})

test('a report ending inside an hour pruned after the rollup counts the hour\'s pruned requests whole and its spend exactly', async () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir, () => BASE + 6 * HOUR)
  try {
    const w = setUp(store, 61)
    run(store, w, 800, BASE)
    const hour = BASE + HOUR
    const cutoff = hour + 40 * 60_000
    const prunedPart = store.usageReport({ from: hour, to: cutoff }, null).totals
    const firstHalf = store.usageReport({ from: hour, to: hour + 30 * 60_000 }, null).totals
    const wholeHour = store.usageReport({ from: hour, to: hour + HOUR }, 'model')
    assert.notEqual(prunedPart.requests, firstHalf.requests, 'requests between the report\'s end and the cutoff')
    assert.ok(await store.pruneRequests(cutoff) > 0)

    // As before the rollup: the pruned requests of the hour a report ends in count whole, the spend to its end.
    const report = store.usageReport({ from: hour, to: hour + 30 * 60_000 }, null).totals
    assert.equal(report.requests, prunedPart.requests)
    assert.equal(report.failedRequests, prunedPart.failedRequests)
    assert.equal(report.spentUsdc, firstHalf.spentUsdc)
    assert.equal(report.outputTokens >= firstHalf.outputTokens, true)
    // Whole hours are unchanged by pruning.
    assert.deepEqual(normalized(store.usageReport({ from: hour, to: hour + HOUR }, 'model')), normalized(wholeHour))
  } finally {
    store.close()
    cleanup()
  }
})

test('savings count each billed request once per model, and stray spend as a request of its own', () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir, () => BASE + HOUR)
  try {
    const { key } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    const startRequest = (tag: string, model: string | null) =>
      store.startRequest({ tag, keyId: key.id, buyerIdentity: 'default', method: 'POST', path: '/v1/responses', model, startedAt: BASE })
    const charge = (tag: string | null, ref: string, tokens: number) => store.recordLedgerEntry({
      kind: 'spend', keyId: key.id, buyerIdentity: 'default', amountUsdc: 100, externalRef: ref, requestTag: tag, createdAt: BASE + 5,
      inputTokens: tokens, outputTokens: tokens,
    })
    // Two spends for one request; spend before and after its response named the model served.
    startRequest('gw_a', 'm1')
    charge('gw_a', 'a1', 10)
    store.recordRequestOutcome('gw_a', { servedModel: 'm1-served' })
    store.finishRequest('gw_a', { status: 200, buyerRequestId: null })
    charge('gw_a', 'a2', 5)
    // A free request: no spend, the tokens its response reported.
    startRequest('gw_free', 'm2')
    store.finishRequest('gw_free', { status: 200, buyerRequestId: null })
    store.recordResponseUsage('gw_free', { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3 })
    // Its response reported tokens, then metered spend replaced them.
    startRequest('gw_metered', 'm2')
    store.finishRequest('gw_metered', { status: 200, buyerRequestId: null })
    store.recordResponseUsage('gw_metered', { inputTokens: 50, cachedInputTokens: 0, outputTokens: 50 })
    charge('gw_metered', 'm1', 4)
    // A failed request with no spend is not billed.
    startRequest('gw_failed', 'm2')
    store.finishRequest('gw_failed', { status: 500, buyerRequestId: null })
    // Spend naming no request counts as one, and two spends naming a request this log never had count once.
    store.recordLedgerEntry({ kind: 'spend', keyId: key.id, buyerIdentity: 'default', amountUsdc: 100, externalRef: 'stray', model: 'm2', createdAt: BASE + 9 })
    store.recordLedgerEntry({ kind: 'spend', keyId: key.id, buyerIdentity: 'default', amountUsdc: 50, externalRef: 'gone1', requestTag: 'gw_gone', model: 'm3', createdAt: BASE + 9 })
    store.recordLedgerEntry({ kind: 'spend', keyId: key.id, buyerIdentity: 'default', amountUsdc: 50, externalRef: 'gone2', requestTag: 'gw_gone', model: 'm3', createdAt: BASE + 9 })

    const byModel = Object.fromEntries(store.usageByModel(key.id).map((usage) => [usage.model, usage]))
    assert.deepEqual(byModel['m1-served'], { model: 'm1-served', amountUsdc: 200, inputTokens: 15, cachedInputTokens: 0, outputTokens: 15, requests: 1 })
    assert.deepEqual(byModel['m2'], { model: 'm2', amountUsdc: 200, inputTokens: 11, cachedInputTokens: 0, outputTokens: 7, requests: 3 })
    assert.deepEqual(byModel['m3'], { model: 'm3', amountUsdc: 100, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 1 })
    assert.deepEqual(Object.keys(byModel).sort(), ['m1-served', 'm2', 'm3'])
  } finally {
    store.close()
    cleanup()
  }
})

test('a gateway rolls up older usage in the background, then applies the retention it held back', async () => {
  const { dir, cleanup } = tempDir()
  try {
    let store = new GatewayStore(dir)
    const w = setUp(store, 41)
    run(store, w, 300, BASE)
    store.close()
    forgetRollup(dir)
    store = new GatewayStore(dir)
    store.setSetting(OBSERVABILITY_SETTING, { retentionDays: 1 })
    const logs: string[] = []
    const accounting = new GatewayAccounting(store, { holdUsdc: 300_000, settleGraceMs: 50 })
    const server = new GatewayServer({
      store, accounting, buyerPort: 1, topup: null, identityAddress: async () => null,
      spendFeedState: () => 'reporting', refreshSpendFeed: async () => {}, videoBudgetEnforced: () => true,
      onLog: (message) => logs.push(message),
    })
    await server.start()
    try {
      for (let wait = 0; wait < 300 && !logs.some((line) => /pruned \d+ request log row/.test(line)); wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(store.usageRollupReady(), true)
      assert.ok(logs.some((line) => line.includes('rolling up the usage recorded so far')), logs.join('\n'))
      assert.ok(logs.some((line) => line.includes('rolled up the usage recorded so far')), logs.join('\n'))
      assert.ok(logs.some((line) => /pruned \d+ request log row/.test(line)), logs.join('\n'))
      assert.equal(store.listRequests({}).length, 0, 'every request (dated 2026-01-05) is past one day of retention')
      assert.ok(store.usageReport({}, null).totals.requests > 0, 'and still counted')
    } finally {
      await server.stop()
      accounting.dispose()
      store.close()
    }
  } finally {
    cleanup()
  }
})
