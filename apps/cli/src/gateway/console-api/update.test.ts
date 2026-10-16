import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectInstallMethod } from '../../update/install-method.js'
import { createGatewayUpdates } from '../updates.js'
import { registerUpdateRoutes } from './handlers/update.js'
import { FakeConsoleAuth, addActiveMember, call, memberPrincipal, startConsole, tempDataDir, testDeps } from './test-support.js'
import type { GatewayUpdate } from './types.js'

async function harness(options: { installer: boolean; latest?: string }) {
  const { dir, store, cleanup } = tempDataDir()
  const auth = new FakeConsoleAuth()
  const owner = store.createOwner({ label: 'Owner', email: 'owner@example.test' })
  const member = addActiveMember(store, 'Member', { orgRole: 'member', workspaces: [], createdBy: owner.id })
  auth.as('owner', memberPrincipal(store, owner.id))
  auth.as('member', memberPrincipal(store, member.id))
  auth.as('reader', { kind: 'token', tokenId: 'tok_r', scope: 'read' })
  const env = options.installer
    ? { ANTSEED_UPDATER_REQUEST: join(dir, 'update-request'), ANTSEED_UPDATER_STATUS: join(dir, 'status.json') }
    : {}
  let fetches = 0
  const updates = createGatewayUpdates({
    dataDir: dir,
    current: '0.1.180',
    env,
    fetchLatest: async () => { fetches += 1; return options.latest ?? '0.1.193' },
    method: options.installer
      ? detectInstallMethod({ env, scriptPath: '/opt/antseed/cli/lib/node_modules/@antseed/cli/dist/cli/index.js', electron: false })
      : detectInstallMethod({ env, scriptPath: '/usr/local/lib/node_modules/@antseed/cli/dist/cli/index.js', electron: false, isWritable: () => true }),
  })
  const server = await startConsole(testDeps(store, dir, { updates }), auth, [registerUpdateRoutes])
  const as = <T = GatewayUpdate>(who: string, method: string, path: string) =>
    call(server.port, method, `/console/api${path}`, { who, bearer: who === 'reader' }) as Promise<{ status: number; body: T }>
  return { dir, store, env, as, fetches: () => fetches, close: async () => { await server.close(); cleanup() } }
}

test('GET /update and POST /update/check are for org admins and report npm latest', async () => {
  const h = await harness({ installer: true })
  try {
    assert.equal((await h.as('member', 'GET', '/update')).status, 403)
    const checked = await h.as('owner', 'POST', '/update/check')
    assert.equal(checked.status, 200)
    assert.equal(checked.body.latest, '0.1.193')
    assert.equal(checked.body.available, true)
    assert.equal(checked.body.apply, 'console')
    assert.equal(checked.body.install, 'installer')
    assert.equal(h.fetches(), 1)
    // A second forced check within seconds reuses the answer.
    await h.as('owner', 'POST', '/update/check')
    assert.equal(h.fetches(), 1)
    assert.equal((await h.as('reader', 'GET', '/update')).status, 200)
  } finally {
    await h.close()
  }
})

test('POST /update on an installer server writes the request once, audits it and reports progress', async () => {
  const h = await harness({ installer: true })
  try {
    await h.as('owner', 'POST', '/update/check')
    assert.equal((await h.as('member', 'POST', '/update')).status, 403)
    assert.equal((await h.as('reader', 'POST', '/update')).status, 403)
    assert.equal(existsSync(h.env.ANTSEED_UPDATER_REQUEST!), false)

    const applied = await h.as('owner', 'POST', '/update')
    assert.equal(applied.status, 202)
    assert.equal(applied.body.progress?.state, 'requested')
    assert.equal(existsSync(h.env.ANTSEED_UPDATER_REQUEST!), true)
    const again = await h.as('owner', 'POST', '/update')
    assert.equal(again.status, 202, 'a second click while it runs is harmless')
    assert.equal(h.store.listAudit({ action: 'gateway.update' }).entries.filter((entry) => entry.action === 'gateway.update').length, 1)

    // The updater picked it up and finished.
    rmSync(h.env.ANTSEED_UPDATER_REQUEST!)
    writeFileSync(h.env.ANTSEED_UPDATER_STATUS!, JSON.stringify({ state: 'failed', from: '0.1.180', to: null, startedAt: 1, finishedAt: 2, error: 'npm install exited with 1' }))
    const failed = await h.as('owner', 'GET', '/update')
    assert.equal(failed.body.progress?.state, 'failed')
    assert.equal(failed.body.progress?.error, 'npm install exited with 1')
  } finally {
    await h.close()
  }
})

test('POST /update refuses when the gateway cannot update itself or is already current', async () => {
  const npm = await harness({ installer: false })
  try {
    await npm.as('owner', 'POST', '/update/check')
    const info = await npm.as('owner', 'GET', '/update')
    assert.equal(info.body.apply, 'command')
    assert.equal(info.body.command, 'npm install -g @antseed/cli@latest')
    const refused = await npm.as<{ error: { code: string; message: string } }>('owner', 'POST', '/update')
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'update_unsupported')
    assert.match(refused.body.error.message, /npm install -g @antseed\/cli@latest/)
  } finally {
    await npm.close()
  }
  const current = await harness({ installer: true, latest: '0.1.180' })
  try {
    await current.as('owner', 'POST', '/update/check')
    const refused = await current.as<{ error: { code: string } }>('owner', 'POST', '/update')
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'up_to_date')
  } finally {
    await current.close()
  }
})
