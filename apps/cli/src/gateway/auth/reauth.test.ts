import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Wallet, type HDNodeWallet } from 'ethers'
import { sessionAuthenticatedAt } from './db.js'
import { enrollWallet, reauthWallet, sessionId, SoftwarePasskey, startHarness, type Browser, type Harness } from './test-helpers.js'

let harness: Harness
afterEach(async () => {
  await harness?.close()
})

const MINUTE = 60_000

/** Invites a member, enrolls the given passkey or wallet, and returns the signed-in browser. */
async function enroll(h: Harness, label: string, credential: { passkey?: SoftwarePasskey; wallet?: HDNodeWallet }, orgRole: 'owner' | 'member' = 'member') {
  if (!credential.passkey) return enrollWallet(h, label, credential.wallet!, orgRole)
  const { member, token } = h.store.invite({ label, orgRole }, [['ws_default', 'admin']])
  const browser = h.browser()
  const enrollment = (await browser.request('POST', '/auth/invite', { token })).body.enrollment
  const options = await browser.request('POST', '/auth/passkey/register/options', { enrollment })
  const verified = await browser.request('POST', '/auth/passkey/register/verify', { enrollment, response: credential.passkey.register(options.body, `http://${browser.host}`) })
  assert.equal(verified.status, 200, JSON.stringify(verified.body))
  return { member, browser }
}

async function reauthPasskey(browser: Browser, passkey: SoftwarePasskey) {
  const options = await browser.request('POST', '/auth/reauth/passkey/options', {})
  assert.equal(options.status, 200, JSON.stringify(options.body))
  return browser.request('POST', '/auth/reauth/passkey/verify', { response: passkey.login(options.body, `http://${browser.host}`) })
}

describe('console auth: re-authentication', () => {
  it('refreshes authenticated_at on the same session with the member\'s own passkey', async () => {
    harness = await startHarness()
    const passkey = new SoftwarePasskey()
    const { member, browser } = await enroll(harness, 'Owner', { passkey }, 'owner')
    const before = sessionId(browser)
    const signedInAt = sessionAuthenticatedAt(harness.store.database, before)!

    harness.clock.now += 30 * MINUTE
    const options = await browser.request('POST', '/auth/reauth/passkey/options', {})
    assert.deepEqual(options.body.allowCredentials.map((entry: { id: string }) => entry.id), [passkey.id], 'only this member\'s passkeys are offered')
    const result = await browser.request('POST', '/auth/reauth/passkey/verify', { response: passkey.login(options.body, `http://${browser.host}`) })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.me.member.id, member.id)
    assert.equal(browser.lastSetCookies.length, 0, 'no new session cookie')
    assert.equal(sessionId(browser), before)
    assert.equal(sessionAuthenticatedAt(harness.store.database, before), signedInAt + 30 * MINUTE)
  })

  it('refuses another member\'s passkey and leaves the session untouched', async () => {
    harness = await startHarness()
    const ownPasskey = new SoftwarePasskey()
    const otherPasskey = new SoftwarePasskey()
    const { browser } = await enroll(harness, 'Owner', { passkey: ownPasskey }, 'owner')
    const { member: other } = await enroll(harness, 'Other', { passkey: otherPasskey })
    const session = sessionId(browser)
    const signedInAt = sessionAuthenticatedAt(harness.store.database, session)

    harness.clock.now += 30 * MINUTE
    const refused = await reauthPasskey(browser, otherPasskey)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'reauth_wrong_member')
    assert.equal(browser.lastSetCookies.length, 0)
    assert.equal(sessionId(browser), session)
    assert.equal(sessionAuthenticatedAt(harness.store.database, session), signedInAt)
    const me = await browser.request('GET', '/auth/me')
    assert.notEqual(me.body.me.member.id, other.id, 'still signed in as the owner')

    // A plain sign-in challenge (bound to no member) can't be used to re-authenticate.
    const loginOptions = await browser.request('POST', '/auth/passkey/login/options', {})
    const replayed = await browser.request('POST', '/auth/reauth/passkey/verify', { response: ownPasskey.login(loginOptions.body, `http://${browser.host}`) })
    assert.equal(replayed.status, 400)
    assert.equal(replayed.body.error.code, 'invalid_challenge')
  })

  it('refreshes with the member\'s own wallet and refuses another member\'s or an unknown one', async () => {
    harness = await startHarness()
    const ownWallet = Wallet.createRandom()
    const otherWallet = Wallet.createRandom()
    const { browser } = await enroll(harness, 'Owner', { wallet: ownWallet }, 'owner')
    await enroll(harness, 'Other', { wallet: otherWallet })
    const session = sessionId(browser)
    const signedInAt = sessionAuthenticatedAt(harness.store.database, session)!

    harness.clock.now += 10 * MINUTE
    for (const wallet of [otherWallet, Wallet.createRandom()]) {
      const refused = await reauthWallet(browser, wallet)
      assert.equal(refused.status, 403)
      assert.equal(refused.body.error.code, 'reauth_wrong_member')
      assert.equal(sessionAuthenticatedAt(harness.store.database, session), signedInAt)
    }

    // A signature by a wallet other than the one the nonce was issued to.
    const nonce = (await browser.request('POST', '/auth/reauth/wallet/nonce', { address: ownWallet.address })).body.message
    const forged = await browser.request('POST', '/auth/reauth/wallet/verify', { message: nonce, signature: await otherWallet.signMessage(nonce) })
    assert.equal(forged.status, 401)

    const ok = await reauthWallet(browser, ownWallet)
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(sessionId(browser), session)
    assert.equal(sessionAuthenticatedAt(harness.store.database, session), signedInAt + 10 * MINUTE)
  })

  it('needs a member session', async () => {
    harness = await startHarness()
    const anonymous = harness.browser()
    assert.equal((await anonymous.request('POST', '/auth/reauth/wallet/nonce', { address: Wallet.createRandom().address })).status, 401)
    assert.equal((await anonymous.request('POST', '/auth/reauth/passkey/options', {})).status, 401)

    const key = harness.store.addKey()
    const keySession = harness.browser()
    await keySession.request('POST', '/auth/api-key', { key: key.secret })
    assert.equal((await keySession.request('POST', '/auth/reauth/passkey/options', {})).status, 403)

    // A wallet-only member has no passkey to confirm with.
    const { browser } = await enroll(harness, 'Wallet only', { wallet: Wallet.createRandom() })
    const options = await browser.request('POST', '/auth/reauth/passkey/options', {})
    assert.equal(options.status, 400)
    assert.equal(options.body.error.code, 'no_passkey')
  })
})
