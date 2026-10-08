import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from 'jose'
import { GatewayStore } from '../store.js'
import { SoftwarePasskey, startHarness, type Harness } from './test-helpers.js'

let harness: Harness | null = null
let dataDir: string | null = null
afterEach(async () => {
  await harness?.close()
  harness = null
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
})

function realStore(): (now: () => number) => GatewayStore {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-auth-'))
  const dir = dataDir
  return (now) => new GatewayStore(dir, now)
}

describe('console auth against the real GatewayStore', () => {
  it('claims the console, signs in, and accepts store-issued management tokens and invites', async () => {
    harness = await startHarness({ makeStore: realStore() })
    const store = harness.store as unknown as GatewayStore
    const browser = harness.browser()

    const token = harness.auth.createSetupLink().split('#')[1]!
    const setup = await browser.request('POST', '/auth/setup', { token, email: 'owner@example.com' })
    assert.equal(setup.status, 200, JSON.stringify(setup.body))
    const passkey = new SoftwarePasskey()
    const options = await browser.request('POST', '/auth/passkey/register/options', { enrollment: setup.body.enrollment })
    const registered = await browser.request('POST', '/auth/passkey/register/verify', {
      enrollment: setup.body.enrollment, response: passkey.register(options.body, `http://${browser.host}`),
    })
    assert.equal(registered.status, 200, JSON.stringify(registered.body))
    assert.equal(registered.body.me.member.orgRole, 'owner')
    assert.ok(registered.body.me.workspaces.some((entry: { workspace: { isDefault: boolean } }) => entry.workspace.isDefault))
    assert.throws(() => harness!.auth.createSetupLink())

    const { secret, token: adminToken } = store.createAdminToken({ label: 'CI', scope: 'admin', createdBy: null })
    const principal = await harness.auth.authenticate({ headers: { authorization: `Bearer ${secret}` }, socket: { remoteAddress: '127.0.0.1' } } as never)
    assert.deepEqual(principal, { kind: 'token', tokenId: adminToken.id, scope: 'admin' })

    const invite = store.createInvite({ label: 'Dana', email: 'dana@example.com', orgRole: 'member', workspaces: [], expiresAt: harness.clock.now + 3_600_000, createdBy: null })
    const enrollment = await harness.browser().request('POST', '/auth/invite', { token: invite.token })
    assert.equal(enrollment.status, 200)
    assert.equal(enrollment.body.label, 'Dana')

    const key = store.createKey({ label: 'CI key', buyerIdentity: 'default', limits: { daily: null, weekly: null, monthly: 2_000_000, total: null }, expiresAt: null } as never)
    const keyLogin = await harness.browser().request('POST', '/auth/api-key', { key: key.secret })
    assert.equal(keyLogin.status, 200, JSON.stringify(keyLogin.body))
    assert.equal(keyLogin.body.me.key.workspaceId, key.key.workspaceId)
    assert.equal(keyLogin.body.me.key.limits.monthly, '2.000000')
  })

  it('says why an invite or API key did not work', async () => {
    harness = await startHarness({ makeStore: realStore() })
    const store = harness.store as unknown as GatewayStore
    const browser = harness.browser()

    const used = store.createInvite({ label: 'Eli', email: null, orgRole: 'member', workspaces: [], expiresAt: harness.clock.now + 3_600_000, createdBy: null })
    assert.equal((await browser.request('POST', '/auth/invite', { token: used.token })).status, 200)
    const again = await browser.request('POST', '/auth/invite', { token: used.token })
    assert.equal(again.body.error.code, 'invite_used')

    const expired = store.createInvite({ label: 'Fay', email: null, orgRole: 'member', workspaces: [], expiresAt: harness.clock.now - 1, createdBy: null })
    assert.equal((await browser.request('POST', '/auth/invite', { token: expired.token })).body.error.code, 'invite_expired')
    assert.equal((await browser.request('POST', '/auth/invite', { token: 'not-a-token' })).body.error.code, 'invalid_token')

    const limits = { daily: null, weekly: null, monthly: null, total: null }
    const revoked = store.createKey({ label: 'old', buyerIdentity: 'default', limits, expiresAt: null } as never)
    store.revokeKey(revoked.key.id)
    assert.equal((await browser.request('POST', '/auth/api-key', { key: revoked.secret })).body.error.code, 'key_revoked')
    const lapsed = store.createKey({ label: 'lapsed', buyerIdentity: 'default', limits, expiresAt: harness.clock.now - 1 } as never)
    assert.equal((await browser.request('POST', '/auth/api-key', { key: lapsed.secret })).body.error.code, 'key_expired')
    assert.equal((await browser.request('POST', '/auth/api-key', { key: 'antseed_nope' })).body.error.code, 'invalid_key')
  })

  it('auto-joins an allowed domain through Cloudflare Access using the store invite path', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'cf1', alg: 'RS256' } as JWK] })
    harness = await startHarness({
      makeStore: realStore(),
      env: { ANTSEED_CF_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com', ANTSEED_CF_ACCESS_AUD: 'aud-1', ANTSEED_OIDC_ALLOWED_DOMAINS: 'acme.example' },
      authOptions: { cloudflareAccessKeys: jwks },
    })
    const assertion = await new SignJWT({ email: 'new@acme.example' }).setProtectedHeader({ alg: 'RS256', kid: 'cf1' })
      .setIssuer('https://myteam.cloudflareaccess.com').setAudience('aud-1').setSubject('s').setIssuedAt().setExpirationTime('5m').sign(privateKey)
    const me = await harness.browser().request('GET', '/auth/me', undefined, { 'cf-access-jwt-assertion': assertion })
    assert.equal(me.status, 200, JSON.stringify(me.body))
    assert.equal(me.body.me.member.email, 'new@acme.example')
    assert.equal(me.body.me.member.status, 'active')
    assert.deepEqual(me.body.me.workspaces.map((entry: { role: string; workspace: { isDefault: boolean } }) => [entry.workspace.isDefault, entry.role]), [[true, 'member']])
  })
})
