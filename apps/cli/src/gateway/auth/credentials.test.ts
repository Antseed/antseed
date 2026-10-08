import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Wallet, type HDNodeWallet } from 'ethers'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { FRESH_SIGN_IN_MS, sessionSignIn } from './db.js'
import { enrollWallet, reauthWallet, sessionId, SoftwarePasskey, startHarness, type Browser, type Harness } from './test-helpers.js'

let harness: Harness
afterEach(async () => {
  await harness?.close()
})

const MINUTE = 60_000

/** Signs a wallet sign-in message from `browser` (no enrollment: links the wallet to the signed-in member, or signs in with it). */
async function walletVerify(browser: Browser, wallet: HDNodeWallet, headers: Record<string, string> = {}) {
  const message = (await browser.request('POST', '/auth/wallet/nonce', { address: wallet.address }, headers)).body.message
  return browser.request('POST', '/auth/wallet/verify', { message, signature: await wallet.signMessage(message) }, headers)
}

/** Confirms the session with `wallet`, which must succeed. */
async function confirmWithWallet(browser: Browser, wallet: HDNodeWallet) {
  const result = await reauthWallet(browser, wallet)
  assert.equal(result.status, 200, JSON.stringify(result.body))
}

describe('console auth: adding sign-in methods', () => {
  it('needs a fresh sign-in to link a wallet from a session, and audits the add', async () => {
    harness = await startHarness()
    const own = Wallet.createRandom()
    const { member, browser } = await enrollWallet(harness, 'Owner', own, 'owner')

    harness.clock.now += FRESH_SIGN_IN_MS + MINUTE
    const planted = Wallet.createRandom()
    const refused = await walletVerify(browser, planted)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'reauth_required')
    assert.equal(harness.auth.credentialsFor(member.id).length, 1, 'nothing was linked')

    await confirmWithWallet(browser, own)
    const linked = await walletVerify(browser, planted)
    assert.equal(linked.status, 200, JSON.stringify(linked.body))
    assert.equal(harness.auth.credentialsFor(member.id).length, 2)
    const adds = harness.store.audits.filter((entry) => entry.action === 'auth.credential_add')
    assert.deepEqual(adds.map((entry) => entry.details?.['via']), ['enrollment', 'session'])
    assert.equal(adds[1]!.details?.['address'], planted.address.toLowerCase())
    assert.equal(adds[1]!.actor.id, member.id)
  })

  it('needs a fresh sign-in to register a passkey from a session', async () => {
    harness = await startHarness()
    const { browser } = await enrollWallet(harness, 'Owner', Wallet.createRandom(), 'owner')
    const passkey = new SoftwarePasskey()
    const fresh = await browser.request('POST', '/auth/passkey/register/options', {})
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body))

    harness.clock.now += FRESH_SIGN_IN_MS + MINUTE
    const stale = await browser.request('POST', '/auth/passkey/register/options', {})
    assert.equal(stale.status, 403)
    assert.equal(stale.body.error.code, 'reauth_required')
    // Options fetched while fresh don't help once the sign-in went stale.
    const verify = await browser.request('POST', '/auth/passkey/register/verify', { response: passkey.register(fresh.body, `http://${browser.host}`) })
    assert.equal(verify.status, 403)
    assert.equal(verify.body.error.code, 'reauth_required')
  })

  it('records which credential proved each sign-in and re-authentication', async () => {
    harness = await startHarness()
    const first = Wallet.createRandom()
    const { member, browser } = await enrollWallet(harness, 'Owner', first, 'owner')
    const [firstCredential] = harness.auth.credentialsFor(member.id)
    assert.equal(sessionSignIn(harness.store.database, sessionId(browser))?.credentialId, firstCredential!.id)

    const second = Wallet.createRandom()
    assert.equal((await walletVerify(browser, second)).status, 200)
    const secondCredential = harness.auth.credentialsFor(member.id).find((entry) => entry.id !== firstCredential!.id)!
    harness.clock.now += 10 * MINUTE
    await confirmWithWallet(browser, second)
    assert.deepEqual(sessionSignIn(harness.store.database, sessionId(browser)), { authenticatedAt: harness.clock.now, credentialId: secondCredential.id })

    const other = harness.browser()
    assert.equal((await walletVerify(other, first)).status, 200)
    assert.equal(sessionSignIn(harness.store.database, sessionId(other))?.credentialId, firstCredential!.id)
  })
})

describe('console auth: removing sign-in methods', () => {
  it('ends the member\'s other sessions, keeping the caller\'s own', async () => {
    harness = await startHarness()
    const first = Wallet.createRandom()
    const second = Wallet.createRandom()
    const { member, browser } = await enrollWallet(harness, 'Dana', first)
    assert.equal((await walletVerify(browser, second)).status, 200)
    const elsewhere = harness.browser()
    assert.equal((await walletVerify(elsewhere, second)).status, 200)

    const [firstCredential] = harness.auth.credentialsFor(member.id)
    assert.equal(harness.auth.deleteCredential(member.id, firstCredential!.id, sessionId(browser)), true)
    assert.equal((await browser.request('GET', '/auth/me')).status, 200, 'the caller stays signed in')
    assert.equal((await elsewhere.request('GET', '/auth/me')).status, 401, 'other sessions end')

    const secondCredential = harness.auth.credentialsFor(member.id)[0]!
    assert.equal(harness.auth.deleteCredential(member.id, secondCredential.id), true)
    assert.equal((await browser.request('GET', '/auth/me')).status, 401, 'removed by someone else: every session ends')
    assert.equal(harness.auth.deleteCredential(member.id, secondCredential.id), false)
  })

  it('keeps the console claimed once the setup owner has registered a credential', async () => {
    harness = await startHarness()
    const token = harness.auth.createSetupLink().split('#')[1]!
    const browser = harness.browser()
    const enrollment = (await browser.request('POST', '/auth/setup', { token, label: 'Owner' })).body.enrollment
    const wallet = Wallet.createRandom()
    const message = (await browser.request('POST', '/auth/wallet/nonce', { address: wallet.address })).body.message
    const signedIn = await browser.request('POST', '/auth/wallet/verify', { message, signature: await wallet.signMessage(message), enrollment })
    assert.equal(signedIn.status, 200)
    const ownerId = signedIn.body.me.member.id as string
    assert.equal(harness.auth.authConfig().setupRequired, false)

    for (const credential of harness.auth.credentialsFor(ownerId)) harness.auth.deleteCredential(ownerId, credential.id)
    assert.equal(harness.auth.credentialsFor(ownerId).length, 0)
    assert.equal(harness.auth.authConfig().setupRequired, false, 'removing credentials does not reopen setup')
    assert.throws(() => harness.auth.createSetupLink(), /already been claimed/)
  })
})

describe('console auth: Cloudflare Access principals adding a sign-in method', () => {
  it('need an Access token issued within the fresh sign-in window', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'cf1', alg: 'RS256' } as JWK] })
    harness = await startHarness({
      env: { ANTSEED_CF_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com', ANTSEED_CF_ACCESS_AUD: 'aud-123' },
      authOptions: { cloudflareAccessKeys: jwks },
    })
    const sign = (issuedAt: number) => new SignJWT({ email: 'lee@acme.example' }).setProtectedHeader({ alg: 'RS256', kid: 'cf1' })
      .setIssuer('https://myteam.cloudflareaccess.com').setAudience('aud-123').setSubject('cf-sub')
      .setIssuedAt(Math.floor(issuedAt / 1000)).setExpirationTime(Math.floor(harness.clock.now / 1000) + 3600).sign(privateKey)
    const member = harness.store.addMember({ label: 'Lee', email: 'lee@acme.example', orgRole: 'owner' })
    const browser = harness.browser()

    const stale = await walletVerify(browser, Wallet.createRandom(), { 'cf-access-jwt-assertion': await sign(harness.clock.now - FRESH_SIGN_IN_MS - MINUTE) })
    assert.equal(stale.status, 403)
    assert.equal(stale.body.error.code, 'access_reauth_required')
    assert.equal(harness.auth.credentialsFor(member.id).length, 0)

    const fresh = await walletVerify(browser, Wallet.createRandom(), { 'cf-access-jwt-assertion': await sign(harness.clock.now - MINUTE) })
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body))
    assert.equal(harness.auth.credentialsFor(member.id).length, 1)
  })
})
