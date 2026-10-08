import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before, describe } from 'node:test'
import { Wallet } from 'ethers'
import { CONSOLE_LOCATION_SETTING, consoleBaseUrl, gatewayConsole, normalizePublicUrl, readConsoleLocation } from './console.js'
import { startGatewayRuntime, type GatewayRuntime } from './runtime.js'

describe('normalizePublicUrl', () => {
  test('keeps the origin and rejects other schemes and paths', () => {
    assert.equal(normalizePublicUrl(undefined), null)
    assert.equal(normalizePublicUrl('  '), null)
    assert.equal(normalizePublicUrl('https://LLM.example.test/'), 'https://llm.example.test')
    assert.equal(normalizePublicUrl('http://10.0.0.5:8379'), 'http://10.0.0.5:8379')
    assert.throws(() => normalizePublicUrl('ftp://llm.example.test'), /https:\/\//)
    assert.throws(() => normalizePublicUrl('https://llm.example.test/gateway'), /without a path/)
    assert.throws(() => normalizePublicUrl('not a url'), /not a valid URL/)
  })

  test('console links fall back to localhost', () => {
    assert.equal(consoleBaseUrl({ publicUrl: null, port: 8379 }), 'http://localhost:8379')
    assert.equal(consoleBaseUrl({ publicUrl: 'https://llm.example.test', port: 8379 }), 'https://llm.example.test')
  })
})

describe('gateway console wiring', () => {
  let dataDir: string
  let runtime: GatewayRuntime
  let base: string
  let cookie = ''

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }> {
    const response = await fetch(`${base}/console/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-antseed-console': '1' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]!
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers }
  }

  async function signInWithWallet(wallet: { address: string; signMessage(message: string): Promise<string> }, enrollment?: string): Promise<{ status: number; body: any }> {
    const nonce = await api('POST', '/auth/wallet/nonce', { address: wallet.address })
    assert.equal(nonce.status, 200)
    const signature = await wallet.signMessage(nonce.body.message)
    return api('POST', '/auth/wallet/verify', { message: nonce.body.message, signature, ...(enrollment ? { enrollment } : {}) })
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'antseed-gateway-console-'))
    runtime = await startGatewayRuntime({
      dataDir,
      configPath: join(dataDir, 'config.json'),
      listenPort: 0,
      // Nothing listens here: the spend feed and buyer calls just fail.
      buyerPort: 1,
      createConsole: gatewayConsole({ dataDir, configPath: join(dataDir, 'config.json'), publicUrl: null, log: () => undefined, env: {} }),
    })
    base = `http://127.0.0.1:${runtime.port}`
  })

  after(async () => {
    await runtime.stop()
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('starts without keys, saves its location and hands out localhost setup links', async () => {
    assert.ok(runtime.console)
    assert.deepEqual(readConsoleLocation(runtime.store), { publicUrl: null, port: runtime.port, host: '127.0.0.1' })
    assert.ok(runtime.store.getSetting(CONSOLE_LOCATION_SETTING))
    const config = await api('GET', '/auth/config')
    assert.equal(config.status, 200)
    assert.equal(config.body.setupRequired, true)
    assert.match(runtime.console.setupLink!()!, new RegExp(`^http://localhost:${runtime.port}/console/setup#`))
  })

  test('the owner claims the console, signs in with a wallet and reaches the routes', async () => {
    const token = runtime.console!.setupLink!()!.split('#')[1]!
    const setup = await api('POST', '/auth/setup', { token, label: 'Owner', email: 'owner@example.com' })
    assert.equal(setup.status, 200)
    const owner = Wallet.createRandom()
    const signedIn = await signInWithWallet(owner, setup.body.enrollment)
    assert.equal(signedIn.status, 200)
    assert.equal(signedIn.body.kind, 'member')
    assert.equal(runtime.console!.setupLink!(), null)

    const settings = await api('GET', '/settings')
    assert.equal(settings.status, 200)
    assert.equal(settings.body.auth.setupRequired, false)
    assert.equal(settings.body.auth.wallet, true)

    const members = await api('GET', '/members')
    assert.equal(members.status, 200)
    assert.equal(members.body[0].credentials.length, 1)
    assert.equal(members.body[0].credentials[0].kind, 'wallet')
  })

  test('removes sign-in methods, but never a member\'s last one', async () => {
    const me = await api('GET', '/auth/me')
    const memberId = me.body.me.member.id as string
    const [only] = me.body.me.member.credentials as Array<{ id: string }>
    const refused = await api('DELETE', `/members/${memberId}/credentials/${only!.id}`)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'last_credential')

    // A second wallet, linked while signed in.
    const second = Wallet.createRandom()
    const linked = await signInWithWallet(second)
    assert.equal(linked.status, 200)
    assert.equal(linked.body.me.member.credentials.length, 2)

    const removed = await api('DELETE', `/members/${memberId}/credentials/${only!.id}`)
    assert.equal(removed.status, 204)
    const missing = await api('DELETE', `/members/${memberId}/credentials/${only!.id}`)
    assert.equal(missing.status, 404)
    assert.equal((await api('GET', '/auth/me')).body.me.member.credentials.length, 1)
  })

  test('a disabled member\'s sessions end', async () => {
    const invite = await api('POST', '/invites', { label: 'Pat', workspaces: [] })
    assert.equal(invite.status, 201)
    const ownerCookie = cookie
    cookie = ''
    const accepted = await api('POST', '/auth/invite', { token: invite.body.url.split('#')[1] })
    assert.equal(accepted.status, 200)
    const pat = Wallet.createRandom()
    assert.equal((await signInWithWallet(pat, accepted.body.enrollment)).status, 200)
    const patCookie = cookie
    const patId = (await api('GET', '/auth/me')).body.me.member.id as string

    cookie = ownerCookie
    assert.equal((await api('POST', `/members/${patId}/disable`)).status, 200)
    cookie = patCookie
    assert.equal((await api('GET', '/auth/me')).status, 401)
    cookie = ownerCookie
  })

  test('only an org owner removes another member\'s last sign-in method, which ends their sessions', async () => {
    const ownerCookie = cookie
    async function join(label: string, orgRole: 'admin' | 'member'): Promise<{ id: string; cookie: string }> {
      cookie = ownerCookie
      const invite = await api('POST', '/invites', { label, orgRole, workspaces: [] })
      assert.equal(invite.status, 201, JSON.stringify(invite.body))
      cookie = ''
      const accepted = await api('POST', '/auth/invite', { token: invite.body.url.split('#')[1] })
      assert.equal((await signInWithWallet(Wallet.createRandom(), accepted.body.enrollment)).status, 200)
      return { id: (await api('GET', '/auth/me')).body.me.member.id as string, cookie }
    }
    const robin = await join('Robin', 'member')
    const ari = await join('Ari', 'admin')
    cookie = robin.cookie
    const robinCredential = (await api('GET', '/auth/me')).body.me.member.credentials[0].id as string

    cookie = ari.cookie
    const byAdmin = await api('DELETE', `/members/${robin.id}/credentials/${robinCredential}`)
    assert.equal(byAdmin.status, 409)
    assert.equal(byAdmin.body.error.code, 'last_credential')

    cookie = ownerCookie
    assert.equal((await api('DELETE', `/members/${robin.id}/credentials/${robinCredential}`)).status, 204)
    const audited = runtime.store.listAudit({ action: 'member.credential_remove' }).entries
    assert.ok(audited.some((entry) => entry.target?.id === robin.id && entry.details?.['last'] === true))
    cookie = robin.cookie
    assert.equal((await api('GET', '/auth/me')).status, 401, 'their sessions ended')
    cookie = ownerCookie
  })
})
