import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthDb } from './auth/db.js'
import { recoveryTarget } from '../cli/commands/gateway/console-link.js'
import { FakeConsoleAuth, addActiveMember, call, startConsole, tempDataDir, testDeps } from './console-api/test-support.js'
import type { Enrollment } from './console-api/types.js'
import { consumeRecoveryToken, createRecoveryLink, RECOVERY_TTL_MS, registerRecoveryRoutes } from './console-recovery.js'

const LOCATION = { publicUrl: 'https://llm.example.com', port: 8379 }

async function harness() {
  const { dir, store, cleanup } = tempDataDir()
  let now = Date.now()
  const deps = testDeps(store, dir, { now: () => now })
  const server = await startConsole(deps, new FakeConsoleAuth(), [registerRecoveryRoutes])
  const recover = (token: unknown) => call(server.port, 'POST', '/console/api/auth/recover', { body: { token } })
  return {
    store,
    recover,
    advance: (ms: number) => { now += ms },
    now: () => now,
    close: async () => { await server.close(); cleanup() },
  }
}

const tokenOf = (url: string) => url.slice(url.indexOf('#') + 1)

test('a recovery link is single use and hands out an enrollment for that member', async () => {
  const h = await harness()
  try {
    const owner = h.store.createOwner({ label: 'Owner', email: 'owner@example.test' })
    const link = createRecoveryLink(h.store, LOCATION, owner.id, h.now)
    assert.match(link.url, /^https:\/\/llm\.example\.com\/console\/recover#[A-Za-z0-9_-]{20,}$/)
    assert.equal(link.expiresAt, h.now() + RECOVERY_TTL_MS)

    const stored = h.store.database.prepare('SELECT token_hash FROM console_recovery_tokens').all() as Array<{ token_hash: string }>
    assert.equal(stored.length, 1)
    assert.notEqual(stored[0]!.token_hash, tokenOf(link.url), 'only the hash is stored')

    const first = await h.recover(tokenOf(link.url))
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const enrollment = first.body as Enrollment
    assert.equal(enrollment.label, 'Owner')
    assert.equal(enrollment.orgRole, 'owner')
    assert.equal(new AuthDb(h.store.database, h.now).peekEnrollment(enrollment.enrollment), owner.id)

    const again = await h.recover(tokenOf(link.url))
    assert.equal(again.status, 400)
    assert.equal((again.body as { error: { code: string } }).error.code, 'invalid_token')

    const actions = h.store.listAudit({}).entries.map((row) => row.action)
    assert.ok(actions.includes('auth.recovery_link_create'))
    assert.ok(actions.includes('auth.recovery_claim'))
    assert.ok(actions.includes('auth.sign_in_failed'))
    assert.ok(!JSON.stringify(h.store.listAudit({}).entries).includes(tokenOf(link.url)), 'the token never reaches the audit log')
  } finally {
    await h.close()
  }
})

test('recovery links expire after an hour, and a new one replaces the unused old one', async () => {
  const h = await harness()
  try {
    const owner = h.store.createOwner({ label: 'Owner', email: null })
    const expired = createRecoveryLink(h.store, LOCATION, owner.id, h.now)
    h.advance(RECOVERY_TTL_MS + 1)
    assert.equal((await h.recover(tokenOf(expired.url))).status, 400)

    const older = createRecoveryLink(h.store, LOCATION, owner.id, h.now)
    const newer = createRecoveryLink(h.store, LOCATION, owner.id, h.now)
    assert.equal(consumeRecoveryToken(h.store.database, tokenOf(older.url), h.now()), null)
    assert.equal((await h.recover(tokenOf(newer.url))).status, 200)
  } finally {
    await h.close()
  }
})

test('recovery refuses disabled members, malformed tokens and floods', async () => {
  const h = await harness()
  try {
    h.store.createOwner({ label: 'Owner', email: null })
    const member = addActiveMember(h.store, 'Sam', { email: 'sam@example.test' })
    const link = createRecoveryLink(h.store, LOCATION, member.id, h.now)
    h.store.setMemberStatus(member.id, 'disabled')
    assert.equal((await h.recover(tokenOf(link.url))).status, 400)
    assert.throws(() => createRecoveryLink(h.store, LOCATION, member.id, h.now), /not an active member/)

    assert.equal((await h.recover(42)).status, 400)
    assert.equal((await h.recover('x'.repeat(500))).status, 400)
    let limited = false
    for (let index = 0; index < 12; index += 1) if ((await h.recover('nope')).status === 429) limited = true
    assert.ok(limited, 'repeated attempts are rate limited')
  } finally {
    await h.close()
  }
})

test('console-link --recover targets the only owner, or --member by id or email', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const owner = store.createOwner({ label: 'Owner', email: 'owner@example.test' })
    const sam = addActiveMember(store, 'Sam', { email: 'sam@example.test' })
    assert.equal(recoveryTarget(store, undefined).id, owner.id)
    assert.equal(recoveryTarget(store, 'SAM@example.test').id, sam.id)
    assert.equal(recoveryTarget(store, sam.id).id, sam.id)
    assert.throws(() => recoveryTarget(store, 'nobody@example.test'), /No active member/)
    addActiveMember(store, 'Second owner', { orgRole: 'owner', email: 'second@example.test' })
    assert.throws(() => recoveryTarget(store, undefined), /2 owners/)
  } finally {
    cleanup()
  }
})
