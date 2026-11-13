import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GatewayStore } from '../../store.js'
import { FakeConsoleAuth, addActiveMember, call, memberPrincipal, startConsole, tempDataDir, testDeps } from '../test-support.js'
import { coreConsoleRegistrars } from './index.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }
const ROUTER = `${'aa'.repeat(20)}@fake-route`

async function harness() {
  const { dir, store, cleanup } = tempDataDir()
  const auth = new FakeConsoleAuth()
  const owner = store.createOwner({ label: 'Owner', email: 'owner@example.test' })
  const ws = store.createWorkspace({ name: 'Alpha', buyerIdentity: 'ws-alpha' })
  const member = addActiveMember(store, 'Member', { workspaces: [{ workspaceId: ws.id, role: 'member' }], createdBy: owner.id })
  const { key } = store.createKey({ label: 'Mine', workspaceId: ws.id, ownerMemberId: member.id, limits: NO_LIMITS, expiresAt: null })
  auth.as('owner', memberPrincipal(store, owner.id))
  auth.as('member', memberPrincipal(store, member.id))
  auth.as('key', { kind: 'key', keyId: key.id, sessionId: 'ks' })
  auth.as('token', { kind: 'token', tokenId: 'tok', scope: 'admin' })
  const server = await startConsole(testDeps(store, dir), auth, coreConsoleRegistrars)
  const as = (who: string, method: string, path: string) => call(server.port, method, `/console/api${path}`, { who })
  return { as, close: async () => { await server.close(); cleanup() } }
}

test('each member and key session keeps its own starred models and routers', async () => {
  const h = await harness()
  try {
    assert.deepEqual((await h.as('member', 'GET', '/favorites')).body, { models: [] })
    assert.equal((await h.as('member', 'PUT', `/favorites/${encodeURIComponent('vendor/open-model-a')}`)).status, 204)
    assert.equal((await h.as('member', 'PUT', `/favorites/${encodeURIComponent(ROUTER)}`)).status, 204)
    assert.equal((await h.as('member', 'PUT', `/favorites/${encodeURIComponent(ROUTER)}`)).status, 204, 'starring twice is fine')
    assert.deepEqual((await h.as('member', 'GET', '/favorites')).body, { models: ['vendor/open-model-a', ROUTER] })

    assert.deepEqual((await h.as('owner', 'GET', '/favorites')).body, { models: [] }, 'another member has their own')
    assert.equal((await h.as('key', 'PUT', '/favorites/open-model-b')).status, 204)
    assert.deepEqual((await h.as('key', 'GET', '/favorites')).body, { models: ['open-model-b'] }, 'a key session too')

    assert.equal((await h.as('member', 'DELETE', `/favorites/${encodeURIComponent('vendor/open-model-a')}`)).status, 204)
    assert.deepEqual((await h.as('member', 'GET', '/favorites')).body, { models: [ROUTER] })
    assert.equal((await h.as('token', 'GET', '/favorites')).status, 403, 'admin tokens have no favorites')
  } finally {
    await h.close()
  }
})

test('stars made within the same millisecond stay in the order they were made', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-favorites-'))
  const store = new GatewayStore(dir, () => 1_700_000_000_000)
  try {
    const owner = { kind: 'member', id: 'm1' } as const
    store.setFavoriteModel(owner, 'vendor/open-model-a', true)
    store.setFavoriteModel(owner, ROUTER, true)
    store.setFavoriteModel(owner, 'open-model-0', true)
    assert.deepEqual(store.listFavoriteModels(owner), ['vendor/open-model-a', ROUTER, 'open-model-0'])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
