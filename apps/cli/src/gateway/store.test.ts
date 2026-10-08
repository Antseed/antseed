import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hashApiKey } from './keys.js'
import { findLimitBreach, periodResetsAt, periodStart } from './limits.js'
import { MIGRATIONS } from './store-migrations.js'
import { DEFAULT_WORKSPACE_ID, GatewayStore } from './store.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-gateway-store-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A database exactly as the gateway before the console left it (schema v2). */
function createV2Database(dir: string): void {
  mkdirSync(join(dir, 'gateway'), { recursive: true })
  const db = new Database(join(dir, 'gateway', 'gateway.db'))
  db.exec(MIGRATIONS[0]!)
  db.exec(MIGRATIONS[1]!)
  db.pragma('user_version = 2')
  const insert = db.prepare(`
    INSERT INTO api_keys (id, label, key_hash, key_hint, buyer_identity, source, daily_limit_usdc, created_at)
    VALUES (?, ?, ?, 'antseed_…', ?, 'created', ?, ?)
  `)
  insert.run('key_default', 'Owner', hashApiKey('antseed_owner_secret_value'), 'default', 1_000_000, 1)
  insert.run('key_team1', 'Team one', hashApiKey('antseed_team_secret_one'), 'team-a', null, 2)
  insert.run('key_team2', 'Team two', hashApiKey('antseed_team_secret_two'), 'team-a', null, 3)
  insert.run('key_other', 'Other', hashApiKey('antseed_other_secret_x'), 'other-b', null, 4)
  db.prepare("INSERT INTO gateway_requests (tag, key_id, buyer_identity, method, path, started_at) VALUES ('gw_1', 'key_team1', 'team-a', 'POST', '/v1/responses', 5)").run()
  db.prepare("INSERT INTO ledger_entries (kind, key_id, buyer_identity, amount_usdc, external_ref, created_at) VALUES ('spend', 'key_team1', 'team-a', -250000, 'spend:x:1', ?)").run(Date.now())
  db.close()
}

test('migrating a v2 database puts every key in a workspace paying with its identity', () => {
  const { dir, cleanup } = tempDir()
  try {
    createV2Database(dir)
    const store = new GatewayStore(dir)
    try {
      const workspaces = store.listWorkspaces()
      assert.deepEqual(workspaces.map((ws) => [ws.name, ws.buyerIdentity, ws.isDefault]), [
        ['Default', 'default', true],
        ['team-a', 'team-a', false],
        ['other-b', 'other-b', false],
      ])
      assert.equal(store.getKey('key_default')!.workspaceId, DEFAULT_WORKSPACE_ID)
      const team = store.workspaceForKey('key_team1')!
      assert.equal(team.buyerIdentity, 'team-a')
      assert.equal(store.workspaceForKey('key_team2')!.id, team.id)
      assert.equal(store.workspaceForKey('key_other')!.buyerIdentity, 'other-b')
      // Keys keep working, with their limits; weekly caps start empty.
      const owner = store.findKeyBySecret('antseed_owner_secret_value')!
      assert.deepEqual(owner.limits, { daily: 1_000_000, weekly: null, monthly: null, total: null })
      assert.equal(owner.ownerMemberId, null)
      // History moves with the key.
      assert.equal(store.listRequests({ workspaceId: team.id })[0]?.tag, 'gw_1')
      assert.equal(store.spendByPeriod({ workspaceId: team.id }).total, 250_000)
      assert.equal(store.isSetupComplete(), false)
    } finally {
      store.close()
    }
    // Re-opening does not migrate twice.
    const again = new GatewayStore(dir)
    assert.equal(again.listWorkspaces().length, 3)
    again.close()
  } finally {
    cleanup()
  }
})

test('a fresh store has only the Default workspace; CLI-style keys land in a workspace per identity', () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir)
  try {
    assert.deepEqual(store.listWorkspaces().map((ws) => ws.id), [DEFAULT_WORKSPACE_ID])
    const a = store.createKey({ label: 'A', buyerIdentity: 'team-x', limits: { daily: null, monthly: null, total: null }, expiresAt: null })
    const b = store.createKey({ label: 'B', buyerIdentity: 'team-x', limits: { daily: null, monthly: null, total: null }, expiresAt: null })
    assert.equal(a.key.workspaceId, b.key.workspaceId)
    assert.equal(store.getWorkspace(a.key.workspaceId)!.name, 'team-x')
    assert.throws(() => store.createKey({ label: 'C', buyerIdentity: 'other', workspaceId: a.key.workspaceId, limits: NO_LIMITS, expiresAt: null }))
    const env = store.syncEnvironmentKey('antseed_tunnel_env_key_123')
    assert.equal(env.workspaceId, DEFAULT_WORKSPACE_ID)
  } finally {
    store.close()
    cleanup()
  }
})

test('setup, invites and members', () => {
  const { dir, cleanup } = tempDir()
  let now = 1_000
  const store = new GatewayStore(dir, () => now)
  try {
    const owner = store.createOwner({ label: 'Olivia', email: 'olivia@example.test' })
    assert.equal(owner.orgRole, 'owner')
    assert.equal(store.isSetupComplete(), true)
    assert.throws(() => store.createOwner({ label: 'Again', email: null }))
    assert.equal(store.memberWorkspaceRoles(owner.id).get(DEFAULT_WORKSPACE_ID), 'admin')
    assert.equal(store.findMemberByEmail('OLIVIA@example.test')?.id, owner.id)

    const { invite, token } = store.createInvite({
      label: 'Max', email: 'max@example.test', orgRole: 'member',
      workspaces: [{ workspaceId: DEFAULT_WORKSPACE_ID, role: 'member' }], expiresAt: 5_000, createdBy: owner.id,
    })
    assert.equal(store.getMember(invite.memberId)!.status, 'invited')
    assert.equal(store.memberWorkspaceRoles(invite.memberId).get(DEFAULT_WORKSPACE_ID), 'member')
    assert.equal(store.consumeInvite(hashApiKey('wrong'), now), null)
    now = 6_000
    assert.equal(store.consumeInvite(hashApiKey(token), now), null, 'expired')
    now = 2_000
    const joined = store.consumeInvite(hashApiKey(token), now)!
    assert.equal(joined.status, 'active')
    assert.equal(store.consumeInvite(hashApiKey(token), now), null, 'single use')

    const second = store.createInvite({ label: 'Gone', email: null, orgRole: 'member', workspaces: [], expiresAt: 9_000, createdBy: null })
    assert.equal(store.deleteInvite(second.invite.id), true)
    assert.equal(store.getMember(second.invite.memberId), null)
  } finally {
    store.close()
    cleanup()
  }
})

test('weekly periods start Monday 00:00 UTC', () => {
  const wednesday = Date.UTC(2026, 9, 7, 15, 0)
  assert.equal(periodStart('weekly', wednesday), Date.UTC(2026, 9, 5))
  assert.equal(periodResetsAt('weekly', wednesday), Date.UTC(2026, 9, 12))
  const sunday = Date.UTC(2026, 9, 11, 23, 59)
  assert.equal(periodStart('weekly', sunday), Date.UTC(2026, 9, 5))
  const monday = Date.UTC(2026, 9, 12, 0, 0)
  assert.equal(periodStart('weekly', monday), monday)
  const breach = findLimitBreach({ daily: null, weekly: 1_000_000, monthly: null, total: null }, { daily: 0, weekly: 900_000, monthly: 0, total: 0 }, 200_000, wednesday)
  assert.equal(breach?.period, 'weekly')
  assert.equal(breach?.resetsAt, Date.UTC(2026, 9, 12))
})

test('spend aggregates per member and workspace over their keys', () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir)
  try {
    const owner = store.createOwner({ label: 'O', email: null })
    const ws = store.createWorkspace({ name: 'Research', buyerIdentity: 'ws-research' })
    const mine = store.createKey({ label: 'mine', workspaceId: ws.id, ownerMemberId: owner.id, limits: NO_LIMITS, expiresAt: null })
    const other = store.createKey({ label: 'other', workspaceId: ws.id, limits: NO_LIMITS, expiresAt: null })
    const elsewhere = store.createKey({ label: 'default', ownerMemberId: owner.id, limits: NO_LIMITS, expiresAt: null })
    const spend = (keyId: string, amount: number, ref: string) => store.recordLedgerEntry({
      kind: 'spend', keyId, buyerIdentity: 'x', amountUsdc: amount, externalRef: ref, createdAt: Date.now(),
    })
    spend(mine.key.id, 100, 'a')
    spend(other.key.id, 200, 'b')
    spend(elsewhere.key.id, 400, 'c')
    assert.equal(store.spendByPeriod({ workspaceId: ws.id }).weekly, 300)
    assert.equal(store.spendByPeriod({ memberId: owner.id }).daily, 500)
    assert.equal(store.spendByPeriod({ keyId: mine.key.id }).total, 100)
    assert.deepEqual(Object.keys(store.periodSpend(mine.key.id)).sort(), ['daily', 'monthly', 'total'])
  } finally {
    store.close()
    cleanup()
  }
})

test('request log records outcomes and content, prunes by age, and reports peer stats', async () => {
  const { dir, cleanup } = tempDir()
  const store = new GatewayStore(dir)
  try {
    const { key } = store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    for (const [index, latency] of [100, 300, 200].entries()) {
      store.startRequest({ tag: `gw_${index}`, keyId: key.id, buyerIdentity: 'default', method: 'POST', path: '/v1/responses', model: 'm', startedAt: 1_000 + index, endUser: index === 0 ? 'user-1' : null })
      store.recordRequestOutcome(`gw_${index}`, { sellerPeerId: 'aa11', latencyMs: latency })
    }
    store.recordRequestContent('gw_0', { requestBody: '{"in":1}', responseBody: '{"out":1}' })
    const rows = store.listRequests({})
    assert.equal(rows.length, 3)
    assert.equal(rows[2]!.endUser, 'user-1')
    assert.equal(store.getRequest(rows[2]!.tag)!.requestBody, '{"in":1}')
    assert.equal(rows[0]!.workspaceId, DEFAULT_WORKSPACE_ID)
    assert.deepEqual(store.peerStats(0), [{ peerId: 'aa11', requests: 3, latencyMsP50: 200 }])
    assert.equal(await store.pruneRequests(1_002), 2)
    assert.equal(store.listRequests({}).length, 1)
  } finally {
    store.close()
    cleanup()
  }
})
