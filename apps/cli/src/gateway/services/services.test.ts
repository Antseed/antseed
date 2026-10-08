import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach, describe } from 'node:test'
import type { BuyerClient } from '../console-api/handlers/network-buyer.js'
import { ConsoleError } from '../console-api/router.js'
import { hashApiKey } from '../keys.js'
import { addActiveMember } from '../console-api/test-support.js'
import { NO_BUDGET_LIMITS } from '../limits.js'
import { OBSERVABILITY_SETTING } from '../observability.js'
import { GatewayStore, type MemberRecord } from '../store.js'
import { listAuditEntries } from './audit.js'
import { CLI_ACTOR, PolicyProblemError, recordAudit, type ServiceContext } from './context.js'
import { createKey, revokeKey, rotateKey, updateKey } from './keys.js'
import { disableMember, inviteMember, removeCredential, updateMember, type CredentialStore } from './members.js'
import { listNetworkPeers, previewRoute } from './network.js'
import { createPeerList, deletePeerList, updatePeerList } from './peer-lists.js'
import { createPreset, findPreset, updatePreset } from './presets.js'
import { gatewayDefaultPolicy, setGatewayDefaultPolicy } from './routing.js'
import { patchConfigFile, readSettings, setObservabilitySettings, updateBuyerSettings } from './settings.js'
import { createAdminToken, revokeAdminToken, tokenExpiry } from './tokens.js'
import { csvCell, decodeCursor, encodeCursor, listRequestPage, requestCsvChunks, usageReport } from './usage.js'
import { createWorkspace, deleteWorkspace, removeWorkspaceMember, setWorkspaceMember, updateWorkspace } from './workspaces.js'

const PEER_A = 'aa'.repeat(20)
const PEER_B = 'bb'.repeat(20)

let dir: string
let store: GatewayStore
let ctx: ServiceContext
let revoked: { members: string[]; keys: string[] }
let logs: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'antseed-gateway-services-'))
  store = new GatewayStore(dir)
  revoked = { members: [], keys: [] }
  logs = []
  ctx = {
    store,
    dataDir: dir,
    now: () => Date.now(),
    log: (message) => logs.push(message),
    sessions: {
      revokeMemberSessions: (id) => { revoked.members.push(id) },
      revokeKeySessions: (id) => { revoked.keys.push(id) },
    },
  }
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function activeMember(label: string, workspaces: Array<{ workspaceId: string; role: 'admin' | 'member' }> = [], orgRole: 'owner' | 'admin' | 'member' = 'member'): MemberRecord {
  return addActiveMember(store, label, { orgRole, workspaces, email: `${label.toLowerCase()}@example.test` })
}

function lastAudit() {
  return listAuditEntries(store, { limit: 1 }).entries[0]!
}

async function rejectsWithCode(fn: () => unknown, code: string): Promise<ConsoleError> {
  let caught: unknown
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ConsoleError, `expected a ConsoleError ${code}, got ${String(caught)}`)
  assert.equal(caught.code, code)
  return caught
}

function fakeBuyer(routes: Record<string, (url: URL, init?: { method?: string; policy?: unknown }) => { status?: number; body: unknown }>): BuyerClient & { calls: string[] } {
  const calls: string[] = []
  const client = (async (path: string, init?: { method?: string; policy?: unknown }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    const url = new URL(path, 'http://buyer.test')
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`]
    const reply = route ? route(url, init) : { status: 404, body: { error: 'not found' } }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as BuyerClient & { calls: string[] }
  client.calls = calls
  return client
}

describe('context', () => {
  test('recordAudit records the actor and never throws', () => {
    recordAudit(ctx, CLI_ACTOR, 'thing.do', { kind: 'thing', id: 't1', label: 'T' }, { a: 1 })
    const entry = lastAudit()
    assert.deepEqual(entry.actor, { kind: 'cli', id: null, label: 'antseed CLI' })
    assert.equal(entry.action, 'thing.do')
    const warnings: string[] = []
    recordAudit({ store: { recordAudit: () => { throw new Error('disk full') } } as never, log: () => {}, warn: (m) => warnings.push(m) }, CLI_ACTOR, 'x')
    assert.match(warnings[0]!, /AUDIT WRITE FAILED for x: disk full/)
  })
})

describe('keys', () => {
  test('creates, updates, rotates and revokes keys with audit and session revocation', () => {
    const { key, secret } = createKey(ctx, CLI_ACTOR, { label: ' ci ', limits: { ...NO_BUDGET_LIMITS, daily: 5_000_000 } })
    assert.equal(key.label, 'ci')
    assert.equal(store.findKeyBySecret(secret)?.id, key.id)
    assert.equal(lastAudit().action, 'key.create')

    const updated = updateKey(ctx, CLI_ACTOR, key.id, { label: 'ci-2', ownerLimits: { daily: 1_000_000 } })
    assert.equal(updated.ownerLimits.daily, 1_000_000)
    assert.deepEqual(Object.keys((lastAudit().details['changes'] as object)), ['label', 'ownerLimits'])

    // An owner cap above the admin cap never applies: refused unless accepted.
    assert.throws(() => updateKey(ctx, CLI_ACTOR, key.id, { ownerLimits: { daily: 9_000_000 } }), PolicyProblemError)
    updateKey(ctx, CLI_ACTOR, key.id, { ownerLimits: { daily: 9_000_000 }, acceptNarrowed: true })

    const rotated = rotateKey(ctx, CLI_ACTOR, key.id)
    assert.notEqual(rotated.secret, secret)
    assert.equal(store.findKeyBySecret(secret), null)
    assert.deepEqual(revoked.keys, [key.id])

    revokeKey(ctx, CLI_ACTOR, key.id)
    assert.equal(store.getKey(key.id)!.status, 'revoked')
    assert.throws(() => rotateKey(ctx, CLI_ACTOR, key.id), (error: ConsoleError) => error.code === 'key_revoked')
    assert.throws(() => updateKey(ctx, CLI_ACTOR, 'key_missing', {}), (error: ConsoleError) => error.status === 404)
  })

  test('acting as owner: owner layer only, maxKeys, no top-ups, expiry only shortened', async () => {
    const workspace = await createWorkspace(ctx, CLI_ACTOR, { name: 'Team', buyerIdentity: 'default' })
    const member = activeMember('Ann', [{ workspaceId: workspace.id, role: 'member' }])
    updateMember(ctx, CLI_ACTOR, member.id, { maxKeys: 1 })
    const { key } = createKey(ctx, CLI_ACTOR, { label: 'mine', workspaceId: workspace.id, limits: { ...NO_BUDGET_LIMITS, daily: 2_000_000 } }, { as: 'owner', self: member.id })
    // What an owner sends is their own layer.
    assert.equal(key.limits.daily, null)
    assert.equal(key.ownerLimits.daily, 2_000_000)
    assert.equal(key.ownerMemberId, member.id)
    await rejectsWithCode(() => createKey(ctx, CLI_ACTOR, { label: 'second', workspaceId: workspace.id }, { as: 'owner', self: member.id }), 'max_keys_reached')
    await rejectsWithCode(() => updateKey(ctx, CLI_ACTOR, key.id, { limits: { daily: 1 } }, { as: 'owner' }), 'forbidden')
    await rejectsWithCode(() => updateKey(ctx, CLI_ACTOR, key.id, { topupEnabled: false }, { as: 'owner' }), 'forbidden')
    const withExpiry = updateKey(ctx, CLI_ACTOR, key.id, { expiresAt: Date.now() + 60_000 }, { as: 'owner' })
    await rejectsWithCode(() => updateKey(ctx, CLI_ACTOR, key.id, { expiresAt: withExpiry.expiresAt! + 1 }, { as: 'owner' }), 'forbidden')
    await rejectsWithCode(() => updateKey(ctx, CLI_ACTOR, key.id, { expiresAt: null }, { as: 'owner' }), 'forbidden')
    await rejectsWithCode(() => createKey(ctx, CLI_ACTOR, { label: 'x', workspaceId: workspace.id, topupEnabled: true }), 'invalid_request')
  })

  test('an owner policy outside the admin policy is narrowed; an empty allow list needs confirmation', () => {
    const list = createPeerList(ctx, CLI_ACTOR, { name: 'Good', peerIds: [PEER_A] })
    const { key } = createKey(ctx, CLI_ACTOR, { label: 'k', routingPolicy: { allowedPeerLists: [list.id] } })
    assert.throws(() => updateKey(ctx, CLI_ACTOR, key.id, { ownerRoutingPolicy: { allowedPeerIds: [PEER_B] } }), PolicyProblemError)
    try {
      updateKey(ctx, CLI_ACTOR, key.id, { ownerRoutingPolicy: { allowedPeerIds: [PEER_B] } })
    } catch (error) {
      assert.ok(error instanceof PolicyProblemError)
      assert.equal(error.code, 'empty_allow_list')
      assert.equal(error.status, 400)
    }
    updateKey(ctx, CLI_ACTOR, key.id, { ownerRoutingPolicy: { allowedPeerIds: [PEER_B] }, confirmEmpty: true, acceptNarrowed: true })
    assert.deepEqual(store.getKey(key.id)!.ownerRoutingPolicy, { allowedPeerIds: [PEER_B] })
  })
})

describe('members', () => {
  test('invites, updates, protects the last owner and disables with revocations', () => {
    const owner = activeMember('Owner', [], 'owner')
    const { invite, token } = inviteMember(ctx, CLI_ACTOR, { label: 'Bob', email: 'bob@example.test', orgRole: 'admin', workspaces: [], createdBy: null })
    assert.ok(token.length > 30)
    assert.equal(lastAudit().action, 'invite.create')
    assert.throws(() => inviteMember(ctx, CLI_ACTOR, { label: 'Dup', email: 'bob@example.test', orgRole: 'member', workspaces: [], createdBy: null }), (e: ConsoleError) => e.code === 'member_exists')
    assert.throws(() => inviteMember(ctx, CLI_ACTOR, { label: 'X', email: null, orgRole: 'member', workspaces: [], createdBy: null, expiresInHours: 10_000 }), /expiresInHours/)
    const bob = store.consumeInvite(hashApiKey(token), Date.now())!
    assert.equal(bob.id, invite.memberId)

    assert.throws(() => updateMember(ctx, CLI_ACTOR, owner.id, { orgRole: 'member' }), (e: ConsoleError) => e.code === 'last_owner')
    assert.throws(() => disableMember(ctx, CLI_ACTOR, owner.id), (e: ConsoleError) => e.code === 'last_owner')

    const { token: adminToken } = store.createAdminToken({ label: 't', scope: 'admin', createdBy: bob.id })
    const demoted = updateMember(ctx, CLI_ACTOR, bob.id, { orgRole: 'member', maxKeys: 3, limits: { weekly: 7_000_000 } })
    assert.equal(demoted.maxKeys, 3)
    assert.equal(demoted.limits.weekly, 7_000_000)
    assert.deepEqual(lastAudit().details['revokedTokens'], [adminToken.id])

    setWorkspaceMember(ctx, CLI_ACTOR, store.defaultWorkspace().id, bob.id, 'member')
    const { key } = createKey(ctx, CLI_ACTOR, { label: 'bob', ownerMemberId: bob.id })
    const result = disableMember(ctx, CLI_ACTOR, bob.id)
    assert.deepEqual(result.revokedKeys, [key.id])
    assert.deepEqual(revoked.members, [bob.id])
    assert.deepEqual(revoked.keys, [key.id])
  })

  test('removes credentials, keeping the last one unless allowed', () => {
    const member = activeMember('Cred')
    let credentials = [{ id: 'cred_1', kind: 'passkey' as const, label: 'laptop', createdAt: 1, lastUsedAt: null }, { id: 'cred_2', kind: 'wallet' as const, label: '0xabc', createdAt: 2, lastUsedAt: null }]
    const deleted: Array<[string, string | null]> = []
    const port: CredentialStore = {
      credentialsFor: () => credentials,
      deleteCredential: (_member, id, keep) => { deleted.push([id, keep ?? null]); credentials = credentials.filter((c) => c.id !== id); return true },
    }
    removeCredential(ctx, CLI_ACTOR, port, { memberId: member.id, credentialId: 'cred_1', allowLast: false })
    assert.deepEqual(deleted, [['cred_1', null]])
    assert.equal(lastAudit().details['sessionsRevoked'], 'all')
    assert.throws(() => removeCredential(ctx, CLI_ACTOR, port, { memberId: member.id, credentialId: 'cred_2', allowLast: false }), (e: ConsoleError) => e.code === 'last_credential')
    assert.throws(() => removeCredential(ctx, CLI_ACTOR, port, { memberId: member.id, credentialId: 'nope', allowLast: true }), (e: ConsoleError) => e.status === 404)
    removeCredential(ctx, CLI_ACTOR, port, { memberId: member.id, credentialId: 'cred_2', allowLast: true })
    assert.equal(credentials.length, 0)
  })
})

describe('workspaces', () => {
  test('create, update with a policy audit entry, member roles, delete guarded by keys and funds', async () => {
    const workspace = await createWorkspace(ctx, CLI_ACTOR, { name: 'Research', buyerIdentity: 'default' })
    updateWorkspace(ctx, CLI_ACTOR, workspace.id, { name: 'Research 2', routingPolicy: { minTrustScore: 50 } })
    const actions = listAuditEntries(store, { limit: 2 }).entries.map((entry) => entry.action)
    assert.deepEqual(actions.sort(), ['workspace.policy.update', 'workspace.update'])
    assert.throws(() => updateWorkspace(ctx, CLI_ACTOR, workspace.id, { buyerIdentity: 'x' }), /wallet cannot be changed/)

    const member = activeMember('Mo')
    setWorkspaceMember(ctx, CLI_ACTOR, workspace.id, member.id, 'admin')
    assert.equal(store.memberWorkspaceRoles(member.id).get(workspace.id), 'admin')
    const { key } = createKey(ctx, CLI_ACTOR, { label: 'mo', workspaceId: workspace.id, ownerMemberId: member.id })
    await rejectsWithCode(() => deleteWorkspace(ctx, CLI_ACTOR, workspace.id, fakeBuyer({})), 'workspace_has_keys')
    assert.deepEqual(removeWorkspaceMember(ctx, CLI_ACTOR, workspace.id, member.id).revokedKeys, [key.id])

    // Shares the default identity with the Default workspace: no balance check.
    await deleteWorkspace(ctx, CLI_ACTOR, workspace.id, fakeBuyer({}))
    assert.equal(store.getWorkspace(workspace.id), null)
    await rejectsWithCode(() => deleteWorkspace(ctx, CLI_ACTOR, store.defaultWorkspace().id, fakeBuyer({})), 'default_workspace')
  })

  test('a workspace with its own wallet is deleted only when the buyer reports it empty', async () => {
    const workspace = await createWorkspace(ctx, CLI_ACTOR, { name: 'Own Wallet' })
    assert.equal(workspace.buyerIdentity, 'ws-own-wallet')
    assert.match(workspace.walletAddress ?? '', /^0x[0-9a-fA-F]{40}$/)
    await rejectsWithCode(() => deleteWorkspace(ctx, CLI_ACTOR, workspace.id, fakeBuyer({})), 'balance_unknown')
    const funded = fakeBuyer({ 'GET /_antseed/balances': () => ({ body: { available: '1.5', reserved: '0', walletUsdc: '0' } }) })
    await rejectsWithCode(() => deleteWorkspace(ctx, CLI_ACTOR, workspace.id, funded), 'workspace_has_balance')
    assert.deepEqual(funded.calls, ['GET /_antseed/balances?identity=ws-own-wallet'])
    await deleteWorkspace(ctx, CLI_ACTOR, workspace.id, fakeBuyer({ 'GET /_antseed/balances': () => ({ body: { available: '0', reserved: '0', walletUsdc: '0' } }) }))
    assert.equal(store.getWorkspace(workspace.id), null)
  })
})

describe('routing, peer lists and presets', () => {
  test('the gateway default policy is set, refused when empty unless confirmed, and cleared', () => {
    setGatewayDefaultPolicy(ctx, CLI_ACTOR, { minTrustScore: 30 })
    assert.deepEqual(gatewayDefaultPolicy(store), { minTrustScore: 30 })
    assert.throws(() => setGatewayDefaultPolicy(ctx, CLI_ACTOR, { allowedPeerIds: [] }), (e: ConsoleError) => e.code === 'empty_allow_list')
    setGatewayDefaultPolicy(ctx, CLI_ACTOR, {})
    assert.equal(gatewayDefaultPolicy(store), null)
    assert.equal(lastAudit().action, 'routing.default.update')
  })

  test('emptying or deleting a peer list a policy relies on needs confirmation', () => {
    const list = createPeerList(ctx, CLI_ACTOR, { name: 'Trusted', peerIds: [`0x${PEER_A.toUpperCase()}`] })
    assert.deepEqual(list.peerIds, [PEER_A])
    assert.throws(() => createPeerList(ctx, CLI_ACTOR, { name: 'Bad', peerIds: ['not-hex'] }), /hex/)
    setGatewayDefaultPolicy(ctx, CLI_ACTOR, { allowedPeerLists: [list.id] })
    assert.throws(() => updatePeerList(ctx, CLI_ACTOR, list.id, { peerIds: [] }), PolicyProblemError)
    try {
      deletePeerList(ctx, CLI_ACTOR, list.id)
      assert.fail('expected a refusal')
    } catch (problem) {
      assert.ok(problem instanceof PolicyProblemError)
      assert.deepEqual(problem.body.error['usedBy'], ['gateway default'])
    }
    updatePeerList(ctx, CLI_ACTOR, list.id, { peerIds: [PEER_A, PEER_B] })
    assert.deepEqual(lastAudit().details, { added: [PEER_B] })
    deletePeerList(ctx, CLI_ACTOR, list.id, { confirmEmpty: true })
    assert.equal(store.getPeerList(list.id), null)
  })

  test('presets validate slugs, models and params and are found by slug', async () => {
    const preset = createPreset(ctx, CLI_ACTOR, { slug: 'fast', name: 'Fast', workspaceId: null, model: 'open-model-a', params: { temperature: 0.2, model: 'ignored' } })
    assert.deepEqual(preset.params, { temperature: 0.2 })
    assert.throws(() => createPreset(ctx, CLI_ACTOR, { slug: 'fast', name: 'Again', workspaceId: null, model: 'm' }), (e: ConsoleError) => e.code === 'preset_exists')
    assert.throws(() => createPreset(ctx, CLI_ACTOR, { slug: 'Bad Slug', name: 'x', workspaceId: null, model: 'm' }), /slug/)
    assert.throws(() => createPreset(ctx, CLI_ACTOR, { slug: 'loop', name: 'x', workspaceId: null, model: '@preset/fast' }), /another preset/)
    const updated = updatePreset(ctx, CLI_ACTOR, preset.id, { systemPrompt: 'Be brief.', routingPolicy: { requireTee: true } })
    assert.equal(updated.systemPrompt, 'Be brief.')
    assert.equal(lastAudit().details['systemPromptChanged'], true)
    assert.equal(findPreset(ctx, 'fast').id, preset.id)
    assert.throws(() => findPreset(ctx, 'missing'), (e: ConsoleError) => e.status === 404)
  })
})

describe('usage', () => {
  function seedRequests(count: number, keyId: string): void {
    for (let index = 0; index < count; index += 1) {
      const tag = `gw_${String(index).padStart(3, '0')}`
      store.startRequest({ tag, keyId, buyerIdentity: 'default', method: 'POST', path: '/v1/chat/completions', model: index % 2 ? 'model-odd' : '=model-even', startedAt: Date.now() - (count - index) * 1000, endUser: null })
      store.finishRequest(tag, { status: index === 0 ? 500 : 200, buyerRequestId: null })
    }
  }

  test('reports, pages and exports the request log', () => {
    const { key } = createKey(ctx, CLI_ACTOR, { label: 'usage' })
    seedRequests(5, key.id)
    const report = usageReport(store, { keyIds: null }, { groupBy: 'model', now: Date.now() })
    assert.equal(report.totals.requests, 5)
    assert.equal(report.totals.failedRequests, 1)
    assert.deepEqual(report.groups.map((group) => group.group).sort(), ['=model-even', 'model-odd'])

    const first = listRequestPage(store, { keyIds: null }, { limit: 2 })
    assert.deepEqual(first.requests.map((row) => row.tag), ['gw_004', 'gw_003'])
    const second = listRequestPage(store, { keyIds: null }, { limit: 2, before: decodeCursor(first.nextBefore) })
    assert.deepEqual(second.requests.map((row) => row.tag), ['gw_002', 'gw_001'])
    assert.equal(listRequestPage(store, { keyIds: [] }, {}).requests.length, 0)

    const csv = [...requestCsvChunks(store, { keyIds: null, status: 'error' })].join('')
    const lines = csv.trim().split('\r\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /^tag,startedAt,/)
    assert.match(lines[1]!, /'=model-even/)
    assert.equal(csvCell('a,"b"'), '"a,""b"""')
    assert.deepEqual(decodeCursor(encodeCursor({ startedAt: 5, tag: 'x' })), { startedAt: 5, tag: 'x' })
    assert.throws(() => decodeCursor('%%%'), /cursor/)
  })
})

describe('tokens and audit', () => {
  test('creates and revokes management tokens', () => {
    const { token, secret } = createAdminToken(ctx, CLI_ACTOR, { label: 'ci', scope: 'read', expiresAt: tokenExpiry(7, Date.now(), false), createdBy: null })
    assert.equal(store.findAdminTokenBySecret(secret)?.id, token.id)
    assert.throws(() => tokenExpiry(null, Date.now(), false), (e: ConsoleError) => e.status === 403)
    assert.equal(tokenExpiry(null, Date.now(), true), null)
    assert.equal(revokeAdminToken(ctx, CLI_ACTOR, token.id).revoked, true)
    assert.equal(revokeAdminToken(ctx, CLI_ACTOR, token.id).revoked, false)
    assert.throws(() => revokeAdminToken(ctx, CLI_ACTOR, 'adm_missing'), (e: ConsoleError) => e.status === 404)
    assert.throws(() => listAuditEntries(store, { limit: 501 }), /limit/)
    assert.throws(() => listAuditEntries(store, { before: 'x' }), /cursor/)
    assert.deepEqual(listAuditEntries(store, { action: 'token' }).entries.map((entry) => entry.action), ['token.revoke', 'token.create'])
  })
})

describe('settings', () => {
  test('buyer settings patch the config in place and restart the buyer', async () => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, `${JSON.stringify({ buyer: { proxyPort: 8377, custom: 'kept' } }, null, 2)}\n`, { mode: 0o640 })
    const settingsCtx = { ...ctx, configPath, publicUrl: null, buyerPort: 8377 }
    const restarting = fakeBuyer({ 'POST /_antseed/restart': () => ({ status: 202, body: { ok: true } }) })
    const result = await updateBuyerSettings(settingsCtx, CLI_ACTOR, { maxPricing: { inputUsdPerMillion: 2 }, minPeerReputation: 40 }, restarting)
    assert.deepEqual(result, { changed: true, restartRequired: false })
    assert.deepEqual(restarting.calls, ['POST /_antseed/restart'])
    const saved = JSON.parse(readFileSync(configPath, 'utf8')) as { buyer: Record<string, unknown> }
    assert.equal(saved.buyer['custom'], 'kept')
    assert.equal(saved.buyer['minPeerReputation'], 40)
    assert.deepEqual(saved.buyer['maxPricing'], { defaults: { inputUsdPerMillion: 2 } })
    assert.equal((await readSettings(settingsCtx)).buyer.minPeerReputation, 40)

    const unsupervised = fakeBuyer({ 'POST /_antseed/restart': () => ({ status: 409, body: { error: 'restart_unsupported' } }) })
    assert.deepEqual(await updateBuyerSettings(settingsCtx, CLI_ACTOR, { minPeerReputation: 10 }, unsupervised), { changed: true, restartRequired: true })
    assert.deepEqual(await updateBuyerSettings(settingsCtx, CLI_ACTOR, {}, unsupervised), { changed: false, restartRequired: false })
    await assert.rejects(updateBuyerSettings(settingsCtx, CLI_ACTOR, { minPeerReputation: 101 }, unsupervised), /between 0 and 100/)

    writeFileSync(configPath, '{ not json')
    await assert.rejects(patchConfigFile(configPath, () => {}), (e: ConsoleError) => e.code === 'config_unreadable')
  })

  test('observability: destination changes need mayChangeDestination; headers are masked unless revealed', async () => {
    const settingsCtx = { ...ctx, configPath: join(dir, 'missing.json'), publicUrl: null, buyerPort: 8377 }
    assert.throws(() => setObservabilitySettings(ctx, CLI_ACTOR, { otlpEndpoint: 'https://otel.example.test/v1/traces' }, { mayChangeDestination: false }), (e: ConsoleError) => e.code === 'session_required')
    assert.equal(lastAudit().action, 'settings.observability.denied')
    setObservabilitySettings(ctx, CLI_ACTOR, { otlpEndpoint: 'https://otel.example.test/v1/traces', otlpHeaders: { authorization: 'Bearer s3cret' }, retentionDays: 14 }, { mayChangeDestination: true })
    assert.equal(store.getSetting<{ retentionDays: number }>(OBSERVABILITY_SETTING)?.retentionDays, 14)
    assert.deepEqual(lastAudit().details['otlpHeaders'], ['authorization'])
    assert.equal((await readSettings(settingsCtx)).observability.otlpHeaders['authorization'], '••••')
    assert.equal((await readSettings(settingsCtx, { revealSecrets: true })).observability.otlpHeaders['authorization'], 'Bearer s3cret')
  })
})

describe('network', () => {
  test('peers and route previews come from the buyer under the resolved policy', async () => {
    const buyer = fakeBuyer({
      'GET /_antseed/peers': () => ({ body: { ok: true, peers: [{ peerId: PEER_A, displayName: 'Seller A', providers: ['p'], providerPricing: { p: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'open-model-a': {} } } } }] } }),
      'GET /_antseed/route-preview': (url) => ({ body: { model: url.searchParams.get('model'), candidates: [{ peerId: PEER_A, rank: 1, eligible: true, reasons: ['cheapest'], inputUsdPerMillion: 1, outputUsdPerMillion: 2, trustScore: null }] } }),
    })
    const peers = await listNetworkPeers(store, buyer, Date.now())
    assert.equal(peers[0]!.peerId, PEER_A)
    assert.equal(peers[0]!.services[0]!.service, 'open-model-a')

    setGatewayDefaultPolicy(ctx, CLI_ACTOR, { allowedModels: ['open-model-a'], minTrustScore: 10 })
    const preview = await previewRoute(store, buyer, `${PEER_A}@open-model-a`, {})
    assert.equal(preview.model, 'open-model-a')
    assert.equal(preview.modelAllowed, true)
    assert.equal(preview.candidates[0]!.displayName, 'Seller A')
    const blocked = await previewRoute(store, buyer, 'closed-model', {})
    assert.equal(blocked.modelAllowed, false)
    assert.equal(buyer.calls.filter((call) => call.includes('route-preview')).length, 1)
  })
})
