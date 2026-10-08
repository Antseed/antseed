import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { hashApiKey } from '../keys.js'
import { DEFAULT_WORKSPACE_ID, type GatewayStore } from '../store.js'
import { coreConsoleRegistrars } from './handlers/index.js'
import { csvCell } from '../services/usage.js'
import { FakeConsoleAuth, addActiveMember, call, memberPrincipal, startConsole, tempDataDir, testDeps } from './test-support.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

/**
 * An org with: owner, org admin, a workspace admin and a member of workspace
 * A, a member of workspace B only, a key session, and read/admin tokens.
 */
function seed(store: GatewayStore, auth: FakeConsoleAuth) {
  const owner = store.createOwner({ label: 'Owner', email: 'owner@example.test' })
  const add = (label: string, orgRole: 'admin' | 'member', workspaces: Array<{ workspaceId: string; role: 'admin' | 'member' }>) =>
    addActiveMember(store, label, { orgRole, workspaces, createdBy: owner.id })
  const wsA = store.createWorkspace({ name: 'Alpha', buyerIdentity: 'ws-alpha' })
  const wsB = store.createWorkspace({ name: 'Beta', buyerIdentity: 'ws-beta' })
  const admin = add('Admin', 'admin', [])
  const wsAdmin = add('Ws admin', 'member', [{ workspaceId: wsA.id, role: 'admin' }])
  const memberA = add('Member A', 'member', [{ workspaceId: wsA.id, role: 'member' }])
  const memberB = add('Member B', 'member', [{ workspaceId: wsB.id, role: 'member' }])
  const keyA = store.createKey({ label: 'A key', workspaceId: wsA.id, ownerMemberId: memberA.id, limits: NO_LIMITS, expiresAt: null })
  const keyOther = store.createKey({ label: 'Shared', workspaceId: wsA.id, limits: NO_LIMITS, expiresAt: null })
  for (const [name, member] of Object.entries({ owner, admin, wsAdmin, memberA, memberB })) auth.as(name, memberPrincipal(store, member.id))
  auth.as('keyholder', { kind: 'key', keyId: keyA.key.id, sessionId: 'ks' })
  auth.as('reader', { kind: 'token', tokenId: 'tok_r', scope: 'read' })
  auth.as('writer', { kind: 'token', tokenId: 'tok_w', scope: 'admin' })
  return { owner, admin, wsAdmin, memberA, memberB, wsA, wsB, keyA, keyOther }
}

async function harness() {
  const { dir, store, cleanup } = tempDataDir()
  const auth = new FakeConsoleAuth()
  const logs: string[] = []
  const org = seed(store, auth)
  const server = await startConsole(testDeps(store, dir, { log: (m) => logs.push(m) }), auth, coreConsoleRegistrars)
  const as = (who: string, method: string, path: string, body?: unknown) =>
    call(server.port, method, path.startsWith('/console') ? path : `/console/api${path}`, { who, body, bearer: who === 'reader' || who === 'writer' })
  return { dir, store, auth, org, as, logs, close: async () => { await server.close(); cleanup() } }
}

async function expectStatuses(as: (who: string, method: string, path: string, body?: unknown) => Promise<{ status: number }>, method: string, path: string, expected: Record<string, number>, body?: unknown) {
  for (const [who, status] of Object.entries(expected)) {
    const result = await as(who, method, path, body)
    assert.equal(result.status, status, `${who} ${method} ${path}: expected ${status}, got ${result.status} ${JSON.stringify((result as { body?: unknown }).body)}`)
  }
}

test('members and invites: who may see, invite, change and disable', async () => {
  const h = await harness()
  const { org, as } = h
  try {
    await expectStatuses(as, 'GET', '/members', { owner: 200, admin: 200, reader: 200, wsAdmin: 403, memberA: 403, keyholder: 403 })

    await expectStatuses(as, 'POST', '/invites', { wsAdmin: 403, memberA: 403 }, { label: 'X', orgRole: 'admin', workspaces: [] })
    await expectStatuses(as, 'POST', '/invites', { wsAdmin: 403, memberA: 403 }, { label: 'X', orgRole: 'member', workspaces: [{ workspaceId: org.wsB.id, role: 'member' }] })
    await expectStatuses(as, 'POST', '/invites', { admin: 403 }, { label: 'X', orgRole: 'owner', workspaces: [] })
    const invite = await as('wsAdmin', 'POST', '/invites', { label: 'New', orgRole: 'member', workspaces: [{ workspaceId: org.wsA.id, role: 'member' }] })
    assert.equal(invite.status, 201)
    const url = (invite.body as { url: string }).url
    assert.match(url, /^https:\/\/gateway\.example\.test\/console\/invite#[A-Za-z0-9_-]{43}$/)
    const token = url.split('#')[1]!
    assert.ok(!JSON.stringify(h.store.listInvites()).includes(token), 'only the hash is stored')
    assert.equal(h.store.peekInvite(hashApiKey(token), Date.now())?.member.label, 'New')

    // Workspace admins see their own invites; members see none.
    assert.equal(((await as('wsAdmin', 'GET', '/invites')).body as unknown[]).length, 1)
    assert.equal(((await as('memberA', 'GET', '/invites')).body as unknown[]).length, 0)
    const inviteId = (invite.body as { id: string }).id
    await expectStatuses(as, 'DELETE', `/invites/${inviteId}`, { memberA: 403, wsAdmin: 204 })

    await expectStatuses(as, 'PATCH', `/members/${org.owner.id}`, { admin: 403, wsAdmin: 403 }, { label: 'Renamed' })
    await expectStatuses(as, 'PATCH', `/members/${org.owner.id}`, { owner: 409 }, { orgRole: 'member' })
    await expectStatuses(as, 'PATCH', `/members/${org.memberA.id}`, { admin: 200 }, { maxKeys: 1, limits: { weekly: '5' } })
    assert.equal(h.store.getMember(org.memberA.id)!.limits.weekly, 5_000_000)
    await expectStatuses(as, 'PATCH', `/members/${org.memberA.id}`, { admin: 400 }, { routingPolicy: { sort: 'fastest' } })

    await expectStatuses(as, 'POST', `/members/${org.owner.id}/disable`, { owner: 409, admin: 403 })
    await expectStatuses(as, 'POST', `/members/${org.memberA.id}/disable`, { wsAdmin: 403, memberA: 403, admin: 200 })
    assert.equal(h.store.getKey(org.keyA.key.id)!.status, 'revoked', 'disabling revokes the member\'s keys')
    assert.equal(h.store.getKey(org.keyOther.key.id)!.status, 'active')
    assert.deepEqual(h.auth.revokedMembers, [org.memberA.id])
    assert.deepEqual(h.auth.revokedKeys, [org.keyA.key.id])
    // A disabled member's session no longer counts, whatever it claims.
    assert.equal((await as('memberA', 'GET', '/workspaces')).status, 401)
    await expectStatuses(as, 'POST', `/members/${org.memberA.id}/enable`, { admin: 200 })
  } finally {
    await h.close()
  }
})

test('workspaces: visibility, creation with a new wallet, budgets and membership', async () => {
  const h = await harness()
  const { org, as } = h
  try {
    const visible = async (who: string) => ((await as(who, 'GET', '/workspaces')).body as Array<{ id: string }>).map((ws) => ws.id).sort()
    assert.deepEqual(await visible('memberB'), [org.wsB.id])
    assert.deepEqual(await visible('memberA'), [org.wsA.id])
    assert.equal((await visible('owner')).length, 3)
    await expectStatuses(as, 'GET', `/workspaces/${org.wsA.id}`, { memberA: 200, memberB: 403, admin: 200, reader: 200, keyholder: 403 })
    await expectStatuses(as, 'GET', '/workspaces/ws_missing', { admin: 404 })

    await expectStatuses(as, 'POST', '/workspaces', { wsAdmin: 403, memberA: 403, reader: 403 }, { name: 'Nope' })
    const created = await as('admin', 'POST', '/workspaces', { name: 'Research Team!', limits: { monthly: '100' }, routingPolicy: { minTrustScore: 50 } })
    assert.equal(created.status, 201)
    const workspace = created.body as { id: string; buyerIdentity: string; walletAddress: string; limits: { monthly: string } }
    assert.equal(workspace.buyerIdentity, 'ws-research-team')
    assert.match(workspace.walletAddress, /^0x[0-9a-fA-F]{40}$/)
    assert.equal(workspace.limits.monthly, '100.000000')
    assert.equal(h.store.getWorkspace(workspace.id)!.walletAddress, workspace.walletAddress)
    assert.equal(h.store.memberWorkspaceRoles(org.admin.id).get(workspace.id), 'admin')
    const second = await as('admin', 'POST', '/workspaces', { name: 'Research team' })
    assert.equal((second.body as { buyerIdentity: string }).buyerIdentity, 'ws-research-team-2')

    await expectStatuses(as, 'PATCH', `/workspaces/${org.wsA.id}`, { memberA: 403, memberB: 403, wsAdmin: 200 }, { name: 'Alpha 2' })
    await expectStatuses(as, 'PATCH', `/workspaces/${org.wsA.id}`, { wsAdmin: 403, admin: 200 }, { limits: { daily: '1' } })
    await expectStatuses(as, 'PATCH', `/workspaces/${org.wsA.id}`, { admin: 400 }, { buyerIdentity: 'other' })

    await expectStatuses(as, 'GET', `/workspaces/${org.wsA.id}/members`, { memberA: 200, memberB: 403 })
    await expectStatuses(as, 'PUT', `/workspaces/${org.wsA.id}/members/${org.memberB.id}`, { memberA: 403, wsAdmin: 204 }, { role: 'member' })
    assert.equal(h.store.memberWorkspaceRoles(org.memberB.id).get(org.wsA.id), 'member')
    await expectStatuses(as, 'DELETE', `/workspaces/${org.wsA.id}/members/${org.memberA.id}`, { memberB: 403, wsAdmin: 204 })
    assert.equal(h.store.getKey(org.keyA.key.id)!.status, 'revoked', 'removing a member revokes their keys there')

    await expectStatuses(as, 'DELETE', `/workspaces/${DEFAULT_WORKSPACE_ID}`, { admin: 409 })
    await expectStatuses(as, 'DELETE', `/workspaces/${org.wsA.id}`, { wsAdmin: 403, admin: 409 })
    // The buyer is not reachable in tests, so a wallet balance cannot be ruled out.
    const emptyResult = await as('admin', 'DELETE', `/workspaces/${org.wsB.id}`)
    assert.equal(emptyResult.status, 409)
    assert.equal((emptyResult.body as { error: { code: string } }).error.code, 'balance_unknown')
  } finally {
    await h.close()
  }
})

test('keys: self-service within maxKeys, admin powers, rotation and key sessions', async () => {
  const h = await harness()
  const { org, as } = h
  try {
    const listed = async (who: string) => ((await as(who, 'GET', '/keys')).body as Array<{ id: string }>).map((key) => key.id).sort()
    assert.deepEqual(await listed('memberA'), [org.keyA.key.id])
    assert.deepEqual(await listed('wsAdmin'), [org.keyA.key.id, org.keyOther.key.id].sort())
    assert.deepEqual(await listed('keyholder'), [org.keyA.key.id])
    assert.deepEqual(await listed('memberB'), [])

    h.store.updateMember(org.memberA.id, { maxKeys: 2 })
    const created = await as('memberA', 'POST', '/keys', { label: 'Laptop', workspaceId: org.wsA.id, limits: { weekly: '2' } })
    assert.equal(created.status, 201)
    const { key, secret } = created.body as { key: { id: string; ownerMemberId: string; limits: { weekly: string | null }; ownerLimits: { weekly: string } }; secret: string }
    assert.equal(key.ownerMemberId, org.memberA.id)
    // A member's own caps go to the owner layer, which they can change later.
    assert.equal(key.ownerLimits.weekly, '2.000000')
    assert.equal(key.limits.weekly, null)
    assert.equal(h.store.findKeyBySecret(secret)?.id, key.id)
    await expectStatuses(as, 'POST', '/keys', { memberA: 409 }, { label: 'Third', workspaceId: org.wsA.id })
    await expectStatuses(as, 'POST', '/keys', { memberA: 403, keyholder: 403 }, { label: 'B', workspaceId: org.wsB.id })
    await expectStatuses(as, 'POST', '/keys', { memberB: 403 }, { label: 'x', workspaceId: org.wsA.id, topupEnabled: true })
    await expectStatuses(as, 'POST', '/keys', { wsAdmin: 201 }, { label: 'For A', workspaceId: org.wsA.id, ownerMemberId: org.memberA.id, topupEnabled: true })
    await expectStatuses(as, 'POST', '/keys', { wsAdmin: 400 }, { label: 'For B', workspaceId: org.wsA.id, ownerMemberId: org.memberB.id })
    await expectStatuses(as, 'POST', '/keys', { admin: 400 }, { label: 'x', workspaceId: DEFAULT_WORKSPACE_ID, topupEnabled: true })

    await expectStatuses(as, 'PATCH', `/keys/${key.id}`, { memberB: 404, keyholder: 403, memberA: 200 }, { label: 'Laptop 2' })
    await expectStatuses(as, 'PATCH', `/keys/${key.id}`, { memberA: 403 }, { topupEnabled: true })
    await expectStatuses(as, 'PATCH', `/keys/${key.id}`, { memberA: 400 }, { workspaceId: org.wsB.id })
    await expectStatuses(as, 'PATCH', `/keys/${org.keyOther.key.id}`, { memberA: 404, wsAdmin: 200 }, { routingPolicy: { allowedModels: ['m'] } })

    const rotated = await as('memberA', 'POST', `/keys/${key.id}/rotate`)
    assert.equal(rotated.status, 200)
    const next = rotated.body as { key: { id: string }; secret: string }
    assert.equal(next.key.id, key.id, 'rotation keeps the key id')
    assert.equal(h.store.findKeyBySecret(secret), null, 'the old secret stops working')
    assert.equal(h.store.findKeyBySecret(next.secret)?.id, key.id)
    assert.ok(h.auth.revokedKeys.includes(key.id))

    await expectStatuses(as, 'POST', `/keys/${org.keyOther.key.id}/revoke`, { memberA: 404, keyholder: 403, wsAdmin: 200 })
    await expectStatuses(as, 'POST', `/keys/${org.keyOther.key.id}/rotate`, { wsAdmin: 409 })
  } finally {
    await h.close()
  }
})

test('management tokens are minted by signed-in org admins only', async () => {
  const h = await harness()
  const { as } = h
  try {
    await expectStatuses(as, 'GET', '/admin-tokens', { reader: 403, writer: 403, wsAdmin: 403, admin: 200 })
    const created = await as('admin', 'POST', '/admin-tokens', { label: 'CI', scope: 'read' })
    assert.equal(created.status, 201)
    const { token, secret } = created.body as { token: { id: string; scope: string }; secret: string }
    assert.match(secret, /^antseed_admin_/)
    assert.equal(h.store.findAdminTokenBySecret(secret)?.id, token.id)
    await expectStatuses(as, 'POST', '/admin-tokens', { admin: 400 }, { label: 'x', scope: 'root' })
    await expectStatuses(as, 'DELETE', `/admin-tokens/${token.id}`, { wsAdmin: 403, owner: 204 })
    assert.equal(h.store.findAdminTokenBySecret(secret), null)
  } finally {
    await h.close()
  }
})

test('usage, request log and CSV export are limited to what the caller may see', async () => {
  const h = await harness()
  const { org, as, store } = h
  try {
    const now = Date.now()
    const record = (tag: string, keyId: string, amount: number, extra: { model?: string; endUser?: string; peer?: string } = {}) => {
      store.startRequest({ tag, keyId, buyerIdentity: 'x', method: 'POST', path: '/v1/responses', model: extra.model ?? 'm1', startedAt: now - 1_000, endUser: extra.endUser ?? null })
      store.finishRequest(tag, { status: 200, buyerRequestId: null })
      store.recordRequestOutcome(tag, { sellerPeerId: extra.peer ?? 'aa', latencyMs: 100 })
      store.recordLedgerEntry({ kind: 'spend', keyId, buyerIdentity: 'x', amountUsdc: amount, externalRef: `ref-${tag}`, requestTag: tag, sellerPeerId: extra.peer ?? 'aa', inputTokens: 10, outputTokens: 2, createdAt: now - 900 })
    }
    record('gw_a1', org.keyA.key.id, 100_000, { endUser: '=HYPERLINK("x")' })
    record('gw_a2', org.keyA.key.id, 50_000, { model: 'm2' })
    record('gw_o1', org.keyOther.key.id, 300_000, { peer: 'bb' })

    const total = async (who: string, query = '') => ((await as(who, 'GET', `/usage${query}`)).body as { totals: { spent: string; requests: number } }).totals
    assert.deepEqual(await total('owner'), { ...(await total('owner')), spent: '0.450000', requests: 3 })
    assert.equal((await total('memberA')).spent, '0.150000', 'a member sees their own keys')
    assert.equal((await total('wsAdmin')).spent, '0.450000', 'a workspace admin sees the workspace')
    assert.equal((await total('keyholder')).requests, 2)
    assert.equal((await total('memberB')).requests, 0)
    await expectStatuses(as, 'GET', `/usage?workspace=${org.wsA.id}`, { memberB: 403, memberA: 200 })

    const byModel = (await as('owner', 'GET', '/usage?groupBy=model')).body as { groups: Array<{ group: string; spent: string }> }
    assert.deepEqual(byModel.groups.map((g) => [g.group, g.spent]), [['m1', '0.400000'], ['m2', '0.050000']])
    const byKey = (await as('owner', 'GET', '/usage?groupBy=key')).body as { groups: Array<{ label: string }> }
    assert.deepEqual(byKey.groups.map((g) => g.label), ['Shared', 'A key'])
    for (const groupBy of ['day', 'member', 'peer', 'workspace', 'user']) {
      assert.equal((await as('owner', 'GET', `/usage?groupBy=${groupBy}`)).status, 200)
    }
    assert.equal((await as('owner', 'GET', '/usage?groupBy=planet')).status, 400)
    const byDay = (await as('owner', 'GET', '/usage?groupBy=day')).body as { groups: Array<{ group: string }> }
    assert.deepEqual(byDay.groups.map((g) => g.group), [new Date(now - 900).toISOString().slice(0, 10)])
    const ok = (await as('owner', 'GET', '/requests?status=success')).body as { requests: unknown[] }
    assert.equal(ok.requests.length, 3)
    assert.equal(((await as('owner', 'GET', '/requests?status=error')).body as { requests: unknown[] }).requests.length, 0)
    assert.equal((await as('owner', 'GET', '/requests?status=meh')).status, 400)

    const page1 = (await as('owner', 'GET', '/requests?limit=2')).body as { requests: Array<{ tag: string; spent: string }>; nextBefore: string | null }
    assert.equal(page1.requests.length, 2)
    assert.equal(typeof page1.nextBefore, 'string')
    // All three rows share a start time: the compound cursor still pages past them exactly once.
    const page2 = (await as('owner', 'GET', `/requests?limit=2&before=${page1.nextBefore}`)).body as { requests: Array<{ tag: string }>; nextBefore: string | null }
    assert.deepEqual([...page1.requests, ...page2.requests].map((r) => r.tag).sort(), ['gw_a1', 'gw_a2', 'gw_o1'])
    assert.equal(page2.nextBefore, null)
    const mine = (await as('keyholder', 'GET', '/requests')).body as { requests: Array<{ keyId: string; spent: string; sellerPeerId: string }> }
    assert.ok(mine.requests.every((r) => r.keyId === org.keyA.key.id))
    assert.equal(mine.requests.length, 2)

    const csv = await as('keyholder', 'GET', '/usage/export.csv')
    assert.equal(csv.status, 200)
    assert.match(csv.headers['content-type'] as string, /text\/csv/)
    assert.match(csv.headers['content-disposition'] as string, /attachment/)
    const lines = csv.text.trim().split('\r\n')
    assert.equal(lines.length, 3)
    assert.ok(lines[0]!.startsWith('tag,startedAt'))
    assert.ok(!csv.text.includes('gw_o1'))
    assert.ok(csv.text.includes(`"'=HYPERLINK(""x"")"`), 'formula cells are neutralised')
    assert.equal(csvCell('a,b'), '"a,b"')
    assert.equal(csvCell(-5), '-5')
  } finally {
    await h.close()
  }
})

test('peer lists, presets, routing default, settings and status', async () => {
  const h = await harness()
  const { org, as, store } = h
  try {
    await expectStatuses(as, 'GET', '/peer-lists', { memberA: 200, keyholder: 403 })
    await expectStatuses(as, 'POST', '/peer-lists', { memberA: 403, reader: 403 }, { name: 'Trusted', peerIds: ['0xAB'] })
    const list = await as('admin', 'POST', '/peer-lists', { name: 'Trusted', peerIds: ['0xAB', 'ab', 'CD'] })
    assert.equal(list.status, 201)
    assert.deepEqual((list.body as { peerIds: string[] }).peerIds, ['ab', 'cd'])
    await expectStatuses(as, 'POST', '/peer-lists', { admin: 400 }, { name: 'Bad', peerIds: ['not hex!'] })
    const listId = (list.body as { id: string }).id
    await expectStatuses(as, 'PATCH', `/peer-lists/${listId}`, { memberA: 403, admin: 200 }, { name: 'Trusted 2' })
    await expectStatuses(as, 'DELETE', `/peer-lists/${listId}`, { admin: 204 })

    const presetBody = { slug: 'fast', name: 'Fast', workspaceId: org.wsA.id, model: 'm1', systemPrompt: 'Short.', params: { temperature: 0, model: 'ignored' } }
    await expectStatuses(as, 'POST', '/presets', { memberA: 403, memberB: 403 }, presetBody)
    const preset = await as('wsAdmin', 'POST', '/presets', presetBody)
    assert.equal(preset.status, 201)
    assert.deepEqual((preset.body as { params: unknown }).params, { temperature: 0 })
    await expectStatuses(as, 'POST', '/presets', { wsAdmin: 409 }, presetBody)
    await expectStatuses(as, 'POST', '/presets', { wsAdmin: 403, admin: 201 }, { ...presetBody, workspaceId: null })
    await expectStatuses(as, 'POST', '/presets', { admin: 400 }, { ...presetBody, slug: 'Bad Slug' })
    await expectStatuses(as, 'POST', '/presets', { admin: 400 }, { ...presetBody, slug: 'loop', model: '@preset/fast' })
    const seenBy = async (who: string) => ((await as(who, 'GET', '/presets')).body as Array<{ workspaceId: string | null }>).length
    assert.equal(await seenBy('memberA'), 2)
    assert.equal(await seenBy('memberB'), 1, 'only the org-wide preset')
    const presetId = (preset.body as { id: string }).id
    await expectStatuses(as, 'PATCH', `/presets/${presetId}`, { memberA: 403, wsAdmin: 200 }, { model: 'm2' })
    await expectStatuses(as, 'DELETE', `/presets/${presetId}`, { memberB: 403, wsAdmin: 204 })

    await expectStatuses(as, 'GET', '/routing', { memberA: 200, keyholder: 403 })
    await expectStatuses(as, 'PUT', '/routing', { memberA: 403, wsAdmin: 403, reader: 403, admin: 400 }, { sort: 'nope' })
    const put = await as('writer', 'PUT', '/routing', { blockedPeerIds: ['0xEE'], sort: 'price' })
    assert.equal(put.status, 200)
    assert.deepEqual((await as('memberA', 'GET', '/routing')).body, { blockedPeerIds: ['ee'], sort: 'price' })

    await expectStatuses(as, 'GET', '/settings', { memberA: 403, keyholder: 403, admin: 200, reader: 200 })
    const settings = (await as('admin', 'GET', '/settings')).body as { observability: { logContent: boolean }; auth: { setupRequired: boolean } }
    assert.equal(settings.observability.logContent, false)
    assert.equal(settings.auth.setupRequired, false)
    await expectStatuses(as, 'PUT', '/settings/observability', { admin: 400 }, { otlpEndpoint: 'ftp://x', otlpHeaders: {}, logContent: false, retentionDays: null })
    await expectStatuses(as, 'PUT', '/settings/observability', { memberA: 403, admin: 200 }, { otlpEndpoint: 'https://otel.example.test', otlpHeaders: { authorization: 'Bearer t' }, logContent: true, retentionDays: 30 })
    assert.equal(store.getSetting<{ retentionDays: number }>('observability')?.retentionDays, 30)

    await expectStatuses(as, 'PATCH', '/settings/buyer', { memberA: 403, admin: 400 }, { minPeerReputation: 101 })
    const patched = await as('admin', 'PATCH', '/settings/buyer', { minPeerReputation: 40, maxPricing: { inputUsdPerMillion: 3 } })
    assert.equal(patched.status, 200)
    const written = JSON.parse(readFileSync(`${h.dir}/config.json`, 'utf8'))
    assert.equal(written.buyer.minPeerReputation, 40)
    assert.equal(written.buyer.maxPricing.defaults.inputUsdPerMillion, 3)
    assert.ok(h.logs.some((line) => line.includes('restart')), 'the buyer is asked to restart')

    const status = await as('keyholder', 'GET', '/status')
    assert.equal(status.status, 200)
    assert.deepEqual((status.body as { buyer: { reachable: boolean } }).buyer.reachable, false)
    assert.equal((status.body as { version: string }).version, '0.0.0-test')
  } finally {
    await h.close()
  }
})
