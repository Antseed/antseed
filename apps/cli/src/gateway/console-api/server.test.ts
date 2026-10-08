import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConsoleError, respond, type ConsoleRouter } from './router.js'
import { CONSOLE_CSP } from './server.js'
import { FakeConsoleAuth, call, startConsole, tempDataDir, testDeps } from './test-support.js'

function fakeDist(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'antseed-console-dist-'))
  writeFileSync(join(root, 'secret.txt'), 'secret')
  const dir = join(root, 'dist')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Console</title>')
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)')
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>')
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function testRoutes(router: ConsoleRouter): void {
  router.add('GET', '/echo/:id', async ({ params, query, principal }) => ({ id: params['id'], q: query.get('q'), kind: principal?.kind }))
  router.add('POST', '/echo', async ({ body }) => respond(201, { got: body }))
  router.add('POST', '/fail', async () => { throw new ConsoleError(409, 'conflict_here', 'Nope') })
  router.add('GET', '/crash', async () => { throw new Error('secret internals') })
  router.add('GET', '/key-only', async () => ({ ok: true }), { allow: ['key'] })
  router.add('DELETE', '/thing', async () => undefined)
}

test('console API: principals, CSRF, read tokens, body limits and JSON errors', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const auth = new FakeConsoleAuth()
  auth.as('admin', { kind: 'member', memberId: 'm1', orgRole: 'admin', workspaceRoles: new Map(), sessionId: 's' })
  auth.as('reader', { kind: 'token', tokenId: 't1', scope: 'read' })
  auth.as('writer', { kind: 'token', tokenId: 't2', scope: 'admin' })
  auth.as('keyholder', { kind: 'key', keyId: 'k1', sessionId: 's2' })
  const server = await startConsole(testDeps(store, dir), auth, [testRoutes])
  try {
    const ok = await call(server.port, 'GET', '/console/api/echo/a%20b?q=1', { who: 'admin' })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { id: 'a b', q: '1', kind: 'member' })
    assert.equal(ok.headers['cache-control'], 'no-store')
    assert.equal(ok.headers['access-control-allow-origin'], undefined)

    assert.equal((await call(server.port, 'GET', '/console/api/echo/a')).status, 401)
    assert.equal((await call(server.port, 'GET', '/console/api/auth/config')).status, 200, 'public route')
    assert.equal((await call(server.port, 'GET', '/console/api/echo/a', { who: 'keyholder' })).status, 403, 'key sessions only where allowed')
    assert.equal((await call(server.port, 'GET', '/console/api/key-only', { who: 'keyholder' })).status, 200)
    assert.equal((await call(server.port, 'GET', '/console/api/nope', { who: 'admin' })).status, 404)

    const noCsrf = await call(server.port, 'POST', '/console/api/echo', { who: 'admin', body: { a: 1 }, csrf: false })
    assert.equal(noCsrf.status, 403)
    assert.equal((noCsrf.body as any).error.code, 'csrf_required')
    const created = await call(server.port, 'POST', '/console/api/echo', { who: 'admin', body: { a: 1 } })
    assert.equal(created.status, 201)
    assert.deepEqual(created.body, { got: { a: 1 } })
    assert.equal((await call(server.port, 'POST', '/console/api/echo', { who: 'writer', bearer: true, body: {} })).status, 201, 'bearer tokens need no CSRF header')

    const readOnly = await call(server.port, 'POST', '/console/api/echo', { who: 'reader', bearer: true, body: {} })
    assert.equal(readOnly.status, 403)
    assert.equal((readOnly.body as any).error.code, 'read_only_token')
    assert.equal((await call(server.port, 'DELETE', '/console/api/thing', { who: 'reader', bearer: true })).status, 403)
    assert.equal((await call(server.port, 'GET', '/console/api/echo/x', { who: 'reader', bearer: true })).status, 200)
    assert.equal((await call(server.port, 'DELETE', '/console/api/thing', { who: 'writer', bearer: true })).status, 204)

    const conflict = await call(server.port, 'POST', '/console/api/fail', { who: 'admin', body: {} })
    assert.equal(conflict.status, 409)
    assert.deepEqual(conflict.body, { error: { code: 'conflict_here', message: 'Nope' } })
    const crash = await call(server.port, 'GET', '/console/api/crash', { who: 'admin' })
    assert.equal(crash.status, 500)
    assert.ok(!crash.text.includes('secret internals'))

    const badJson = await call(server.port, 'POST', '/console/api/echo', { who: 'admin', headers: { 'content-type': 'application/json' }, body: undefined })
    assert.equal(badJson.status, 201, 'an empty body is allowed')
    const tooBig = await call(server.port, 'POST', '/console/api/echo', { who: 'admin', body: { pad: 'x'.repeat(1024 * 1024 + 10) } })
    assert.equal(tooBig.status, 413)
  } finally {
    await server.close()
    cleanup()
  }
})

test('console web app: assets, SPA fallback, caching, CSP and a missing build', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const dist = fakeDist()
  const auth = new FakeConsoleAuth()
  const server = await startConsole(testDeps(store, dir), auth, [], { distDir: dist.dir })
  const missing = await startConsole(testDeps(store, dir), auth, [], { distDir: join(dist.dir, 'does-not-exist') })
  try {
    const index = await call(server.port, 'GET', '/console')
    assert.equal(index.status, 200)
    assert.match(index.text, /<title>Console/)
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(index.headers['cache-control'], 'no-cache')
    assert.equal(index.headers['content-security-policy'], CONSOLE_CSP)
    assert.match(CONSOLE_CSP, /frame-ancestors 'none'/)
    assert.match(CONSOLE_CSP, /connect-src 'self' https: wss:/)
    assert.equal(index.headers['x-frame-options'], 'DENY')

    const route = await call(server.port, 'GET', '/console/workspaces/ws_1/keys')
    assert.equal(route.status, 200)
    assert.match(route.text, /<title>Console/)

    const asset = await call(server.port, 'GET', '/console/assets/app-abc123.js')
    assert.equal(asset.status, 200)
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal((await call(server.port, 'GET', '/console/favicon.svg')).headers['content-type'], 'image/svg+xml')

    assert.equal((await call(server.port, 'GET', '/console/assets/missing.js')).status, 404)
    for (const path of ['/console/..%2Fsecret.txt', '/console/%2e%2e/secret.txt', '/console/assets/..%2F..%2Fsecret.txt']) {
      const traversal = await call(server.port, 'GET', path)
      assert.notEqual(traversal.text, 'secret', path)
    }
    assert.equal((await call(server.port, 'POST', '/console/x', { csrf: false })).status, 405)

    const notBuilt = await call(missing.port, 'GET', '/console')
    assert.equal(notBuilt.status, 503)
    assert.match(notBuilt.text, /not built/)
  } finally {
    await server.close()
    await missing.close()
    dist.cleanup()
    cleanup()
  }
})

test('paths outside /console are not handled', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const server = await startConsole(testDeps(store, dir), new FakeConsoleAuth(), [])
  try {
    assert.equal((await call(server.port, 'GET', '/v1/models')).status, 404)
    assert.equal((await call(server.port, 'GET', '/consolex')).status, 404)
  } finally {
    await server.close()
    cleanup()
  }
})
