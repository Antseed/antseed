import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hashApiKey } from './keys.js'
import { MIGRATIONS } from './store-migrations.js'
import { GatewayStore } from './store.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-gateway-data-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A database as the gateway left it before the console (schema v2), with one request and its spend. */
function createV2Database(dir: string): void {
  mkdirSync(join(dir, 'gateway'), { recursive: true })
  const db = new Database(join(dir, 'gateway', 'gateway.db'))
  db.exec(MIGRATIONS[0]!)
  db.exec(MIGRATIONS[1]!)
  db.pragma('user_version = 2')
  db.prepare(`INSERT INTO api_keys (id, label, key_hash, key_hint, buyer_identity, source, created_at)
    VALUES ('key_team', 'Team', ?, 'antseed_…', 'team-a', 'created', 1)`).run(hashApiKey('antseed_team_secret_value'))
  db.prepare("INSERT INTO gateway_requests (tag, key_id, buyer_identity, method, path, model, started_at) VALUES ('gw_1', 'key_team', 'team-a', 'POST', '/v1/responses', 'm1', 5)").run()
  db.prepare(`INSERT INTO ledger_entries (kind, key_id, buyer_identity, amount_usdc, external_ref, request_tag, created_at)
    VALUES ('spend', 'key_team', 'team-a', -250000, 'spend:x:1', 'gw_1', 6)`).run()
  db.close()
}

function start(store: GatewayStore, tag: string, keyId: string, startedAt: number, extra: { model?: string; endUser?: string | null } = {}): void {
  store.startRequest({ tag, keyId, buyerIdentity: 'default', method: 'POST', path: '/v1/responses', model: extra.model ?? 'm1', startedAt, endUser: extra.endUser ?? null })
}

test('eighteen processes opening a v2 database at once migrate it exactly once', async () => {
  const { dir, cleanup } = tempDir()
  try {
    createV2Database(dir)
    const script = `
      const { GatewayStore } = await import(process.env.STORE_URL)
      const { AuthDb } = await import(process.env.AUTH_URL)
      while (Date.now() < Number(process.env.START_AT)) {}
      const store = new GatewayStore(process.env.DATA_DIR)
      new AuthDb(store.database, () => Date.now())
      store.close()
    `
    const env = {
      ...process.env,
      STORE_URL: new URL('./store.js', import.meta.url).href,
      AUTH_URL: new URL('./auth/db.js', import.meta.url).href,
      DATA_DIR: dir,
      // Every child starts migrating at the same instant, after all have loaded.
      START_AT: String(Date.now() + 3_000),
    }
    const runs = Array.from({ length: 18 }, () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('close', (code) => resolve({ code, stderr }))
    }))
    for (const result of await Promise.all(runs)) assert.equal(result.code, 0, result.stderr)

    const store = new GatewayStore(dir)
    try {
      assert.equal(store.database.pragma('user_version', { simple: true }), MIGRATIONS.length)
      assert.equal(MIGRATIONS.length, 3, 'the console schema is one migration on top of the two that shipped')
      assert.equal(store.spendByPeriod({ keyId: 'key_team' }).total, 250_000, 'rollups were backfilled once')
      assert.deepEqual(store.listWorkspaces().map((ws) => ws.buyerIdentity), ['default', 'team-a'])
      assert.equal((store.database.prepare('SELECT COUNT(*) AS n FROM auth_schema_version').get() as { n: number }).n, 1)
    } finally {
      store.close()
    }
  } finally {
    cleanup()
  }
})

test('migration v3 attributes existing ledger rows to the workspace of their request', () => {
  const { dir, cleanup } = tempDir()
  try {
    createV2Database(dir)
    const store = new GatewayStore(dir)
    try {
      const row = store.database.prepare("SELECT workspace_id, member_id, model FROM ledger_entries WHERE external_ref = 'spend:x:1'").get()
      assert.deepEqual(row, { workspace_id: 'ws_team-a', member_id: null, model: 'm1' })
      assert.equal(store.spendByPeriod({ workspaceId: 'ws_team-a' }).total, 250_000)
    } finally {
      store.close()
    }
  } finally {
    cleanup()
  }
})

test('the gateway directory and database files are owner-only', { skip: process.platform === 'win32' }, () => {
  const { dir, cleanup } = tempDir()
  try {
    const store = new GatewayStore(dir)
    try {
      store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
      assert.equal(statSync(join(dir, 'gateway')).mode & 0o777, 0o700)
      assert.equal(statSync(join(dir, 'gateway', 'gateway.db')).mode & 0o777, 0o600)
      assert.equal(statSync(join(dir, 'gateway', 'gateway.db-wal')).mode & 0o777, 0o600)
    } finally {
      store.close()
    }
  } finally {
    cleanup()
  }
})

test('spend stays with the workspace and member it was spent under when the key moves', () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir)
  try {
    const owner = store.createOwner({ label: 'O', email: null })
    const a = store.createWorkspace({ name: 'A', buyerIdentity: 'ws-a' })
    const b = store.createWorkspace({ name: 'B', buyerIdentity: 'ws-b' })
    const { key } = store.createKey({ label: 'k', workspaceId: a.id, ownerMemberId: owner.id, limits: NO_LIMITS, expiresAt: null })
    const now = Date.now()
    start(store, 'gw_1', key.id, now, { model: 'm1', endUser: 'u1' })
    store.recordLedgerEntry({ kind: 'spend', keyId: key.id, buyerIdentity: 'ws-a', amountUsdc: 100, externalRef: 'r1', requestTag: 'gw_1', createdAt: now })
    // The key changes hands and workspaces afterwards.
    store.updateKey(key.id, { ownerMemberId: null })
    store.database.prepare('UPDATE api_keys SET workspace_id = ? WHERE id = ?').run(b.id, key.id)
    store.recordLedgerEntry({ kind: 'spend', keyId: key.id, buyerIdentity: 'ws-b', amountUsdc: 40, externalRef: 'r2', createdAt: now })

    assert.equal(store.spendByPeriod({ workspaceId: a.id }).total, 100)
    assert.equal(store.spendByPeriod({ workspaceId: b.id }).total, 40)
    assert.equal(store.spendByPeriod({ memberId: owner.id }).daily, 100)
    assert.equal(store.spendByPeriod({ keyId: key.id }).total, 140)
    const byWorkspace = store.usageReport({}, 'workspace').groups.map((g) => [g.group, g.spentUsdc, g.requests])
    assert.deepEqual(byWorkspace, [[a.id, 100, 1], [b.id, 40, 0]])
    const byUser = store.usageReport({}, 'user').groups.map((g) => [g.group, g.spentUsdc])
    assert.deepEqual(byUser, [['u1', 100], [null, 40]])
    // Only the asked periods are summed.
    assert.deepEqual(store.spendByPeriod({ keyId: key.id }, now, ['monthly']), { daily: 0, weekly: 0, monthly: 140, total: 0 })
  } finally {
    store.close()
    cleanup()
  }
})

test('the request log pages by (startedAt, tag), searches, and reads bodies only for one request', () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir)
  try {
    const { key } = store.createKey({ label: 'Research bot', limits: NO_LIMITS, expiresAt: null })
    const { key: other } = store.createKey({ label: 'Other', limits: NO_LIMITS, expiresAt: null })
    // Seven requests in the same millisecond, then one later.
    for (let index = 0; index < 7; index += 1) start(store, `gw_${index}`, key.id, 1_000, { model: index === 3 ? 'open-model-x' : 'm1', endUser: index === 4 ? 'alice@example.test' : null })
    start(store, 'gw_later', other.id, 2_000)
    store.recordRequestOutcome('gw_later', { sellerPeerId: 'feedface' })
    store.recordRequestContent('gw_0', { requestBody: '{"in":1}', responseBody: '{"out":1}' })

    const seen: string[] = []
    let before: { startedAt: number; tag: string } | null = null
    for (let page = 0; page < 10; page += 1) {
      const rows = store.listRequests({ before, limit: 3 })
      if (rows.length === 0) break
      seen.push(...rows.map((row) => row.tag))
      before = { startedAt: rows.at(-1)!.startedAt, tag: rows.at(-1)!.tag }
    }
    assert.deepEqual(seen, ['gw_later', 'gw_6', 'gw_5', 'gw_4', 'gw_3', 'gw_2', 'gw_1', 'gw_0'])
    assert.equal('requestBody' in store.listRequests({})[0]!, false, 'listings never read bodies')

    const tags = (q: string) => store.listRequests({ q }).map((row) => row.tag)
    assert.deepEqual(tags('MODEL-X'), ['gw_3'])
    assert.deepEqual(tags('alice@'), ['gw_4'])
    assert.deepEqual(tags('feedf'), ['gw_later'])
    assert.equal(tags('research').length, 7, 'key label')
    assert.deepEqual(tags('gw_6'), ['gw_6'])
    assert.deepEqual(tags('%'), [], 'LIKE wildcards are literal')
    assert.deepEqual(store.listRequests({ from: 1_500 }).map((row) => row.tag), ['gw_later'])
    assert.equal(store.listRequests({ to: 1_500 }).length, 7)

    const detail = store.getRequest('gw_0')!
    assert.equal(detail.requestBody, '{"in":1}')
    assert.equal(detail.responseBody, '{"out":1}')
    assert.equal(store.getRequest('gw_0', [other.id]), null, 'outside the caller\'s keys')

    store.finishRequest('gw_1', { status: 429, buyerRequestId: null, error: { code: 'rate_limited', message: 'x'.repeat(900) } })
    const failed = store.getRequest('gw_1')!
    assert.equal(failed.errorCode, 'rate_limited')
    assert.equal(failed.errorMessage!.length, 500)
  } finally {
    store.close()
    cleanup()
  }
})

test('requests still in flight are not failures; pruning in chunks keeps request counts', async () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir)
  try {
    const { key } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    const base = Date.UTC(2026, 0, 5, 10)
    const statuses = [200, 200, 500, 502, null, 200]
    statuses.forEach((status, index) => {
      start(store, `gw_${index}`, key.id, base + index * 1_000, { model: index < 3 ? 'm1' : 'm2' })
      if (status !== null) store.finishRequest(`gw_${index}`, { status, buyerRequestId: null })
    })
    const totals = () => store.usageReport({ from: base - 3_600_000, to: base + 3_600_000 }, null).totals
    assert.deepEqual([totals().requests, totals().failedRequests], [6, 2])
    assert.deepEqual(store.listRequests({ status: 'error' }).map((row) => row.tag).sort(), ['gw_2', 'gw_3'])

    assert.equal(await store.pruneRequests(base + 10_000, 4), 6)
    assert.equal(store.listRequests({}).length, 0)
    assert.deepEqual([totals().requests, totals().failedRequests], [6, 2])
    assert.deepEqual(store.usageReport({}, 'model').groups.map((g) => [g.group, g.requests, g.failedRequests]).sort(), [['m1', 3, 1], ['m2', 3, 1]])
    assert.deepEqual(store.usageReport({}, 'day').groups.map((g) => [g.group, g.requests]), [['2026-01-05', 6]])
    assert.equal(store.usageStats(key.id).requests, 6)
    assert.equal(store.usageStats(key.id).failedRequests, 2)
    assert.equal(store.usageReport({ keyIds: [] }, null).totals.requests, 0, 'rollups honour the visibility scope')
  } finally {
    store.close()
    cleanup()
  }
})

test('a v1 database (before top-ups) upgrades straight to the current schema', () => {
  const { dir, cleanup } = tempDir()
  try {
    mkdirSync(join(dir, 'gateway'), { recursive: true })
    const db = new Database(join(dir, 'gateway', 'gateway.db'))
    db.exec(MIGRATIONS[0]!)
    db.pragma('user_version = 1')
    db.prepare(`INSERT INTO api_keys (id, label, key_hash, key_hint, buyer_identity, source, created_at)
      VALUES ('key_old', 'Old', ?, 'antseed_…', 'default', 'created', 1)`).run(hashApiKey('antseed_old_secret_value'))
    db.close()
    const store = new GatewayStore(dir)
    try {
      assert.equal(store.database.pragma('user_version', { simple: true }), MIGRATIONS.length)
      const key = store.getKey('key_old')!
      assert.equal(key.topupEnabled, false)
      assert.equal(key.workspaceId, 'ws_default')
      assert.deepEqual(key.ownerLimits, NO_LIMITS)
      assert.equal(key.ownerRoutingPolicy, null)
    } finally {
      store.close()
    }
  } finally {
    cleanup()
  }
})

test('spend rollups follow every ledger insert, per key, member and workspace, by UTC day', () => {
  const { dir, cleanup } = tempDir()
  const now = Date.UTC(2026, 9, 7, 12)
  const store = new GatewayStore(dir, () => now)
  try {
    const owner = store.createOwner({ label: 'O', email: null })
    const { key } = store.createKey({ label: 'k', ownerMemberId: owner.id, limits: { daily: null, monthly: null, total: null }, expiresAt: null })
    const spend = (ref: string, amount: number, at: number) => store.recordLedgerEntry({ kind: 'spend', keyId: key.id, buyerIdentity: 'default', amountUsdc: amount, externalRef: ref, createdAt: at })
    spend('a', 100, now)
    spend('b', 200, Date.UTC(2026, 9, 5, 1)) // Monday, this week
    spend('c', 400, Date.UTC(2026, 9, 1, 0)) // this month, last week
    spend('d', 800, Date.UTC(2026, 8, 30, 23, 59)) // last month
    assert.equal(spend('a', 100, now), false, 'a duplicate is not counted twice')
    store.recordLedgerEntry({ kind: 'credit', keyId: key.id, buyerIdentity: 'default', amountUsdc: 5_000, externalRef: 'top', createdAt: now })
    const expected = { daily: 100, weekly: 300, monthly: 700, total: 1_500 }
    for (const scope of [{ keyId: key.id }, { memberId: owner.id }, { workspaceId: key.workspaceId }]) {
      assert.deepEqual(store.spendByPeriod(scope, now), expected)
    }
    // Same as summing the ledger.
    const ledger = store.database.prepare("SELECT -SUM(amount_usdc) AS total FROM ledger_entries WHERE kind = 'spend' AND key_id = ?").get(key.id) as { total: number }
    assert.equal(ledger.total, expected.total)
    assert.deepEqual(store.spendByPeriod({ keyId: key.id }, now, ['daily']), { daily: 100, weekly: 0, monthly: 0, total: 0 })
  } finally {
    store.close()
    cleanup()
  }
})

test('last-used writes are throttled to once a minute and settings are cached until written', () => {
  const { dir, cleanup } = tempDir()
  let now = 1_000_000
  const store = new GatewayStore(dir, () => now)
  try {
    const { key } = store.createKey({ label: 'k', limits: { daily: null, monthly: null, total: null }, expiresAt: null })
    store.touchKey(key.id)
    assert.equal(store.getKey(key.id)!.lastUsedAt, 1_000_000)
    now += 30_000
    store.touchKey(key.id)
    assert.equal(store.getKey(key.id)!.lastUsedAt, 1_000_000, 'within a minute: no write')
    now += 31_000
    store.touchKey(key.id)
    assert.equal(store.getKey(key.id)!.lastUsedAt, 1_061_000)

    const { token } = store.createAdminToken({ label: 't', scope: 'read', createdBy: null })
    store.touchAdminToken(token.id)
    now += 1_000
    store.touchAdminToken(token.id)
    assert.equal(store.getAdminToken(token.id)!.lastUsedAt, 1_061_000)

    store.setSetting('observability', { logContent: true })
    assert.deepEqual(store.getSetting('observability'), { logContent: true })
    // Another process writing directly is seen once the cache expires; this store's own writes at once.
    store.database.prepare("UPDATE settings SET value = '{\"logContent\":false}' WHERE key = 'observability'").run()
    assert.deepEqual(store.getSetting('observability'), { logContent: true })
    store.setSetting('observability', { retentionDays: 3 })
    assert.deepEqual(store.getSetting('observability'), { retentionDays: 3 })
    const read = store.getSetting<{ retentionDays: number }>('observability')!
    read.retentionDays = 99
    assert.deepEqual(store.getSetting('observability'), { retentionDays: 3 }, 'callers get their own copy')
  } finally {
    store.close()
    cleanup()
  }
})
