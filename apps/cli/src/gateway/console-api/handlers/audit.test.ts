import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GatewayStore } from '../../store.js'
import { auditActor, requestIp } from '../access.js'
import { FakeConsoleAuth, addActiveMember, call, memberPrincipal, startConsole, tempDataDir, testDeps } from '../test-support.js'
import type { AuditEntry } from '../types.js'
import { coreConsoleRegistrars } from './index.js'
import { narrowedOwnerLimits } from '../../services/keys.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }
const DAY_MS = 24 * 60 * 60 * 1000

function seed(store: GatewayStore, auth: FakeConsoleAuth) {
  const owner = store.createOwner({ label: 'Owner', email: 'owner@example.test' })
  const add = (label: string, orgRole: 'admin' | 'member', workspaces: Array<{ workspaceId: string; role: 'admin' | 'member' }>) =>
    addActiveMember(store, label, { orgRole, workspaces, createdBy: owner.id })
  const wsA = store.createWorkspace({ name: 'Alpha', buyerIdentity: 'ws-alpha' })
  const admin = add('Admin', 'admin', [])
  const wsAdmin = add('Ws admin', 'member', [{ workspaceId: wsA.id, role: 'admin' }])
  const memberA = add('Member A', 'member', [{ workspaceId: wsA.id, role: 'member' }])
  const keyA = store.createKey({ label: 'A key', workspaceId: wsA.id, ownerMemberId: memberA.id, limits: NO_LIMITS, expiresAt: null })
  for (const [name, member] of Object.entries({ owner, admin, wsAdmin, memberA })) auth.as(name, memberPrincipal(store, member.id))
  auth.as('writer', { kind: 'token', tokenId: 'tok_w', scope: 'admin' })
  return { owner, admin, wsAdmin, memberA, wsA, keyA }
}

async function harness() {
  const { dir, store, cleanup } = tempDataDir()
  const auth = new FakeConsoleAuth()
  const org = seed(store, auth)
  const credentials = [{ id: 'cred_1', kind: 'passkey' as const, label: 'Laptop', createdAt: 1, lastUsedAt: null }]
  const server = await startConsole(testDeps(store, dir, { memberCredentials: () => credentials }), auth, coreConsoleRegistrars)
  const as = (who: string, method: string, path: string, body?: unknown) =>
    call(server.port, method, `/console/api${path}`, { who, body, bearer: who === 'writer' })
  const audit = (action?: string) => store.listAudit({ limit: 500, ...(action ? { action } : {}) }).entries
  return { store, auth, org, as, audit, close: async () => { await server.close(); cleanup() } }
}

test('store audit log: records, filters by verb prefix and pages newest first', () => {
  const { store, cleanup } = tempDataDir()
  try {
    store.recordAudit({ actor: { kind: 'cli', id: null }, action: 'key.create', target: { kind: 'key', id: 'k1' }, details: { a: 1 } })
    store.recordAudit({ actor: { kind: 'member', id: 'm1', label: 'M' }, action: 'key.revoke', target: { kind: 'key', id: 'k1', label: 'K' }, ip: '203.0.113.9' })
    store.recordAudit({ actor: { kind: 'member', id: 'm1' }, action: 'keyring.weird' })
    store.recordAudit({ actor: { kind: 'system', id: null }, action: 'auth.sign_in_failed', details: { method: 'wallet' } })

    const first = store.listAudit({ limit: 2 })
    assert.deepEqual(first.entries.map((entry) => entry.action), ['auth.sign_in_failed', 'keyring.weird'])
    assert.ok(first.nextBefore)
    const second = store.listAudit({ limit: 2, before: first.nextBefore })
    assert.deepEqual(second.entries.map((entry) => entry.action), ['key.revoke', 'key.create'])
    assert.equal(second.nextBefore, null)
    assert.deepEqual(second.entries[0]!.target, { kind: 'key', id: 'k1', label: 'K' })
    assert.equal(second.entries[0]!.ip, '203.0.113.9')
    assert.deepEqual(second.entries[1]!.actor, { kind: 'cli', id: null, label: null })
    assert.deepEqual(second.entries[1]!.details, { a: 1 })

    assert.deepEqual(store.listAudit({ action: 'key' }).entries.map((entry) => entry.action), ['key.revoke', 'key.create'])
    assert.deepEqual(store.listAudit({ actorId: 'm1' }).entries.length, 2)
  } finally {
    cleanup()
  }
})

test('GET /audit is for org admins and pages with an opaque cursor', async () => {
  const h = await harness()
  try {
    for (let index = 0; index < 3; index += 1) h.store.recordAudit({ actor: { kind: 'cli', id: null }, action: 'workspace.create' })
    for (const who of ['owner', 'admin', 'writer']) assert.equal((await h.as(who, 'GET', '/audit')).status, 200, who)
    for (const who of ['wsAdmin', 'memberA']) assert.equal((await h.as(who, 'GET', '/audit')).status, 403, who)
    const page = (await h.as('owner', 'GET', '/audit?limit=2')).body as { entries: AuditEntry[]; nextBefore: string | null }
    assert.equal(page.entries.length, 2)
    const rest = (await h.as('owner', 'GET', `/audit?limit=2&before=${page.nextBefore}`)).body as { entries: AuditEntry[]; nextBefore: string | null }
    assert.equal(rest.entries.length, 1)
    assert.equal(rest.nextBefore, null)
    assert.equal((await h.as('owner', 'GET', '/audit?before=abc')).status, 400)
    assert.equal((await h.as('owner', 'GET', '/audit?limit=0')).status, 400)
  } finally {
    await h.close()
  }
})

test('key actions are audited with the actor and without the secret', async () => {
  const h = await harness()
  try {
    const created = await h.as('memberA', 'POST', '/keys', { label: 'Mine', workspaceId: h.org.wsA.id })
    assert.equal(created.status, 201)
    const { key, secret } = created.body as { key: { id: string }; secret: string }
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${key.id}`, { label: 'Renamed' })).status, 200)
    const rotated = await h.as('memberA', 'POST', `/keys/${key.id}/rotate`)
    assert.equal((await h.as('wsAdmin', 'POST', `/keys/${key.id}/revoke`)).status, 200)

    const entries = h.audit('key')
    assert.deepEqual(entries.map((entry) => entry.action), ['key.revoke', 'key.rotate', 'key.update', 'key.create'])
    assert.deepEqual(entries[3]!.actor, { kind: 'member', id: h.org.memberA.id, label: 'Member A' })
    assert.deepEqual(entries[0]!.actor.id, h.org.wsAdmin.id)
    assert.deepEqual(entries[2]!.details, { changes: { label: { before: 'Mine', after: 'Renamed' } } })
    assert.equal(entries[3]!.ip, '127.0.0.1')
    const text = JSON.stringify(h.store.listAudit({ limit: 500 }))
    assert.ok(!text.includes(secret) && !text.includes((rotated.body as { secret: string }).secret), 'secrets never reach the audit log')
  } finally {
    await h.close()
  }
})

test('a key owner edits only the owner layer, which never gets past the admin layer; admins can do anything', async () => {
  const h = await harness()
  const id = h.org.keyA.key.id
  try {
    // The admin layer is off limits to the owner.
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { limits: { daily: '5' } })).status, 403)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { routingPolicy: { minTrustScore: 1 } })).status, 403)

    // The owner layer is theirs: tighten, loosen, clear.
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerLimits: { daily: '5' } })).status, 200)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerLimits: { daily: '4' } })).status, 200)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerLimits: { daily: '6' } })).status, 200)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerLimits: { daily: null } })).status, 200)
    assert.equal(h.store.getKey(id)!.ownerLimits.daily, null)

    // Under an admin cap, asking for more is answered 409 narrowed with the effective cap.
    assert.equal((await h.as('wsAdmin', 'PATCH', `/keys/${id}`, { limits: { daily: '3' } })).status, 200)
    const over = await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerLimits: { daily: '6' } })
    assert.equal(over.status, 409)
    const overBody = over.body as { error: { code: string; fields: string[]; effectiveLimits: { daily: string } } }
    assert.equal(overBody.error.code, 'narrowed')
    assert.deepEqual(overBody.error.fields, ['ownerLimits.daily'])
    assert.equal(overBody.error.effectiveLimits.daily, '3.000000')
    assert.equal(h.store.getKey(id)!.ownerLimits.daily, null, 'nothing stored')
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerLimits: { daily: '2' } })).status, 200)

    // Expiry: earlier only.
    const soon = Date.now() + DAY_MS
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { expiresAt: soon })).status, 200)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { expiresAt: soon + DAY_MS })).status, 403)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { expiresAt: null })).status, 403)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { expiresAt: soon - 1000 })).status, 200)

    // Policy: the owner's layer narrows the admins'; asking for more is 409.
    assert.equal((await h.as('wsAdmin', 'PATCH', `/keys/${id}`, { routingPolicy: { maxInputUsdPerMillion: 3, blockedPeerIds: ['aa'.repeat(20)] } })).status, 200)
    const widened = await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerRoutingPolicy: { maxInputUsdPerMillion: 50 } })
    assert.equal(widened.status, 409)
    const widenedBody = widened.body as { error: { fields: string[]; effectiveRoutingPolicy: { maxInputUsdPerMillion: number } } }
    assert.deepEqual(widenedBody.error.fields, ['ownerRoutingPolicy.maxInputUsdPerMillion'])
    assert.equal(widenedBody.error.effectiveRoutingPolicy.maxInputUsdPerMillion, 3)
    assert.equal(h.store.getKey(id)!.ownerRoutingPolicy, null)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerRoutingPolicy: { maxInputUsdPerMillion: 2 } })).status, 200)
    assert.equal((await h.as('memberA', 'PATCH', `/keys/${id}`, { ownerRoutingPolicy: null })).status, 200)
    assert.equal(h.store.getKey(id)!.routingPolicy?.maxInputUsdPerMillion, 3, 'the admin layer is untouched')
    assert.deepEqual(h.store.getKey(id)!.routingPolicy?.blockedPeerIds, ['aa'.repeat(20)])

    // Admins raise, clear and extend freely.
    assert.equal((await h.as('wsAdmin', 'PATCH', `/keys/${id}`, { limits: { daily: null }, expiresAt: null, routingPolicy: null })).status, 200)
    assert.equal(h.store.getKey(id)!.limits.daily, null)
    assert.equal(h.store.getKey(id)!.routingPolicy, null)
  } finally {
    await h.close()
  }
})

test('owner-layer caps above the admin layer are reported per period', () => {
  const admin = { daily: 10, weekly: null, monthly: 50, total: null }
  assert.deepEqual(narrowedOwnerLimits(admin, { daily: 5, weekly: 7 }), [])
  assert.deepEqual(narrowedOwnerLimits(admin, { daily: 11, monthly: 51 }), ['ownerLimits.daily', 'ownerLimits.monthly'])
  assert.deepEqual(narrowedOwnerLimits(admin, { daily: null, monthly: null }), [], 'no owner cap leaves the admin cap')
})

test('workspace policies: org admins set orgRoutingPolicy, workspace admins their own; changes are audited', async () => {
  const h = await harness()
  const path = `/workspaces/${h.org.wsA.id}`
  try {
    assert.equal((await h.as('wsAdmin', 'PATCH', path, { orgRoutingPolicy: { requireTee: true } })).status, 403)
    const set = await h.as('admin', 'PATCH', path, { orgRoutingPolicy: { requireTee: true } })
    assert.equal(set.status, 200)
    assert.deepEqual((set.body as { orgRoutingPolicy: unknown }).orgRoutingPolicy, { requireTee: true })
    const own = await h.as('wsAdmin', 'PATCH', path, { routingPolicy: { minTrustScore: 10 } })
    assert.equal(own.status, 200)
    assert.deepEqual((own.body as { routingPolicy: unknown; orgRoutingPolicy: unknown }).orgRoutingPolicy, { requireTee: true })

    const entries = h.audit('workspace.policy')
    assert.equal(entries.length, 2)
    assert.deepEqual(entries[1]!.details, { orgRoutingPolicy: { before: null, after: { requireTee: true } } })
    assert.deepEqual(entries[0]!.details, { routingPolicy: { before: null, after: { minTrustScore: 10 } } })
    assert.equal((await h.as('wsAdmin', 'PATCH', path, { name: 'Alpha 2' })).status, 200)
    assert.deepEqual(h.audit('workspace.update')[0]!.details, { changes: { name: { before: 'Alpha', after: 'Alpha 2' } } })
  } finally {
    await h.close()
  }
})

test('workspace member list shows sign-in methods to workspace admins only', async () => {
  const h = await harness()
  try {
    type Row = { member: { credentials: unknown[] } }
    const asMember = (await h.as('memberA', 'GET', `/workspaces/${h.org.wsA.id}/members`)).body as Row[]
    assert.ok(asMember.length >= 2 && asMember.every((row) => row.member.credentials.length === 0))
    const asAdmin = (await h.as('wsAdmin', 'GET', `/workspaces/${h.org.wsA.id}/members`)).body as Row[]
    assert.ok(asAdmin.every((row) => row.member.credentials.length === 1))
  } finally {
    await h.close()
  }
})

test('management tokens expire by default, remember their creator and die with the creator\'s role', async () => {
  const h = await harness()
  try {
    const before = Date.now()
    const created = await h.as('admin', 'POST', '/admin-tokens', { label: 'CI', scope: 'admin' })
    assert.equal(created.status, 201)
    const token = (created.body as { token: { id: string; expiresAt: number; createdByMemberId: string } }).token
    assert.equal(token.createdByMemberId, h.org.admin.id)
    assert.ok(token.expiresAt >= before + 90 * DAY_MS && token.expiresAt <= Date.now() + 90 * DAY_MS)

    assert.equal((await h.as('admin', 'POST', '/admin-tokens', { label: 'x', expiresInDays: 366 })).status, 400)
    assert.equal((await h.as('admin', 'POST', '/admin-tokens', { label: 'x', expiresInDays: 0 })).status, 400)
    assert.equal((await h.as('admin', 'POST', '/admin-tokens', { label: 'x', expiresInDays: null })).status, 403)
    const forever = await h.as('owner', 'POST', '/admin-tokens', { label: 'forever', expiresInDays: null })
    assert.equal(forever.status, 201)
    assert.equal((forever.body as { token: { expiresAt: null } }).token.expiresAt, null)
    const short = (await h.as('admin', 'POST', '/admin-tokens', { label: 'short', expiresInDays: 7 })).body as { token: { expiresAt: number } }
    assert.ok(short.token.expiresAt <= Date.now() + 7 * DAY_MS)

    // Demoting the admin revokes the tokens they created.
    assert.equal((await h.as('owner', 'PATCH', `/members/${h.org.admin.id}`, { orgRole: 'member' })).status, 200)
    assert.deepEqual(h.store.listAdminTokens().map((entry) => entry.label), ['forever'])
    const demotion = h.audit('member.update')[0]!
    assert.equal((demotion.details['revokedTokens'] as string[]).length, 2)

    // Disabling a member revokes the tokens they created.
    const ownerToken = h.store.createAdminToken({ label: 'by admin2', scope: 'read', createdBy: h.org.wsAdmin.id })
    assert.equal((await h.as('owner', 'POST', `/members/${h.org.wsAdmin.id}/disable`)).status, 200)
    assert.equal(h.store.getAdminToken(ownerToken.token.id)!.revokedAt !== null, true)
    assert.deepEqual(h.audit('token').map((entry) => entry.action), ['token.create', 'token.create', 'token.create'])
  } finally {
    await h.close()
  }
})

test('auditActor and requestIp', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const owner = store.createOwner({ label: 'Owner', email: null })
    assert.deepEqual(auditActor(store, null), { kind: 'system', id: null, label: null })
    assert.deepEqual(auditActor(store, { kind: 'member', memberId: owner.id, orgRole: 'owner', workspaceRoles: new Map(), sessionId: 's' }), { kind: 'member', id: owner.id, label: 'Owner' })
    assert.deepEqual(auditActor(store, { kind: 'token', tokenId: 'tok_x', scope: 'read' }), { kind: 'token', id: 'tok_x', label: null })
    const raw = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => ({ raw: { headers, socket: { remoteAddress } } as never })
    assert.equal(requestIp(raw({ 'cf-connecting-ip': '198.51.100.7' })), '127.0.0.1', 'CF-Connecting-IP is ignored outside tunnel mode')
    assert.equal(requestIp(raw({ 'cf-connecting-ip': '198.51.100.7' }), { trustCloudflareHeaders: true }), '198.51.100.7')
    assert.equal(requestIp(raw({ 'x-forwarded-for': '10.0.0.1, 198.51.100.8' })), '198.51.100.8')
    assert.equal(requestIp(raw({ 'x-forwarded-for': '198.51.100.8' }, '203.0.113.5')), '203.0.113.5', 'forwarding headers only from a loopback proxy')
    assert.equal(requestIp({ raw: {} as never }), null)
  } finally {
    cleanup()
  }
})
