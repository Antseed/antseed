import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, it } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { startHarness, type Browser, type Harness } from './test-helpers.js'

const PUBLIC_URL = 'https://gateway.example.test'
const CLIENT_ID = 'console-client'

interface FakeIssuer {
  url: string
  /** Claims the next authorization will put in the ID token. */
  nextClaims: Record<string, unknown>
  tokenRequests: number
  close(): Promise<void>
}

/** A minimal OpenID provider: discovery, JWKS and a token endpoint that checks PKCE. */
async function startFakeIssuer(): Promise<FakeIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const codes = new Map<string, { challenge: string; nonce: string }>()
  let url = ''
  const issuer: FakeIssuer = { url: '', nextClaims: {}, tokenRequests: 0, close: async () => {} }
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url!, url)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (requestUrl.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, jwks_uri: `${url}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      })
    }
    if (requestUrl.pathname === '/jwks') return json(200, { keys: [jwk] })
    if (requestUrl.pathname === '/authorize') {
      const code = `code-${codes.size + 1}`
      codes.set(code, { challenge: requestUrl.searchParams.get('code_challenge')!, nonce: requestUrl.searchParams.get('nonce')! })
      const back = new URL(requestUrl.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', code)
      back.searchParams.set('state', requestUrl.searchParams.get('state')!)
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }
    if (requestUrl.pathname === '/token' && req.method === 'POST') {
      issuer.tokenRequests += 1
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString('utf8')
      if (basic !== `${CLIENT_ID}:s3cret`) return json(401, { error: 'invalid_client' })
      const grant = codes.get(form.get('code') ?? '')
      if (!grant) return json(400, { error: 'invalid_grant' })
      codes.delete(form.get('code')!)
      const verifierHash = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (verifierHash !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' })
      const idToken = await new SignJWT({ nonce: grant.nonce, email_verified: true, ...issuer.nextClaims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(url).setAudience(CLIENT_ID).setIssuedAt().setExpirationTime('5m')
        .sign(privateKey)
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token: idToken })
    }
    json(404, {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  issuer.url = url
  issuer.close = () => new Promise((resolve) => server.close(() => resolve()))
  return issuer
}

let harness: Harness
let issuer: FakeIssuer | null = null
afterEach(async () => {
  await harness?.close()
  await issuer?.close()
  issuer = null
})

function oidcEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ANTSEED_OIDC_ISSUER: issuer!.url, ANTSEED_OIDC_CLIENT_ID: CLIENT_ID, ANTSEED_OIDC_CLIENT_SECRET: 's3cret', ...extra }
}

/** Runs start → provider → callback in one browser; returns the final redirect location. */
async function signInWithProvider(browser: Browser, query = ''): Promise<string> {
  const start = await browser.request('GET', `/auth/oidc/start${query}`)
  assert.equal(start.status, 302, JSON.stringify(start.body))
  const location = start.headers.location!
  if (location.startsWith('/console')) return location
  assert.match(browser.lastSetCookies[0]!, /antseed_console_oidc=.*SameSite=Lax/)
  const provider = await fetch(location, { redirect: 'manual' })
  const callback = new URL(provider.headers.get('location')!)
  assert.equal(`${callback.origin}${callback.pathname}`, `${PUBLIC_URL}/console/api/auth/oidc/callback`)
  const done = await browser.request('GET', `/auth/oidc/callback${callback.search}`)
  assert.equal(done.status, 302)
  return done.headers.location!
}

describe('console auth: OIDC', () => {
  it('is off without config or without an https public URL', async () => {
    issuer = await startFakeIssuer()
    harness = await startHarness({ publicUrl: 'http://gateway.lan', env: oidcEnv() })
    assert.equal((await harness.browser('gateway.lan').request('GET', '/auth/config')).body.oidc, null)
    await harness.close()
    harness = await startHarness({ publicUrl: PUBLIC_URL })
    assert.equal((await harness.browser('gateway.example.test').request('GET', '/auth/oidc/start')).status, 404)
  })

  it('binds an invited member by verified email, then signs in by subject', async () => {
    issuer = await startFakeIssuer()
    harness = await startHarness({ publicUrl: PUBLIC_URL, env: oidcEnv({ ANTSEED_OIDC_LABEL: 'Acme SSO' }) })
    const browser = harness.browser('gateway.example.test')
    assert.deepEqual((await browser.request('GET', '/auth/config')).body.oidc, { label: 'Acme SSO' })

    const { member } = harness.store.invite({ label: 'Ravi', email: 'ravi@acme.example' })
    issuer.nextClaims = { sub: 'sub-ravi', email: 'Ravi@acme.example' }
    assert.equal(await signInWithProvider(browser), '/console')
    assert.match(browser.lastSetCookies.find((line) => line.startsWith('antseed_console='))!, /; Secure/)
    const me = await browser.request('GET', '/auth/me')
    assert.equal(me.body.me.member.id, member.id)
    assert.equal(me.body.me.member.status, 'active')
    assert.equal(me.body.me.member.credentials[0].kind, 'oidc')

    // Same subject, changed email: still the bound member.
    issuer.nextClaims = { sub: 'sub-ravi', email: 'ravi.new@acme.example' }
    const later = harness.browser('gateway.example.test')
    assert.equal(await signInWithProvider(later), '/console')
    assert.equal((await later.request('GET', '/auth/me')).body.me.member.id, member.id)
  })

  it('binds through an enrollment and refuses strangers, unverified emails and unlinked active members', async () => {
    issuer = await startFakeIssuer()
    harness = await startHarness({ publicUrl: PUBLIC_URL, env: oidcEnv() })
    const browser = harness.browser('gateway.example.test')
    const { member, token } = harness.store.invite({ label: 'Kim', email: null })
    const enrollment = (await browser.request('POST', '/auth/invite', { token })).body.enrollment
    issuer.nextClaims = { sub: 'sub-kim', email: 'kim@elsewhere.example' }
    assert.equal(await signInWithProvider(browser, `?enrollment=${enrollment}`), '/console')
    assert.equal((await browser.request('GET', '/auth/me')).body.me.member.id, member.id)

    issuer.nextClaims = { sub: 'sub-stranger', email: 'who@else.example' }
    assert.equal(await signInWithProvider(harness.browser('gateway.example.test')), '/console/login?error=not_invited')

    issuer.nextClaims = { sub: 'sub-unverified', email: 'kim@elsewhere.example', email_verified: false }
    assert.equal(await signInWithProvider(harness.browser('gateway.example.test')), '/console/login?error=oidc_failed')

    harness.store.addMember({ label: 'Active', email: 'active@acme.example' })
    issuer.nextClaims = { sub: 'sub-active', email: 'active@acme.example' }
    assert.equal(await signInWithProvider(harness.browser('gateway.example.test')), '/console/login?error=not_linked')

    assert.equal(await signInWithProvider(harness.browser('gateway.example.test'), '?enrollment=bogus'), '/console/login?error=invalid_enrollment')
  })

  it('auto-joins allowed domains into the Default workspace', async () => {
    issuer = await startFakeIssuer()
    harness = await startHarness({ publicUrl: PUBLIC_URL, env: oidcEnv({ ANTSEED_OIDC_ALLOWED_DOMAINS: 'acme.example, @corp.example' }) })
    issuer.nextClaims = { sub: 'sub-new', email: 'new@corp.example' }
    const browser = harness.browser('gateway.example.test')
    assert.equal(await signInWithProvider(browser), '/console')
    const me = (await browser.request('GET', '/auth/me')).body.me
    assert.equal(me.member.orgRole, 'member')
    assert.deepEqual(me.workspaces.map((entry: { workspace: { id: string }; role: string }) => [entry.workspace.id, entry.role]), [['ws_default', 'member']])

    issuer.nextClaims = { sub: 'sub-hd', email: 'x@gmail.example', hd: 'acme.example' }
    assert.equal(await signInWithProvider(harness.browser('gateway.example.test')), '/console')
    issuer.nextClaims = { sub: 'sub-no', email: 'x@other.example' }
    assert.equal(await signInWithProvider(harness.browser('gateway.example.test')), '/console/login?error=not_invited')
  })

  it('rejects a callback without the browser state cookie', async () => {
    issuer = await startFakeIssuer()
    harness = await startHarness({ publicUrl: PUBLIC_URL, env: oidcEnv() })
    harness.store.invite({ label: 'Ravi', email: 'ravi@acme.example' })
    issuer.nextClaims = { sub: 'sub-ravi', email: 'ravi@acme.example' }
    const attacker = harness.browser('gateway.example.test')
    const start = await attacker.request('GET', '/auth/oidc/start')
    const provider = await fetch(start.headers.location!, { redirect: 'manual' })
    const callback = new URL(provider.headers.get('location')!)
    // A victim's browser following the attacker's callback link has no matching state cookie.
    const victim = harness.browser('gateway.example.test')
    const response = await victim.request('GET', `/auth/oidc/callback${callback.search}`)
    assert.equal(response.headers.location, '/console/login?error=oidc_state')
    assert.equal(issuer.tokenRequests, 0)
  })
})

describe('console auth: Cloudflare Access', () => {
  async function accessHarness() {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'cf1', alg: 'RS256' } as JWK] })
    harness = await startHarness({
      env: { ANTSEED_CF_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com', ANTSEED_CF_ACCESS_AUD: 'aud-123' },
      authOptions: { cloudflareAccessKeys: jwks },
    })
    const sign = (claims: Record<string, unknown>, audience = 'aud-123', issuerUrl = 'https://myteam.cloudflareaccess.com') =>
      new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'cf1' })
        .setIssuer(issuerUrl).setAudience(audience).setSubject('cf-sub').setIssuedAt(Math.floor(harness.clock.now / 1000)).setExpirationTime(Math.floor(harness.clock.now / 1000) + 300)
        .sign(privateKey)
    return sign
  }

  it('maps a verified Access assertion to a member by email', async () => {
    const sign = await accessHarness()
    const member = harness.store.addMember({ label: 'Lee', email: 'lee@acme.example', orgRole: 'admin' })
    const browser = harness.browser()
    assert.equal((await browser.request('GET', '/auth/config')).body.cloudflareAccess, true)

    const me = await browser.request('GET', '/auth/me', undefined, { 'cf-access-jwt-assertion': await sign({ email: 'lee@acme.example' }) })
    assert.equal(me.status, 200)
    assert.equal(me.body.me.member.id, member.id)

    for (const token of [
      await sign({ email: 'lee@acme.example' }, 'other-aud'),
      await sign({ email: 'lee@acme.example' }, 'aud-123', 'https://evil.cloudflareaccess.com'),
      await sign({ email: 'nobody@acme.example' }),
      'not-a-jwt',
    ]) {
      assert.equal((await browser.request('GET', '/auth/me', undefined, { 'cf-access-jwt-assertion': token })).status, 401)
    }

    harness.store.setStatus(member.id, 'disabled')
    assert.equal((await browser.request('GET', '/auth/me', undefined, { 'cf-access-jwt-assertion': await sign({ email: 'lee@acme.example' }) })).status, 401)
  })
})
