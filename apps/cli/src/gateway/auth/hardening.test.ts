import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { Wallet } from 'ethers'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { GatewayStore } from '../store.js'
import { AuthDb, MAX_PENDING_TICKETS, memberWalletAddresses, sessionAuthenticatedAt, SETUP_TOKEN_TTL_MS, sha256Hex } from './db.js'
import { clientIp } from './http.js'
import { startHarness, type Harness } from './test-helpers.js'

let harness: Harness | null = null
let dataDir: string | null = null
afterEach(async () => {
  await harness?.close()
  harness = null
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
})

function realStore(): (now: () => number) => GatewayStore {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-auth-hard-'))
  const dir = dataDir
  return (now) => new GatewayStore(dir, now)
}

function bearer(secret: string) {
  return { headers: { authorization: `Bearer ${secret}` }, socket: { remoteAddress: '127.0.0.1' } } as never
}

async function cloudflareHarness(extraEnv: Record<string, string> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'cf1', alg: 'RS256' } as JWK] })
  harness = await startHarness({
    makeStore: realStore(),
    env: { ANTSEED_CF_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com', ANTSEED_CF_ACCESS_AUD: 'aud-1', ...extraEnv },
    authOptions: { cloudflareAccessKeys: jwks },
  })
  const h = harness
  return (email: string) => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'cf1' })
    .setIssuer('https://myteam.cloudflareaccess.com').setAudience('aud-1').setSubject(`sub-${email}`)
    .setIssuedAt(Math.floor(h.clock.now / 1000)).setExpirationTime(Math.floor(h.clock.now / 1000) + 300).sign(privateKey)
}

describe('console auth hardening', () => {
  it('refuses expired management tokens and tokens whose creator lost the admin role', async () => {
    harness = await startHarness({ makeStore: realStore() })
    const store = harness.store as unknown as GatewayStore
    const owner = store.createOwner({ label: 'Owner', email: null })
    const cli = store.createAdminToken({ label: 'cli', scope: 'admin', createdBy: null, expiresAt: null })
    assert.equal((await harness.auth.authenticate(bearer(cli.secret)))?.kind, 'token')

    const lapsing = store.createAdminToken({ label: 'lapsing', scope: 'read', createdBy: owner.id, expiresAt: harness.clock.now + 1000 })
    assert.equal((await harness.auth.authenticate(bearer(lapsing.secret)))?.kind, 'token')
    harness.clock.now += 1000
    assert.equal(await harness.auth.authenticate(bearer(lapsing.secret)), null)

    const { invite, token } = store.createInvite({ label: 'Adm', email: null, orgRole: 'admin', workspaces: [], expiresAt: harness.clock.now + 60_000, createdBy: owner.id })
    store.consumeInvite(sha256Hex(token), harness.clock.now)
    const byAdmin = store.createAdminToken({ label: 'adm', scope: 'admin', createdBy: invite.memberId, expiresAt: null })
    assert.equal((await harness.auth.authenticate(bearer(byAdmin.secret)))?.kind, 'token')
    // Demoted without going through the console route (which would also revoke): auth still refuses it.
    store.updateMember(invite.memberId, { orgRole: 'member' })
    assert.equal(await harness.auth.authenticate(bearer(byAdmin.secret)), null)
    store.updateMember(invite.memberId, { orgRole: 'admin' })
    store.setMemberStatus(invite.memberId, 'disabled')
    assert.equal(await harness.auth.authenticate(bearer(byAdmin.secret)), null)
  })

  it('setup links last one hour', async () => {
    harness = await startHarness({ makeStore: realStore() })
    assert.equal(SETUP_TOKEN_TTL_MS, 60 * 60 * 1000)
    const token = harness.auth.createSetupLink().split('#')[1]!
    harness.clock.now += SETUP_TOKEN_TTL_MS + 1
    const setup = await harness.browser().request('POST', '/auth/setup', { token })
    assert.equal(setup.status, 400)
    const store = harness.store as unknown as GatewayStore
    assert.deepEqual(store.listAudit({ action: 'auth' }).entries.map((entry) => [entry.action, entry.details['method']]), [['auth.sign_in_failed', 'setup']])
  })

  it('an owner signing in through Cloudflare Access completes setup', async () => {
    const sign = await cloudflareHarness()
    const token = harness!.auth.createSetupLink().split('#')[1]!
    const setup = await harness!.browser().request('POST', '/auth/setup', { token, email: 'owner@acme.example' })
    assert.equal(setup.status, 200)
    assert.equal(harness!.auth.authConfig().setupRequired, true, 'no credential yet: the setup owner may still re-claim')
    const me = await harness!.browser().request('GET', '/auth/me', undefined, { 'cf-access-jwt-assertion': await sign('owner@acme.example') })
    assert.equal(me.status, 200, JSON.stringify(me.body))
    assert.equal(harness!.auth.authConfig().setupRequired, false)
    assert.throws(() => harness!.auth.createSetupLink())
  })

  it('SSO activates an invited member only while their invite is live', async () => {
    const sign = await cloudflareHarness()
    const store = harness!.store as unknown as GatewayStore
    store.createOwner({ label: 'Owner', email: null })
    const lapsed = store.createInvite({ label: 'Late', email: 'late@acme.example', orgRole: 'member', workspaces: [], expiresAt: harness!.clock.now + 1000, createdBy: null })
    harness!.clock.now += 2000
    const refused = await harness!.browser().request('GET', '/auth/me', undefined, { 'cf-access-jwt-assertion': await sign('late@acme.example') })
    assert.equal(refused.status, 401)
    assert.equal(store.getMember(lapsed.invite.memberId)!.status, 'invited')

    const cancelled = store.createInvite({ label: 'Gone', email: 'gone@acme.example', orgRole: 'member', workspaces: [], expiresAt: harness!.clock.now + 60_000, createdBy: null })
    store.deleteInvite(cancelled.invite.id)
    assert.equal((await harness!.browser().request('GET', '/auth/me', undefined, { 'cf-access-jwt-assertion': await sign('gone@acme.example') })).status, 401)

    const live = store.createInvite({ label: 'Ok', email: 'ok@acme.example', orgRole: 'member', workspaces: [], expiresAt: harness!.clock.now + 60_000, createdBy: null })
    const me = await harness!.browser().request('GET', '/auth/me', undefined, { 'cf-access-jwt-assertion': await sign('ok@acme.example') })
    assert.equal(me.status, 200, JSON.stringify(me.body))
    assert.equal(store.getMember(live.invite.memberId)!.status, 'active')
    assert.notEqual(store.getInvite(live.invite.id)!.usedAt, null, 'the invite is consumed')
  })

  it('records sign-ins and failed sign-ins, and stamps sessions with their sign-in time', async () => {
    harness = await startHarness({ makeStore: realStore() })
    const store = harness.store as unknown as GatewayStore
    store.createOwner({ label: 'Owner', email: null })
    const wallet = Wallet.createRandom()
    const invite = store.createInvite({ label: 'Dana', email: null, orgRole: 'member', workspaces: [], expiresAt: harness.clock.now + 60_000, createdBy: null })
    const browser = harness.browser()
    const enrollment = (await browser.request('POST', '/auth/invite', { token: invite.token })).body.enrollment
    const message = (await browser.request('POST', '/auth/wallet/nonce', { address: wallet.address })).body.message
    const signedIn = await browser.request('POST', '/auth/wallet/verify', { message, signature: await wallet.signMessage(message), enrollment })
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body))

    const other = Wallet.createRandom()
    const second = (await harness.browser().request('POST', '/auth/wallet/nonce', { address: wallet.address })).body.message
    assert.equal((await harness.browser().request('POST', '/auth/wallet/verify', { message: second, signature: await other.signMessage(second) })).status, 401)

    const entries = store.listAudit({ action: 'auth' }).entries
    assert.deepEqual(entries.map((entry) => entry.action), ['auth.sign_in_failed', 'auth.sign_in', 'auth.credential_add', 'auth.invite_accept'])
    assert.deepEqual(entries[0]!.details, { method: 'wallet', code: 'bad_signature' })
    assert.deepEqual(entries[1]!.actor, { kind: 'member', id: invite.invite.memberId, label: 'Dana' })
    assert.equal(entries[1]!.ip, '127.0.0.1')

    const session = store.database.prepare('SELECT id FROM auth_sessions WHERE member_id = ?').get(invite.invite.memberId) as { id: string }
    assert.equal(sessionAuthenticatedAt(store.database, session.id), harness.clock.now)
    assert.equal(sessionAuthenticatedAt(store.database, 'unknown'), null)
    assert.deepEqual(memberWalletAddresses(store.database, invite.invite.memberId), [wallet.address.toLowerCase()])
  })

  it('caps pending passkey challenges and wallet nonces', () => {
    const clock = { now: 1_000_000 }
    const store = realStore()(() => clock.now)
    try {
      const db = new AuthDb(store.database, () => clock.now)
      for (let index = 0; index < MAX_PENDING_TICKETS + 25; index += 1) {
        clock.now += 1
        db.saveChallenge(`challenge-${index}`, 'login', null)
      }
      const count = store.database.prepare('SELECT COUNT(*) FROM auth_challenges').pluck().get() as number
      assert.equal(count, MAX_PENDING_TICKETS)
      assert.equal(db.takeChallenge('challenge-0', 'login'), null, 'the oldest went first')
      assert.notEqual(db.takeChallenge(`challenge-${MAX_PENDING_TICKETS + 24}`, 'login'), null)
      db.saveWalletNonce('n1', `0x${'ab'.repeat(20)}`, 'msg', clock.now - 1)
      db.saveWalletNonce('n2', `0x${'ab'.repeat(20)}`, 'msg', clock.now + 1000)
      assert.equal(store.database.prepare('SELECT COUNT(*) FROM auth_wallet_nonces').pluck().get(), 1, 'expired nonces are swept on insert')
    } finally {
      store.close()
    }
  })

  it('believes CF-Connecting-IP only in Cloudflare tunnel mode', () => {
    const req = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as never
    assert.equal(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.1' })), '127.0.0.1')
    assert.equal(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.1' }), { trustCloudflare: true }), '198.51.100.1')
    assert.equal(clientIp(req('203.0.113.4', { 'cf-connecting-ip': '198.51.100.1' }), { trustCloudflare: true }), '203.0.113.4')
  })
})
