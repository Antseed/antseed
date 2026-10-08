import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Wallet } from 'ethers'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from './db.js'
import { sha256, SoftwarePasskey, startHarness, type Browser, type Harness } from './test-helpers.js'

let harness: Harness
afterEach(async () => {
  await harness?.close()
})

function setupToken(link: string): string {
  return link.slice(link.indexOf('#') + 1)
}

async function registerPasskey(browser: Browser, enrollment: string | undefined, passkey: SoftwarePasskey) {
  const options = await browser.request('POST', '/auth/passkey/register/options', enrollment ? { enrollment } : {})
  assert.equal(options.status, 200, JSON.stringify(options.body))
  const origin = `http://${browser.host}`
  return browser.request('POST', '/auth/passkey/register/verify', { enrollment, response: passkey.register(options.body, origin), label: 'Laptop' })
}

async function loginPasskey(browser: Browser, passkey: SoftwarePasskey, overrides: { counter?: number } = {}) {
  const options = await browser.request('POST', '/auth/passkey/login/options', {})
  assert.equal(options.status, 200, JSON.stringify(options.body))
  return browser.request('POST', '/auth/passkey/login/verify', { response: passkey.login(options.body, `http://${browser.host}`, overrides) })
}

async function claimOwner(h: Harness, browser: Browser, passkey = new SoftwarePasskey()) {
  const setup = await browser.request('POST', '/auth/setup', { token: setupToken(h.auth.createSetupLink()), email: 'owner@example.com' })
  assert.equal(setup.status, 200, JSON.stringify(setup.body))
  const registered = await registerPasskey(browser, setup.body.enrollment, passkey)
  assert.equal(registered.status, 200, JSON.stringify(registered.body))
  return { passkey, me: registered.body }
}

describe('console auth: setup and passkeys', () => {
  it('claims the console with a setup link, registers a passkey and signs in with it', async () => {
    harness = await startHarness()
    const browser = harness.browser()
    assert.equal((await browser.request('GET', '/auth/config')).body.setupRequired, true)
    assert.equal((await browser.request('GET', '/auth/config')).body.passkey, true)

    const link = harness.auth.createSetupLink()
    assert.match(link, new RegExp(`^http://localhost:${harness.port}/console/setup#[A-Za-z0-9_-]{40,}$`))
    const token = setupToken(link)

    const setup = await browser.request('POST', '/auth/setup', { token })
    assert.equal(setup.status, 200)
    assert.equal(setup.body.orgRole, 'owner')
    // Single use.
    const again = await harness.browser().request('POST', '/auth/setup', { token })
    assert.equal(again.status, 400)

    const passkey = new SoftwarePasskey()
    const registered = await registerPasskey(browser, setup.body.enrollment, passkey)
    assert.equal(registered.status, 200, JSON.stringify(registered.body))
    assert.equal(registered.body.kind, 'member')
    assert.equal(registered.body.me.member.orgRole, 'owner')
    assert.equal(registered.body.me.member.credentials.length, 1)
    assert.equal(registered.body.me.member.credentials[0].kind, 'passkey')
    assert.deepEqual(registered.body.me.member.limits, { daily: '5.000000', weekly: null, monthly: null, total: null })
    assert.equal(registered.body.me.workspaces.length, 2, 'org owners see every workspace')

    // Loopback http: no Secure flag, but HttpOnly + Strict + /console.
    const cookie = browser.lastSetCookies.find((line) => line.startsWith('antseed_console='))!
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    assert.match(cookie, /Path=\/console/)
    assert.doesNotMatch(cookie, /Secure/)

    assert.equal((await browser.request('GET', '/auth/me')).status, 200)
    assert.equal((await browser.request('GET', '/auth/config')).body.setupRequired, false)
    assert.throws(() => harness.auth.createSetupLink(), /already been claimed/)
    assert.equal((await harness.browser().request('POST', '/auth/setup', { token: 'x'.repeat(43) })).status, 409)

    // Fresh browser signs in with the discoverable passkey.
    const other = harness.browser()
    const login = await loginPasskey(other, passkey)
    assert.equal(login.status, 200, JSON.stringify(login.body))
    assert.equal(login.body.me.member.id, registered.body.me.member.id)
    assert.equal((await other.request('GET', '/auth/me')).status, 200)

    // A replayed (non-increasing) counter is refused.
    const replay = await loginPasskey(harness.browser(), passkey, { counter: 1 })
    assert.equal(replay.status, 401)
    assert.equal(replay.body.error.code, 'passkey_invalid')
  })

  it('only the newest setup link works, and an owner who never registered can re-claim', async () => {
    harness = await startHarness()
    const first = setupToken(harness.auth.createSetupLink())
    const second = setupToken(harness.auth.createSetupLink())
    assert.equal((await harness.browser().request('POST', '/auth/setup', { token: first })).status, 400)
    const claimed = await harness.browser().request('POST', '/auth/setup', { token: second })
    assert.equal(claimed.status, 200)
    // The enrollment was never used, so setup is still open, for the same owner.
    assert.equal((await harness.browser().request('GET', '/auth/config')).body.setupRequired, true)
    const reclaim = await harness.browser().request('POST', '/auth/setup', { token: setupToken(harness.auth.createSetupLink()) })
    assert.equal(reclaim.status, 200)
    const owners = [...harness.store.members.values()].filter((member) => member.orgRole === 'owner')
    assert.equal(owners.length, 1)
  })

  it('uses publicUrl for the setup link', async () => {
    harness = await startHarness({ publicUrl: 'https://gateway.example.test/' })
    assert.match(harness.auth.createSetupLink(), /^https:\/\/gateway\.example\.test\/console\/setup#/)
  })

  it('lets a signed-in member add a second passkey', async () => {
    harness = await startHarness()
    const browser = harness.browser()
    await claimOwner(harness, browser)
    const second = await registerPasskey(browser, undefined, new SoftwarePasskey())
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.me.member.credentials.length, 2)
    // Without a session or enrollment there is nobody to register for.
    assert.equal((await harness.browser().request('POST', '/auth/passkey/register/options', {})).status, 401)
  })

  it('reports passkeys unavailable on a bare IP host', async () => {
    harness = await startHarness()
    const browser = harness.browser(`127.0.0.1:${harness.port}`)
    assert.equal((await browser.request('GET', '/auth/config')).body.passkey, false)
    assert.equal((await browser.request('POST', '/auth/passkey/login/options', {})).status, 400)
  })
})

describe('console auth: invites and wallets', () => {
  it('consumes an invite once and signs in with a wallet', async () => {
    harness = await startHarness()
    const wallet = Wallet.createRandom()
    const { member, token } = harness.store.invite({ label: 'Dana', email: 'dana@example.com' }, [['ws_research', 'member']])

    const browser = harness.browser()
    const invited = await browser.request('POST', '/auth/invite', { token })
    assert.equal(invited.status, 200)
    assert.equal(invited.body.label, 'Dana')
    assert.equal((await harness.browser().request('POST', '/auth/invite', { token })).status, 400)

    const nonce = await browser.request('POST', '/auth/wallet/nonce', { address: wallet.address })
    const message: string = nonce.body.message
    assert.match(message, new RegExp(`^localhost:${harness.port} wants you to sign in with your Ethereum account:\n${wallet.address}\n`))
    assert.match(message, /Chain ID: 8453/)
    assert.match(message, /Expiration Time: /)
    const verified = await browser.request('POST', '/auth/wallet/verify', { message, signature: await wallet.signMessage(message), enrollment: invited.body.enrollment })
    assert.equal(verified.status, 200, JSON.stringify(verified.body))
    assert.equal(verified.body.me.member.id, member.id)
    assert.deepEqual(verified.body.me.workspaces.map((entry: { workspace: { id: string }; role: string }) => [entry.workspace.id, entry.role]), [['ws_research', 'member']])

    // The nonce is single use.
    const replay = await harness.browser().request('POST', '/auth/wallet/verify', { message, signature: await wallet.signMessage(message) })
    assert.equal(replay.status, 400)

    // Later logins need no enrollment.
    const later = harness.browser()
    const second = (await later.request('POST', '/auth/wallet/nonce', { address: wallet.address })).body.message
    const login = await later.request('POST', '/auth/wallet/verify', { message: second, signature: await wallet.signMessage(second) })
    assert.equal(login.status, 200)
    assert.equal(login.body.me.member.credentials[0].kind, 'wallet')
  })

  it('rejects a signature from another wallet and an unknown wallet without enrollment', async () => {
    harness = await startHarness()
    const wallet = Wallet.createRandom()
    const browser = harness.browser()
    const message = (await browser.request('POST', '/auth/wallet/nonce', { address: wallet.address })).body.message
    const forged = await browser.request('POST', '/auth/wallet/verify', { message, signature: await Wallet.createRandom().signMessage(message) })
    assert.equal(forged.status, 401)
    const unknown = (await browser.request('POST', '/auth/wallet/nonce', { address: wallet.address })).body.message
    const response = await browser.request('POST', '/auth/wallet/verify', { message: unknown, signature: await wallet.signMessage(unknown) })
    assert.equal(response.status, 401)
    assert.equal(response.body.error.code, 'unknown_credential')
    // An edited message doesn't match the issued one.
    const issued: string = (await browser.request('POST', '/auth/wallet/nonce', { address: wallet.address })).body.message
    const edited = issued.replace('Sign in to', 'Sign into')
    assert.equal((await browser.request('POST', '/auth/wallet/verify', { message: edited, signature: await wallet.signMessage(edited) })).status, 400)
  })
})

describe('console auth: API keys, tokens and sessions', () => {
  it('opens a read-only key session and ends it when the key is revoked', async () => {
    harness = await startHarness()
    const key = harness.store.addKey()
    const browser = harness.browser()
    assert.equal((await browser.request('POST', '/auth/api-key', { key: 'antseed_wrong' })).status, 401)
    const login = await browser.request('POST', '/auth/api-key', { key: key.secret })
    assert.equal(login.status, 200)
    assert.equal(login.body.kind, 'key')
    assert.equal(login.body.me.key.id, key.id)
    assert.equal(login.body.me.key.usage.spent, '1.250000')
    assert.equal(login.body.me.key.limits.monthly, '10.000000')
    assert.equal((await browser.request('GET', '/auth/me')).body.kind, 'key')

    harness.store.keys.set(key.id, { ...key, status: 'revoked' })
    assert.equal((await browser.request('GET', '/auth/me')).status, 401)

    const expired = harness.store.addKey({ expiresAt: harness.clock.now - 1 })
    assert.equal((await harness.browser().request('POST', '/auth/api-key', { key: expired.secret })).status, 401)

    const fresh = harness.store.addKey()
    const other = harness.browser()
    await other.request('POST', '/auth/api-key', { key: fresh.secret })
    harness.auth.revokeKeySessions(fresh.id)
    assert.equal((await other.request('GET', '/auth/me')).status, 401)
  })

  it('authenticates management tokens from the admin_tokens table, if it exists', async () => {
    harness = await startHarness()
    const browser = harness.browser()
    const secret = 'antseed_admin_' + 'a'.repeat(43)
    assert.equal(await harness.auth.authenticate(fakeRequest({ authorization: `Bearer ${secret}` })), null)

    harness.store.database.exec('CREATE TABLE admin_tokens (id TEXT PRIMARY KEY, label TEXT, token_hash TEXT UNIQUE, scope TEXT, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER)')
    harness.store.database.prepare('INSERT INTO admin_tokens VALUES (?, ?, ?, ?, ?, NULL, NULL)').run('adm_1', 'CI', sha256(secret), 'read', 1)
    const principal = await harness.auth.authenticate(fakeRequest({ authorization: `Bearer ${secret}` }))
    assert.deepEqual(principal, { kind: 'token', tokenId: 'adm_1', scope: 'read' })
    assert.notEqual(harness.store.database.prepare('SELECT last_used_at FROM admin_tokens').pluck().get(), null)
    // Tokens have no /auth/me profile.
    assert.equal((await browser.request('GET', '/auth/me', undefined, { authorization: `Bearer ${secret}` })).status, 403)

    harness.store.database.prepare('UPDATE admin_tokens SET revoked_at = 2').run()
    assert.equal(await harness.auth.authenticate(fakeRequest({ authorization: `Bearer ${secret}` })), null)
  })

  it('expires idle and old sessions, rotates on login and logs out', async () => {
    harness = await startHarness()
    const browser = harness.browser()
    const { passkey } = await claimOwner(harness, browser)

    // Idle timeout.
    harness.clock.now += SESSION_IDLE_MS + 1
    assert.equal((await browser.request('GET', '/auth/me')).status, 401)

    // Absolute lifetime, despite activity.
    assert.equal((await loginPasskey(browser, passkey)).status, 200)
    const started = harness.clock.now
    while (harness.clock.now < started + SESSION_ABSOLUTE_MS - SESSION_IDLE_MS / 2) {
      harness.clock.now += SESSION_IDLE_MS / 2
      assert.equal((await browser.request('GET', '/auth/me')).status, 200)
    }
    harness.clock.now = started + SESSION_ABSOLUTE_MS + 1
    assert.equal((await browser.request('GET', '/auth/me')).status, 401)

    // Rotation: the cookie a browser held before logging in no longer works.
    assert.equal((await loginPasskey(browser, passkey)).status, 200)
    const before = browser.cookies.get('antseed_console')!
    assert.equal((await loginPasskey(browser, passkey)).status, 200)
    const after = browser.cookies.get('antseed_console')!
    assert.notEqual(before, after)
    assert.equal((await harness.raw('GET', '/auth/me', undefined, { host: browser.host, cookie: `antseed_console=${before}` })).status, 401)

    const logout = await browser.request('POST', '/auth/logout')
    assert.equal(logout.status, 204)
    assert.match(browser.lastSetCookies[0]!, /Max-Age=0/)
    assert.equal((await harness.raw('GET', '/auth/me', undefined, { host: browser.host, cookie: `antseed_console=${after}` })).status, 401)
  })

  it('locks out a disabled member immediately', async () => {
    harness = await startHarness()
    const browser = harness.browser()
    const { passkey, me } = await claimOwner(harness, browser)
    harness.store.setStatus(me.me.member.id, 'disabled')
    assert.equal((await browser.request('GET', '/auth/me')).status, 401)
    assert.equal((await loginPasskey(harness.browser(), passkey)).status, 403)

    harness.store.setStatus(me.me.member.id, 'active')
    const again = harness.browser()
    assert.equal((await loginPasskey(again, passkey)).status, 200)
    harness.auth.revokeMemberSessions(me.me.member.id)
    assert.equal((await again.request('GET', '/auth/me')).status, 401)
  })
})

describe('console auth: rate limits and cookies', () => {
  it('limits attempts per account and per client IP', async () => {
    harness = await startHarness()
    const browser = harness.browser()
    let last
    for (let attempt = 0; attempt < 11; attempt += 1) last = await browser.request('POST', '/auth/api-key', { key: 'antseed_guess' })
    assert.equal(last!.status, 429)
    assert.ok(Number(last!.headers['retry-after']) > 0)

    // Per IP: forwarded addresses are trusted because the harness peer is loopback.
    const proxied = harness.browser(undefined, { 'x-forwarded-for': '198.51.100.7' })
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert.equal((await proxied.request('POST', '/auth/api-key', { key: `antseed_guess_${attempt}` })).status, 401)
    }
    assert.equal((await proxied.request('POST', '/auth/api-key', { key: 'antseed_guess_x' })).status, 429)
    const elsewhere = harness.browser(undefined, { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' })
    assert.equal((await elsewhere.request('POST', '/auth/api-key', { key: 'antseed_guess_y' })).status, 401)

    harness.clock.now += 61 * 60 * 1000
    assert.equal((await proxied.request('POST', '/auth/api-key', { key: 'antseed_guess_z' })).status, 401)
  })

  it('marks cookies Secure behind https and off-loopback hosts', async () => {
    harness = await startHarness({ publicUrl: 'https://gateway.example.test' })
    const key = harness.store.addKey()
    const proxied = harness.browser('gateway.example.test', { 'x-forwarded-proto': 'https' })
    await proxied.request('POST', '/auth/api-key', { key: key.secret })
    assert.match(proxied.lastSetCookies[0]!, /; Secure/)

    const publicHost = harness.browser('gateway.example.test')
    await publicHost.request('POST', '/auth/api-key', { key: key.secret })
    assert.match(publicHost.lastSetCookies[0]!, /; Secure/)

    const local = harness.browser(`127.0.0.1:${harness.port}`)
    await local.request('POST', '/auth/api-key', { key: key.secret })
    assert.doesNotMatch(local.lastSetCookies[0]!, /Secure/)
  })
})

function fakeRequest(headers: Record<string, string>): import('node:http').IncomingMessage {
  return { headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as import('node:http').IncomingMessage
}

// Compile-time: the gateway's real deps satisfy what auth needs.
import type { ConsoleDeps } from '../console-api/deps.js'
import type { AuthDeps } from './types.js'
export const consoleDepsSatisfyAuth: (deps: ConsoleDeps) => AuthDeps = (deps) => deps
