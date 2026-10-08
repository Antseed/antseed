import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSOLE_LOCATION_SETTING } from '../../console-location.js'
import type { HostFacts } from '../../exposure.js'
import { DEFAULT_WORKSPACE_ID } from '../../store.js'
import { FakeConsoleAuth, addActiveMember, call, memberPrincipal, startConsole, tempDataDir, testDeps } from '../test-support.js'
import type { ConsoleDeps } from '../deps.js'
import type { GatewayStatus } from '../types.js'
import { registerStatusRoutes } from './status.js'

const LAPTOP: HostFacts = { platform: 'darwin', systemd: false, container: false }
const SERVER: HostFacts = { platform: 'linux', systemd: true, container: false }
const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

async function harness(overrides: Partial<ConsoleDeps>) {
  const { dir, store, cleanup } = tempDataDir()
  const auth = new FakeConsoleAuth()
  const owner = store.createOwner({ label: 'Owner', email: 'owner@example.test' })
  const admin = addActiveMember(store, 'Admin', { orgRole: 'admin' })
  const member = addActiveMember(store, 'Member', { workspaces: [{ workspaceId: DEFAULT_WORKSPACE_ID, role: 'member' }] })
  const key = store.createKey({ label: 'k', workspaceId: DEFAULT_WORKSPACE_ID, ownerMemberId: member.id, limits: NO_LIMITS, expiresAt: null })
  auth.as('owner', memberPrincipal(store, owner.id))
  auth.as('admin', memberPrincipal(store, admin.id))
  auth.as('member', memberPrincipal(store, member.id))
  auth.as('keyholder', { kind: 'key', keyId: key.key.id, sessionId: 'ks' })
  const deps: ConsoleDeps = { ...testDeps(store, dir), ...overrides }
  const server = await startConsole(deps, auth, [registerStatusRoutes])
  const status = async (who: string) => {
    const result = await call(server.port, 'GET', '/console/api/status', { who })
    assert.equal(result.status, 200)
    return result.body as GatewayStatus
  }
  return { store, status, close: async () => { await server.close(); cleanup() } }
}

test('GET /status: a laptop gateway on loopback is local; admins see why, others only the mode', async () => {
  const h = await harness({ publicUrl: null, listenHost: '127.0.0.1', hostFacts: LAPTOP })
  try {
    for (const who of ['owner', 'admin']) {
      const { exposure } = await h.status(who)
      assert.equal(exposure?.mode, 'local', who)
      assert.equal(exposure?.reachableFromInternet, false)
      assert.equal(exposure?.personalComputer, true)
      assert.equal(exposure?.listenHost, '127.0.0.1')
      assert.ok((exposure?.reasons.length ?? 0) > 0)
    }
    for (const who of ['member', 'keyholder']) {
      const { exposure } = await h.status(who)
      assert.equal(exposure?.mode, 'local', who)
      assert.equal(exposure?.listenHost, null, `${who} does not learn the listen address`)
      assert.deepEqual(exposure?.reasons, [])
    }
  } finally {
    await h.close()
  }
})

test('GET /status: a server with a public URL is public', async () => {
  const h = await harness({ publicUrl: 'https://llm.example.com', listenHost: '127.0.0.1', hostFacts: SERVER })
  try {
    const { exposure, publicUrl } = await h.status('owner')
    assert.equal(publicUrl, 'https://llm.example.com')
    assert.equal(exposure?.mode, 'public')
    assert.equal(exposure?.reachableFromInternet, true)
    assert.equal(exposure?.personalComputer, false)
  } finally {
    await h.close()
  }
})

test('GET /status: a quick tunnel URL saved after start-up counts as public; 0.0.0.0 without one is lan', async () => {
  const h = await harness({ publicUrl: null, hostFacts: SERVER })
  try {
    h.store.setSetting(CONSOLE_LOCATION_SETTING, { publicUrl: null, port: 8379, host: '0.0.0.0' })
    const lan = await h.status('owner')
    assert.equal(lan.exposure?.mode, 'lan')
    assert.equal(lan.exposure?.listenHost, '0.0.0.0', 'falls back to the saved listen address')
    assert.equal(lan.exposure?.reachableFromInternet, null)

    h.store.setSetting(CONSOLE_LOCATION_SETTING, { publicUrl: 'https://quick-fox.trycloudflare.com', port: 8379 })
    const tunnel = await h.status('owner')
    assert.equal(tunnel.exposure?.mode, 'public')
    assert.equal(tunnel.exposure?.publicUrl, 'https://quick-fox.trycloudflare.com')
  } finally {
    await h.close()
  }
})
