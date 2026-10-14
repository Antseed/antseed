import { createHash, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import { randomToken } from './db.js'

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret: string
  label: string
  /** Lowercase email domains that may join without an invite; empty disables auto-join. */
  allowedDomains: string[]
}

export interface CloudflareAccessConfig {
  teamDomain: string
  audience: string
}

type Env = Record<string, string | undefined>

export function allowedDomainsFromEnv(env: Env): string[] {
  return (env.ANTSEED_OIDC_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

/** OIDC needs the full client config and an https public URL for its redirect URI. */
export function oidcConfigFromEnv(env: Env, publicUrl: string | null): OidcConfig | null {
  const issuer = env.ANTSEED_OIDC_ISSUER?.trim()
  const clientId = env.ANTSEED_OIDC_CLIENT_ID?.trim()
  const clientSecret = env.ANTSEED_OIDC_CLIENT_SECRET?.trim()
  if (!issuer || !clientId || !clientSecret) return null
  if (!publicUrl || new URL(publicUrl).protocol !== 'https:') return null
  const normalizedIssuer = issuer.replace(/\/+$/, '')
  const isGoogle = /^https:\/\/accounts\.google\.com$/.test(normalizedIssuer)
  return {
    issuer: normalizedIssuer,
    clientId,
    clientSecret,
    label: env.ANTSEED_OIDC_LABEL?.trim() || (isGoogle ? 'Google' : 'Single sign-on'),
    allowedDomains: allowedDomainsFromEnv(env),
  }
}

export function cloudflareAccessConfigFromEnv(env: Env): CloudflareAccessConfig | null {
  const teamDomain = env.ANTSEED_CF_ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const audience = env.ANTSEED_CF_ACCESS_AUD?.trim()
  return teamDomain && audience ? { teamDomain, audience } : null
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  token_endpoint_auth_methods_supported?: string[]
}

/** Verified identity from an ID token or a Cloudflare Access assertion. */
export interface ExternalIdentity {
  issuer: string
  subject: string
  email: string
  /** Google Workspace hosted domain, when present. */
  hostedDomain: string | null
  /** When the token was issued (`iat`, ms); null when it carries none. */
  issuedAt: number | null
}

export class OidcClient {
  private _discovery: Promise<Discovery> | null = null
  private _jwks: JWTVerifyGetKey | null = null

  constructor(readonly config: OidcConfig, private readonly _redirectUri: string, private readonly _fetch: typeof fetch, private readonly _now: () => number) {}

  private async _discover(): Promise<Discovery> {
    if (!this._discovery) {
      this._discovery = (async () => {
        const response = await this._fetch(`${this.config.issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}`)
        const body = await response.json() as Partial<Discovery>
        if (!body.authorization_endpoint || !body.token_endpoint || !body.jwks_uri || !body.issuer) {
          throw new Error('OIDC discovery document is missing endpoints')
        }
        if (body.issuer.replace(/\/+$/, '') !== this.config.issuer) throw new Error('OIDC discovery issuer does not match the configured issuer')
        return body as Discovery
      })()
      // A failed discovery is retried on the next sign-in instead of cached.
      this._discovery.catch(() => { this._discovery = null })
    }
    return this._discovery
  }

  /** Builds the provider redirect; the caller stores state/nonce/verifier. */
  async authorizationUrl(): Promise<{ url: string; state: string; nonce: string; codeVerifier: string }> {
    const discovery = await this._discover()
    const state = randomToken(32)
    const nonce = randomToken(32)
    const codeVerifier = randomToken(48)
    const url = new URL(discovery.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', this._redirectUri)
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    return { url: url.toString(), state, nonce, codeVerifier }
  }

  /** Exchanges the code and verifies the ID token (signature, iss, aud, exp, nonce, email_verified). */
  async identityFromCode(code: string, codeVerifier: string, expectedNonce: string): Promise<ExternalIdentity> {
    const discovery = await this._discover()
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this._redirectUri, code_verifier: codeVerifier })
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
    const methods = discovery.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
    if (methods.includes('client_secret_basic') || !methods.includes('client_secret_post')) {
      const user = encodeURIComponent(this.config.clientId)
      const pass = encodeURIComponent(this.config.clientSecret)
      headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
    } else {
      body.set('client_id', this.config.clientId)
      body.set('client_secret', this.config.clientSecret)
    }
    const response = await this._fetch(discovery.token_endpoint, { method: 'POST', headers, body: body.toString() })
    if (!response.ok) throw new Error(`OIDC token exchange failed with HTTP ${response.status}`)
    const tokens = await response.json() as { id_token?: unknown }
    if (typeof tokens.id_token !== 'string') throw new Error('OIDC token response has no id_token')
    this._jwks ??= createRemoteJWKSet(new URL(discovery.jwks_uri))
    const { payload } = await jwtVerify(tokens.id_token, this._jwks, {
      issuer: discovery.issuer,
      audience: this.config.clientId,
      currentDate: new Date(this._now()),
      requiredClaims: ['exp', 'sub', 'nonce'],
    })
    if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expectedNonce)) throw new Error('OIDC nonce mismatch')
    return identityFromClaims(payload, discovery.issuer, true)
  }
}

export class CloudflareAccessVerifier {
  private readonly _keys: JWTVerifyGetKey

  constructor(private readonly _config: CloudflareAccessConfig, private readonly _now: () => number, keys?: JWTVerifyGetKey) {
    this._keys = keys ?? createRemoteJWKSet(new URL(`https://${_config.teamDomain}/cdn-cgi/access/certs`))
  }

  async verify(assertion: string): Promise<ExternalIdentity> {
    const issuer = `https://${this._config.teamDomain}`
    const { payload } = await jwtVerify(assertion, this._keys, {
      issuer,
      audience: this._config.audience,
      currentDate: new Date(this._now()),
      requiredClaims: ['exp', 'sub', 'email'],
    })
    // Access only issues assertions for identities its IdP verified, so it sends no email_verified claim.
    return identityFromClaims(payload, issuer, false)
  }
}

function identityFromClaims(payload: JWTPayload, issuer: string, requireEmailVerified: boolean): ExternalIdentity {
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@')) throw new Error('identity token has no email')
  if (requireEmailVerified && payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error('identity provider has not verified this email')
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('identity token has no subject')
  return {
    issuer,
    subject: payload.sub,
    email,
    hostedDomain: typeof payload.hd === 'string' ? payload.hd.toLowerCase() : null,
    issuedAt: typeof payload.iat === 'number' ? payload.iat * 1000 : null,
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
