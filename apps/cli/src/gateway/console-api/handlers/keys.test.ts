import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePolicy } from '../../policy-resolver.js'
import type { GatewayStore } from '../../store.js'
import { FakeConsoleAuth, addActiveMember, call, memberPrincipal, startConsole, tempDataDir, testDeps } from '../test-support.js'
import { coreConsoleRegistrars } from './index.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }
const A = 'aa'.repeat(20)
const B = 'bb'.repeat(20)
const C = 'cc'.repeat(20)

function seed(store: GatewayStore, auth: FakeConsoleAuth) {
  const owner = store.createOwner({ label: 'Owner', email: 'owner@example.test' })
  const ws = store.createWorkspace({ name: 'Alpha', buyerIdentity: 'ws-alpha' })
  const add = (label: string, role: 'admin' | 'member') =>
    addActiveMember(store, label, { workspaces: [{ workspaceId: ws.id, role }], createdBy: owner.id })
  const wsAdmin = add('Ws admin', 'admin')
  const member = add('Member', 'member')
  const any = store.createPeerList({ name: 'Any', description: null, peerIds: [A, B, C] })
  const onlyC = store.createPeerList({ name: 'Only C', description: null, peerIds: [C] })
  const { key } = store.createKey({ label: 'Mine', workspaceId: ws.id, ownerMemberId: member.id, limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedPeerIds: [A] } })
  auth.as('owner', memberPrincipal(store, owner.id))
  auth.as('wsAdmin', memberPrincipal(store, wsAdmin.id))
  auth.as('member', memberPrincipal(store, member.id))
  return { ws, member, key, any, onlyC }
}

async function harness() {
  const { dir, store, cleanup } = tempDataDir()
  const auth = new FakeConsoleAuth()
  const org = seed(store, auth)
  const server = await startConsole(testDeps(store, dir), auth, coreConsoleRegistrars)
  const as = (who: string, method: string, path: string, body?: unknown) => call(server.port, method, `/console/api${path}`, { who, body })
  return { store, org, as, close: async () => { await server.close(); cleanup() } }
}

type ErrorBody = { error: { code: string; fields?: string[]; effectiveRoutingPolicy?: { allowedPeerIds?: string[] } } }

test('a key owner cannot widen the admin allow list with a peer list (or ids outside an allowed list)', async () => {
  const h = await harness()
  const path = `/keys/${h.org.key.id}`
  try {
    const widen = await h.as('member', 'PATCH', path, { ownerRoutingPolicy: { allowedPeerIds: [A], allowedPeerLists: [h.org.any.id] } })
    assert.equal(widen.status, 409)
    const body = widen.body as ErrorBody
    assert.equal(body.error.code, 'narrowed')
    assert.deepEqual(body.error.fields, ['ownerRoutingPolicy.allowedPeerIds'])
    assert.deepEqual(body.error.effectiveRoutingPolicy?.allowedPeerIds, [A])
    assert.equal(h.store.getKey(h.org.key.id)!.ownerRoutingPolicy, null)

    // Saved anyway, it still cannot route beyond the admin layer.
    assert.equal((await h.as('member', 'PATCH', path, { ownerRoutingPolicy: { allowedPeerLists: [h.org.any.id] }, acceptNarrowed: true })).status, 200)
    assert.deepEqual(resolvePolicy(h.store, { keyId: h.org.key.id }).policy.allowedPeerIds, [A])

    // The admins allow a list; ids outside it get nowhere.
    assert.equal((await h.as('wsAdmin', 'PATCH', path, { routingPolicy: { allowedPeerLists: [h.org.onlyC.id] }, ownerRoutingPolicy: null })).status, 200)
    const outside = await h.as('member', 'PATCH', path, { ownerRoutingPolicy: { allowedPeerIds: [B] } })
    assert.equal(outside.status, 400, 'no overlap with the admin list leaves no seller')
    assert.equal((outside.body as ErrorBody).error.code, 'empty_allow_list')
    const confirmed = await h.as('member', 'PATCH', path, { ownerRoutingPolicy: { allowedPeerIds: [B] }, confirmEmpty: true, acceptNarrowed: true })
    assert.equal(confirmed.status, 200)
    assert.deepEqual(resolvePolicy(h.store, { keyId: h.org.key.id }).policy.allowedPeerIds, [])

    // The admin layer itself is not the owner's to touch.
    assert.equal((await h.as('member', 'PATCH', path, { routingPolicy: null })).status, 403)
  } finally {
    await h.close()
  }
})

test('empty allow lists need confirmEmpty; peer lists in use cannot be emptied or deleted silently', async () => {
  const h = await harness()
  try {
    const ws = `/workspaces/${h.org.ws.id}`
    const empty = await h.as('wsAdmin', 'PATCH', ws, { routingPolicy: { allowedPeerIds: [] } })
    assert.equal(empty.status, 400)
    assert.equal((empty.body as ErrorBody).error.code, 'empty_allow_list')
    assert.equal((await h.as('wsAdmin', 'PATCH', ws, { routingPolicy: { allowedPeerLists: ['pl_missing'] } })).status, 400)
    assert.equal((await h.as('wsAdmin', 'PATCH', ws, { routingPolicy: { allowedPeerIds: [] }, confirmEmpty: true })).status, 200)
    assert.equal((await h.as('wsAdmin', 'PATCH', ws, { routingPolicy: null })).status, 200)

    // A workspace policy may not ask for more than the org policy above it.
    assert.equal((await h.as('owner', 'PATCH', ws, { orgRoutingPolicy: { maxInputUsdPerMillion: 2 } })).status, 200)
    const looser = await h.as('wsAdmin', 'PATCH', ws, { routingPolicy: { maxInputUsdPerMillion: 5 } })
    assert.equal(looser.status, 409)
    assert.deepEqual((looser.body as ErrorBody).error.fields, ['routingPolicy.maxInputUsdPerMillion'])

    const members = await h.as('owner', 'PATCH', `/members/${h.org.member.id}`, { routingPolicy: { allowedPeerIds: [] } })
    assert.equal(members.status, 400)

    // The key allows only the "Only C" list's sellers.
    h.store.updateKey(h.org.key.id, { routingPolicy: { allowedPeerLists: [h.org.onlyC.id] } })
    const emptied = await h.as('owner', 'PATCH', `/peer-lists/${h.org.onlyC.id}`, { peerIds: [] })
    assert.equal(emptied.status, 400)
    assert.deepEqual((emptied.body as { error: { usedBy: string[] } }).error.usedBy, ['key Mine'])
    assert.equal((await h.as('owner', 'PATCH', `/peer-lists/${h.org.onlyC.id}`, { peerIds: [B] })).status, 200, 'changing members is fine')
    assert.equal((await h.as('owner', 'DELETE', `/peer-lists/${h.org.onlyC.id}`)).status, 400)
    assert.equal((await h.as('owner', 'DELETE', `/peer-lists/${h.org.onlyC.id}?confirmEmpty=true`)).status, 204)
    assert.equal((await h.as('owner', 'DELETE', `/peer-lists/${h.org.any.id}`)).status, 204, 'an unused list just goes')
  } finally {
    await h.close()
  }
})

test('a member creating a key sets its owner layer; admins set both layers', async () => {
  const h = await harness()
  try {
    const own = await h.as('member', 'POST', '/keys', { label: 'Own', workspaceId: h.org.ws.id, limits: { daily: '3' }, routingPolicy: { minTrustScore: 10 } })
    assert.equal(own.status, 201)
    const ownKey = h.store.getKey((own.body as { key: { id: string } }).key.id)!
    assert.deepEqual(ownKey.limits, NO_LIMITS)
    assert.equal(ownKey.routingPolicy, null)
    assert.equal(ownKey.ownerLimits.daily, 3_000_000)
    assert.deepEqual(ownKey.ownerRoutingPolicy, { minTrustScore: 10 })

    const byAdmin = await h.as('wsAdmin', 'POST', '/keys', {
      label: 'Managed', workspaceId: h.org.ws.id, ownerMemberId: h.org.member.id,
      limits: { daily: '2' }, ownerLimits: { daily: '5' },
    })
    assert.equal(byAdmin.status, 409, 'an owner cap above the admin cap would never apply')
    const ok = await h.as('wsAdmin', 'POST', '/keys', {
      label: 'Managed', workspaceId: h.org.ws.id, ownerMemberId: h.org.member.id, limits: { daily: '2' }, ownerLimits: { daily: '1' },
    })
    assert.equal(ok.status, 201)
    const dto = (ok.body as { key: { limits: { daily: string }; ownerLimits: { daily: string } } }).key
    assert.equal(dto.limits.daily, '2.000000')
    assert.equal(dto.ownerLimits.daily, '1.000000')
  } finally {
    await h.close()
  }
})
