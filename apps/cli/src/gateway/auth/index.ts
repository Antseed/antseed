import type * as http from 'node:http'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { errorMessage } from '../errors.js'
import { ADMIN_TOKEN_PREFIX, parseBearerToken } from '../keys.js'
import { BUDGET_PERIODS } from '../limits.js'
import { usdcToDecimalString } from '../money.js'
import {
  ConsoleError,
  respond,
  type ConsoleAuth,
  type ConsoleRequest,
  type ConsoleResponse,
  type ConsoleRouter,
  type Principal,
} from '../console-api/router.js'
import type { ApiKey, AuthConfig, Enrollment, Member, MeResponse, RoutingPolicy, SpendLimits, WorkspaceRole, WorkspaceSummary } from '../console-api/types.js'
import {
  AuthDb,
  FRESH_SIGN_IN_MS,
  OIDC_STATE_TTL_MS,
  SESSION_ABSOLUTE_MS,
  WALLET_NONCE_TTL_MS,
  sessionSignIn,
  sha256Hex,
  type CredentialRow,
  type NewCredential,
} from './db.js'
import {
  appendSetCookie,
  clientIp,
  headerValue,
  isIpHostname,
  OIDC_STATE_COOKIE,
  RateLimiter,
  rateLimited,
  readCookie,
  redirect,
  requestOrigin,
  serializeCookie,
  SESSION_COOKIE,
} from './http.js'
import {
  allowedDomainsFromEnv,
  cloudflareAccessConfigFromEnv,
  CloudflareAccessVerifier,
  oidcConfigFromEnv,
  OidcClient,
  safeEqual,
  type ExternalIdentity,
} from './oidc.js'
import type { AuthDeps, AuthKey, AuthMember, ConsoleAuthOptions } from './types.js'
import { buildSignInMessage, newWalletNonce, nonceFromMessage, normalizeAddress, recoverSigner } from './wallet.js'

export type { AuthDeps, AuthKey, AuthMember, AuthStore, ConsoleAuthOptions, NewAuthMember } from './types.js'

const DEFAULT_GATEWAY_PORT = 8379
const SETUP_OWNER_META = 'setup_owner_id'
const RP_NAME = 'Antseed gateway'
const OIDC_COOKIE_PATH = '/console/api/auth/oidc'

export interface ConsoleAuthService extends ConsoleAuth {
  /** Single-use owner setup link (publicUrl, else http://localhost:<port>); throws once the console has been claimed. */
  createSetupLink(): string
  /** The gateway's listen port, for setup links when there is no publicUrl. */
  setGatewayPort(port: number): void
  /** Without a request (e.g. `GET /settings`), passkey availability is judged from publicUrl alone. */
  authConfig(req?: http.IncomingMessage): AuthConfig
  /** A member's sign-in methods in the console's `Member.credentials` shape. */
  credentialsFor(memberId: string): Member['credentials']
  /**
   * Removes one sign-in method (DELETE /members/:id/credentials/:credentialId)
   * and ends the member's sessions, except `keepSessionId` (the caller's own).
   */
  deleteCredential(memberId: string, credentialId: string, keepSessionId?: string | null): boolean
}

type LoginError = 'not_invited' | 'not_linked' | 'disabled' | 'invalid_enrollment'

export function createConsoleAuth(deps: AuthDeps, options: ConsoleAuthOptions = {}): ConsoleAuthService {
  const { store } = deps
  const env = options.env ?? process.env
  const db = new AuthDb(store.database, deps.now)
  const publicUrl = deps.publicUrl ? deps.publicUrl.replace(/\/+$/, '') : null
  let gatewayPort = options.gatewayPort ?? deps.gatewayPort ?? DEFAULT_GATEWAY_PORT

  const oidcConfig = oidcConfigFromEnv(env, publicUrl)
  const oidc = oidcConfig && publicUrl
    ? new OidcClient(oidcConfig, `${publicUrl}/console/api/auth/oidc/callback`, options.fetch ?? fetch, deps.now)
    : null
  if (!oidcConfig && env.ANTSEED_OIDC_ISSUER && (!publicUrl || !publicUrl.startsWith('https://'))) {
    deps.log('OIDC sign-in is disabled: it needs an https public URL for its redirect URI.')
  }
  const cfConfig = cloudflareAccessConfigFromEnv(env)
  const cloudflare = cfConfig ? new CloudflareAccessVerifier(cfConfig, deps.now, options.cloudflareAccessKeys) : null
  const allowedDomains = allowedDomainsFromEnv(env)

  const trustCloudflare = deps.trustCloudflareHeaders === true
  const ipOf = (req: http.IncomingMessage): string => clientIp(req, { trustCloudflare })

  const ipLimiter = new RateLimiter([{ limit: 30, ms: 60_000 }, { limit: 300, ms: 3_600_000 }], deps.now)
  const accountLimiter = new RateLimiter([{ limit: 10, ms: 60_000 }, { limit: 100, ms: 3_600_000 }], deps.now)

  function limit(req: http.IncomingMessage, account?: string): ConsoleResponse | null {
    const ipWait = ipLimiter.hit(`ip:${ipOf(req)}`)
    const accountWait = account ? accountLimiter.hit(account) : null
    const wait = Math.max(ipWait ?? 0, accountWait ?? 0)
    return wait > 0 ? rateLimited(wait) : null
  }

  // ── Audit ───────────────────────────────────────────────────────────────

  type AuditActor = { kind: 'member' | 'key' | 'system'; id: string | null; label?: string | null }

  function recordAudit(req: http.IncomingMessage, actor: AuditActor, action: string, details: Record<string, unknown> = {}): void {
    if (!store.recordAudit) return
    try {
      store.recordAudit({ actor, action, details, ip: req.socket ? ipOf(req) : null })
    } catch (error) {
      deps.log(`Console: AUDIT WRITE FAILED for ${action}: ${errorMessage(error)}`)
    }
  }

  function memberActor(memberId: string): AuditActor {
    return { kind: 'member', id: memberId, label: store.getMember(memberId)?.label ?? null }
  }

  /** Records a refused sign-in (never the secret that was tried) and passes the error on. */
  function signInFailures(method: string, handler: (request: ConsoleRequest) => Promise<unknown>): (request: ConsoleRequest) => Promise<unknown> {
    return async (request) => {
      try {
        return await handler(request)
      } catch (error) {
        if (error instanceof ConsoleError && error.status >= 400 && error.status < 500 && error.status !== 429) {
          recordAudit(request.raw, { kind: 'system', id: null }, 'auth.sign_in_failed', { method, code: error.code })
        }
        throw error
      }
    }
  }

  // ── Setup state ─────────────────────────────────────────────────────────

  /** An owner created by a setup link who never registered a credential may re-claim with a new link. */
  function pendingSetupOwner(): AuthMember | null {
    const id = db.getMeta(SETUP_OWNER_META)
    if (!id) return null
    if (db.countCredentials(id) > 0) {
      // Claimed for good: removing credentials later must not reopen setup.
      db.setMeta(SETUP_OWNER_META, '')
      return null
    }
    const member = store.getMember(id)
    return member && member.status !== 'disabled' ? member : null
  }

  function setupClaimable(): boolean {
    return !store.isSetupComplete() || pendingSetupOwner() !== null
  }

  // ── Principals and sessions ─────────────────────────────────────────────

  function memberPrincipal(member: AuthMember, sessionId: string): Principal | null {
    if (member.status !== 'active') return null
    return { kind: 'member', memberId: member.id, orgRole: member.orgRole, workspaceRoles: store.memberWorkspaceRoles(member.id), sessionId }
  }

  function keyUsable(key: AuthKey | null): key is AuthKey {
    return key !== null && key.status === 'active' && (key.expiresAt === null || key.expiresAt > deps.now())
  }

  function startSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    principal: { kind: 'member'; memberId: string } | { kind: 'key'; keyId: string },
    method: string,
    credentialId: string | null = null,
  ): string {
    // Rotate: a login always replaces whatever session this browser had,
    // and a new session is a fresh sign-in (see FRESH_SIGN_IN_MS).
    const previous = readCookie(req, SESSION_COOKIE)
    if (previous) db.deleteSessionBySecret(previous)
    db.sweep()
    const secret = db.createSession(principal, { userAgent: headerValue(req, 'user-agent'), ip: ipOf(req) }, credentialId)
    if (principal.kind === 'member') {
      recordAudit(req, memberActor(principal.memberId), 'auth.sign_in', { method })
    } else {
      recordAudit(req, { kind: 'key', id: principal.keyId, label: store.getKey(principal.keyId)?.label ?? null }, 'auth.sign_in', { method: 'api-key' })
    }
    appendSetCookie(res, serializeCookie(req, SESSION_COOKIE, secret, { maxAgeSeconds: SESSION_ABSOLUTE_MS / 1000, path: '/console', sameSite: 'Strict' }))
    return sha256Hex(secret)
  }

  async function startMemberSession(request: ConsoleRequest, member: AuthMember, method: string, credentialId: string): Promise<MeResponse> {
    if (member.status !== 'active') throw new ConsoleError(403, 'member_disabled', 'This member cannot sign in.')
    const sessionId = startSession(request.raw, request.res, { kind: 'member', memberId: member.id }, method, credentialId)
    return me(memberPrincipal(member, sessionId)!)
  }

  async function authenticate(req: http.IncomingMessage): Promise<Principal | null> {
    const bearer = parseBearerToken(headerValue(req, 'authorization') ?? undefined)
    if (bearer?.startsWith(ADMIN_TOKEN_PREFIX)) {
      if (store.findAdminTokenBySecret) {
        const token = store.findAdminTokenBySecret(bearer)
        if (!token || token.revokedAt !== null) return null
        if (typeof token.expiresAt === 'number' && token.expiresAt <= deps.now()) return null
        // A token is only as good as its creator's role (null: created from the CLI).
        if (token.createdBy) {
          const creator = store.getMember(token.createdBy)
          if (!creator || creator.status !== 'active' || (creator.orgRole !== 'owner' && creator.orgRole !== 'admin')) return null
        }
        store.touchAdminToken?.(token.id)
        return { kind: 'token', tokenId: token.id, scope: token.scope }
      }
      const token = db.findAdminToken(bearer)
      return token ? { kind: 'token', tokenId: token.id, scope: token.scope } : null
    }

    const cookie = readCookie(req, SESSION_COOKIE)
    if (cookie) {
      const session = db.findSession(cookie)
      if (session?.kind === 'member' && session.member_id) {
        const member = store.getMember(session.member_id)
        const principal = member ? memberPrincipal(member, session.id) : null
        if (principal) return principal
        db.deleteSession(session.id)
      } else if (session?.kind === 'key' && session.key_id) {
        if (keyUsable(store.getKey(session.key_id))) return { kind: 'key', keyId: session.key_id, sessionId: session.id }
        db.deleteSession(session.id)
      }
    }

    const assertion = headerValue(req, 'cf-access-jwt-assertion')
    if (cloudflare && assertion) {
      let identity: ExternalIdentity
      try {
        identity = await cloudflare.verify(assertion)
      } catch {
        return null
      }
      const resolved = resolveExternalMember(identity, null, false)
      if (!('member' in resolved)) return null
      // The setup owner arriving through Access has claimed the console: an
      // outstanding setup link must not be able to claim it again.
      if (db.getMeta(SETUP_OWNER_META) === resolved.member.id && db.countCredentials(resolved.member.id) === 0) {
        db.setMeta(SETUP_OWNER_META, '')
        deps.log('Console: the owner signed in through Cloudflare Access; setup is complete.')
      }
      return memberPrincipal(resolved.member, `cf-access:${sha256Hex(identity.subject).slice(0, 16)}`)
    }
    return null
  }

  /**
   * Maps a verified external identity to a member: a bound OIDC credential,
   * then the enrollment the flow started with, then an invited member with
   * that email, then domain auto-join. Cloudflare Access (no credential
   * binding) also accepts an active member by email, since Access already
   * gates who reaches the gateway.
   */
  function resolveExternalMember(identity: ExternalIdentity, enrollmentMemberId: string | null, bindCredential: boolean, req: http.IncomingMessage | null = null): { member: AuthMember } | { error: LoginError } {
    if (bindCredential) {
      const credential = db.findOidc(identity.issuer, identity.subject)
      if (credential) {
        const member = store.getMember(credential.member_id)
        if (!member) return { error: 'not_invited' }
        if (member.status !== 'active') return { error: 'disabled' }
        db.touchCredential(credential.id)
        return { member }
      }
    }
    const bind = (member: AuthMember): { member: AuthMember } => {
      if (bindCredential) {
        addCredential(req, member, { kind: 'oidc', label: `${oidcConfig?.label ?? 'Single sign-on'} (${identity.email})`, issuer: identity.issuer, subject: identity.subject }, enrollmentMemberId ? 'enrollment' : 'sign-in')
      }
      return { member }
    }
    if (enrollmentMemberId) {
      const member = store.getMember(enrollmentMemberId)
      if (!member) return { error: 'invalid_enrollment' }
      if (member.status === 'disabled') return { error: 'disabled' }
      if (member.status === 'invited') {
        const activated = activateWithInvite(member.id)
        return activated ? bind(activated) : { error: 'not_invited' }
      }
      return bind(member)
    }
    const byEmail = store.findMemberByEmail(identity.email)
    if (byEmail) {
      if (byEmail.status === 'disabled') return { error: 'disabled' }
      if (byEmail.status === 'invited') {
        // Only while their invite is live: an expired or cancelled invite
        // must not turn into access because the email still matches.
        const activated = activateWithInvite(byEmail.id)
        return activated ? bind(activated) : { error: 'not_invited' }
      }
      return bindCredential ? { error: 'not_linked' } : { member: byEmail }
    }
    const domain = identity.email.split('@').pop() ?? ''
    if (allowedDomains.length > 0 && (allowedDomains.includes(domain) || (identity.hostedDomain !== null && allowedDomains.includes(identity.hostedDomain)))) {
      const member = autoJoin(identity.email)
      if (!member) return { error: 'not_invited' }
      deps.log(`Console: ${identity.email} joined via allowed domain ${domain}.`)
      return bind(member)
    }
    return { error: 'not_invited' }
  }

  /** Activates an invited member by consuming their newest live (unexpired, unused) invite; null when there is none. */
  function activateWithInvite(memberId: string): AuthMember | null {
    const now = deps.now()
    const hash = store.liveInviteHash(memberId, now)
    return hash ? store.consumeInvite(hash, now) : null
  }

  /** New active member in the Default workspace as role member. */
  function autoJoin(email: string): AuthMember | null {
    const defaultWorkspace = store.listWorkspaces?.().find((workspace) => workspace.isDefault) ?? null
    const workspaces = defaultWorkspace ? [{ workspaceId: defaultWorkspace.id, role: 'member' as const }] : []
    if (store.createMember) return store.createMember({ label: email, email, orgRole: 'member', status: 'active', workspaces })
    if (store.createInvite) {
      // Same records an accepted invite leaves behind, which also keeps an audit trail of the join.
      const { token } = store.createInvite({ label: email, email, orgRole: 'member', workspaces, expiresAt: deps.now() + 60_000, createdBy: null })
      return store.consumeInvite(sha256Hex(token), deps.now())
    }
    deps.log('Console sign-in: domain auto-join is configured but the store cannot create members.')
    return null
  }

  // ── Presentation ────────────────────────────────────────────────────────

  function credentialsFor(memberId: string): Member['credentials'] {
    return db.listCredentials(memberId).map((row: CredentialRow) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }))
  }

  function presentMember(member: AuthMember): Member {
    const credentials = credentialsFor(member.id)
    if (options.presentMember) return options.presentMember(member, credentials)
    return {
      id: member.id,
      label: member.label,
      email: member.email,
      orgRole: member.orgRole,
      status: member.status,
      credentials,
      limits: toSpendLimits(member.limits),
      routingPolicy: (member.routingPolicy ?? null) as RoutingPolicy | null,
      maxKeys: member.maxKeys ?? null,
      createdAt: member.createdAt,
    }
  }

  function presentKey(key: AuthKey): ApiKey {
    if (options.presentKey) return options.presentKey(key)
    const now = new Date(deps.now())
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    const total = store.usageStats?.(key.id, 0)
    const month = store.usageStats?.(key.id, monthStart)
    return {
      id: key.id,
      label: key.label,
      hint: key.hint,
      workspaceId: key.workspaceId ?? store.workspaceForKey?.(key.id)?.id ?? 'default',
      ownerMemberId: key.ownerMemberId ?? null,
      buyerIdentity: key.buyerIdentity,
      status: key.status,
      limits: toSpendLimits(key.limits),
      routingPolicy: (key.routingPolicy ?? null) as RoutingPolicy | null,
      topupEnabled: key.topupEnabled,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      usage: {
        requests: total?.requests ?? 0,
        spent: usdcToDecimalString(total?.spentUsdc ?? 0),
        spentThisMonth: usdcToDecimalString(month?.spentUsdc ?? 0),
      },
    }
  }

  function memberWorkspaces(member: AuthMember, roles: ReadonlyMap<string, WorkspaceRole>): Array<{ workspace: WorkspaceSummary; role: WorkspaceRole }> {
    const all = store.listWorkspaces?.() ?? null
    const summary = (workspace: WorkspaceSummary): WorkspaceSummary => ({ id: workspace.id, name: workspace.name, isDefault: workspace.isDefault })
    if (all && (member.orgRole === 'owner' || member.orgRole === 'admin')) {
      return all.map((workspace) => ({ workspace: summary(workspace), role: roles.get(workspace.id) ?? 'admin' }))
    }
    const result: Array<{ workspace: WorkspaceSummary; role: WorkspaceRole }> = []
    for (const [workspaceId, role] of roles) {
      const workspace = store.getWorkspace?.(workspaceId) ?? all?.find((candidate) => candidate.id === workspaceId) ?? null
      if (workspace) result.push({ workspace: summary(workspace), role })
    }
    return result
  }

  async function me(principal: Principal): Promise<MeResponse> {
    if (principal.kind === 'member') {
      const member = store.getMember(principal.memberId)
      if (!member) throw new ConsoleError(401, 'unauthenticated', 'Sign in again.')
      return { kind: 'member', me: { member: presentMember(member), workspaces: memberWorkspaces(member, store.memberWorkspaceRoles(member.id)) } }
    }
    if (principal.kind === 'key') {
      const key = store.getKey(principal.keyId)
      if (!key) throw new ConsoleError(401, 'unauthenticated', 'Sign in again.')
      return { kind: 'key', me: { key: presentKey(key) } }
    }
    throw new ConsoleError(400, 'not_supported', 'Management tokens have no console profile.')
  }

  // ── Helpers for routes ──────────────────────────────────────────────────

  /** Why an invite token did not work, read from the gateway store's invites table when there is one. */
  function inviteState(tokenHash: string): 'used' | 'expired' | 'unknown' {
    try {
      const row = store.database.prepare('SELECT used_at, expires_at FROM invites WHERE token_hash = ?').get(tokenHash) as { used_at: number | null; expires_at: number } | undefined
      if (!row) return 'unknown'
      if (row.used_at !== null) return 'used'
      return row.expires_at <= deps.now() ? 'expired' : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  function rpFor(req: http.IncomingMessage): { origin: string; hostname: string; host: string } {
    const rp = requestOrigin(req, publicUrl)
    if (!rp) throw new ConsoleError(400, 'public_url_required', 'Set the gateway public URL to sign in from another host.')
    return rp
  }

  function passkeyAvailable(req?: http.IncomingMessage): boolean {
    const rp = passkeyOrigin(req)
    if (!rp || isIpHostname(rp.hostname)) return false
    // WebAuthn needs a secure context: https, or localhost.
    return rp.origin.startsWith('https://') || rp.hostname === 'localhost' || rp.hostname.endsWith('.localhost')
  }

  /** The relying party passkeys are judged against: the request's origin, or without a request the public URL's. */
  function passkeyOrigin(req?: http.IncomingMessage): ReturnType<typeof requestOrigin> {
    if (req) return requestOrigin(req, publicUrl)
    return publicUrl ? requestOrigin({} as http.IncomingMessage, publicUrl) : null
  }

  /** The relying party for a passkey ceremony; refused when passkeys cannot work on this origin. */
  function passkeyRp(req: http.IncomingMessage): { origin: string; hostname: string; host: string } {
    if (!passkeyAvailable(req)) throw new ConsoleError(400, 'passkey_unavailable', 'Passkeys need https or localhost.')
    return rpFor(req)
  }

  function memberPasskeys(memberId: string): CredentialRow[] {
    return db.listCredentials(memberId).filter((row) => row.kind === 'passkey' && row.webauthn_id)
  }

  /** The member signed in to this request's session (or Cloudflare Access), if any. */
  async function signedInMember(request: ConsoleRequest): Promise<{ principal: Principal | null; member: AuthMember | null }> {
    const principal = request.principal ?? await authenticate(request.raw)
    const member = principal?.kind === 'member' ? store.getMember(principal.memberId) : null
    return { principal, member }
  }

  /** Every new sign-in method goes through here: it is audited, and the setup owner's first one closes setup for good. */
  function addCredential(req: http.IncomingMessage | null, member: AuthMember, credential: NewCredential, via: 'enrollment' | 'session' | 'sign-in'): CredentialRow {
    const row = db.addCredential(member.id, credential)
    if (db.getMeta(SETUP_OWNER_META) === member.id) db.setMeta(SETUP_OWNER_META, '')
    const details = { credentialId: row.id, kind: row.kind, label: row.label, via, ...(row.wallet_address ? { address: row.wallet_address } : {}) }
    if (req) recordAudit(req, { kind: 'member', id: member.id, label: member.label }, 'auth.credential_add', details)
    deps.log(`Console: ${row.kind} sign-in method added for member ${member.id} (${via}).`)
    return row
  }

  /**
   * Adding a sign-in method from an existing session needs a recent sign-in
   * (FRESH_SIGN_IN_MS), so a stolen session cookie can't plant its own
   * credential. Sessions confirm through `/auth/reauth/*`; Cloudflare Access
   * principals have no session row, so their Access token must be fresh.
   */
  async function requireFreshSignIn(request: ConsoleRequest, principal: Principal | null): Promise<void> {
    if (principal?.kind !== 'member') throw new ConsoleError(401, 'unauthenticated', 'Sign in first.')
    const now = deps.now()
    if (principal.sessionId.startsWith('cf-access:')) {
      const assertion = headerValue(request.raw, 'cf-access-jwt-assertion')
      let issuedAt: number | null = null
      if (cloudflare && assertion) {
        try {
          issuedAt = (await cloudflare.verify(assertion)).issuedAt
        } catch {
          issuedAt = null
        }
      }
      if (issuedAt === null || now - issuedAt > FRESH_SIGN_IN_MS) {
        throw new ConsoleError(403, 'access_reauth_required', 'Your Cloudflare Access sign-in is more than 5 minutes old. Sign out of Cloudflare Access, sign in again, then retry.')
      }
      return
    }
    const signIn = sessionSignIn(store.database, principal.sessionId)
    if (!signIn || now - signIn.authenticatedAt > FRESH_SIGN_IN_MS) {
      throw new ConsoleError(403, 'reauth_required', 'Confirm it\'s you (passkey or wallet) before adding a sign-in method, then retry.')
    }
  }

  /** The member registering a credential: from an enrollment ticket, or the signed-in member adding another one (after a fresh sign-in). */
  async function enrollingMember(request: ConsoleRequest, enrollment: string | null): Promise<{ member: AuthMember; viaSession: boolean }> {
    if (enrollment) {
      const memberId = db.peekEnrollment(enrollment)
      const member = memberId ? store.getMember(memberId) : null
      if (!member) throw new ConsoleError(400, 'invalid_enrollment', 'This sign-up link has expired. Ask for a new one.')
      return { member, viaSession: false }
    }
    const { principal, member } = await signedInMember(request)
    if (!member) throw new ConsoleError(401, 'unauthenticated', 'Sign in or use an invite link first.')
    await requireFreshSignIn(request, principal)
    return { member, viaSession: true }
  }

  function enrollmentFor(member: AuthMember): Enrollment {
    return { enrollment: db.createEnrollment(member.id), label: member.label, orgRole: member.orgRole }
  }

  function loginRedirectTo(res: http.ServerResponse, error: string): undefined {
    return redirect(res, `/console/login?error=${encodeURIComponent(error)}`)
  }

  function clearCookie(req: http.IncomingMessage, res: http.ServerResponse, name: string, path: string, sameSite: 'Strict' | 'Lax'): void {
    appendSetCookie(res, serializeCookie(req, name, '', { maxAgeSeconds: 0, path, sameSite }))
  }

  async function verifyPasskey(raw: http.IncomingMessage, response: AuthenticationResponseJSON, challenge: string, stored: CredentialRow) {
    const rp = rpFor(raw)
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.hostname,
        credential: {
          id: stored.webauthn_id!,
          publicKey: new Uint8Array(stored.public_key!),
          counter: stored.counter ?? 0,
          transports: parseTransports(stored.transports),
        },
        requireUserVerification: false,
      })
    } catch (error) {
      throw new ConsoleError(401, 'passkey_invalid', `Passkey sign-in failed: ${errorMessage(error)}`)
    }
    if (!verification.verified) throw new ConsoleError(401, 'passkey_invalid', 'Passkey sign-in could not be verified.')
    return verification
  }

  function walletNonce(raw: http.IncomingMessage, value: unknown): { message: string } {
    const address = normalizeAddress(value)
    if (!address) throw new ConsoleError(400, 'invalid_address', 'Enter a valid wallet address.')
    const rp = rpFor(raw)
    const nonce = newWalletNonce()
    const issuedAt = deps.now()
    const expiresAt = issuedAt + WALLET_NONCE_TTL_MS
    const message = buildSignInMessage({ domain: rp.host, address, uri: `${rp.origin}/console`, nonce, issuedAt, expiresAt })
    db.saveWalletNonce(nonce, address, message, expiresAt)
    return { message }
  }

  /** Consumes the message's nonce and returns the (lower-case) signer, which must be the address the nonce was issued to. */
  function verifyWalletSignature(message: string, signature: string, signer = recoverSigner(message, signature)): string {
    const nonce = nonceFromMessage(message)
    const saved = nonce ? db.takeWalletNonce(nonce) : null
    if (!saved || !safeEqual(saved.message, message)) throw new ConsoleError(400, 'invalid_nonce', 'This sign-in message expired. Try again.')
    if (!signer || signer !== saved.address) throw new ConsoleError(401, 'bad_signature', 'The signature does not match this wallet.')
    return signer
  }

  /** The member whose session is being re-authenticated; only real session rows can be refreshed. */
  function reauthMemberId(request: ConsoleRequest): string {
    const principal = request.principal
    if (principal?.kind !== 'member') throw new ConsoleError(403, 'forbidden', 'Only members can confirm a sign-in.')
    if (principal.sessionId.startsWith('cf-access:')) {
      throw new ConsoleError(409, 'reauth_unavailable', 'This session comes from Cloudflare Access; sign in with a passkey or wallet to confirm.')
    }
    return principal.memberId
  }

  function wrongMember(request: ConsoleRequest, method: string, message: string): ConsoleError {
    const principal = request.principal as Extract<Principal, { kind: 'member' }>
    recordAudit(request.raw, memberActor(principal.memberId), 'auth.reauth_failed', { method, code: 'reauth_wrong_member' })
    return new ConsoleError(403, 'reauth_wrong_member', message)
  }

  async function finishReauth(request: ConsoleRequest, method: string, credentialId: string): Promise<MeResponse> {
    const principal = request.principal as Extract<Principal, { kind: 'member' }>
    if (!db.markAuthenticated(principal.sessionId, credentialId)) throw new ConsoleError(401, 'unauthenticated', 'Sign in again.')
    recordAudit(request.raw, memberActor(principal.memberId), 'auth.reauth', { method })
    return me(principal)
  }

  // ── Routes ──────────────────────────────────────────────────────────────

  const PUBLIC = { public: true }
  /** Re-authentication routes: only for the signed-in member's own session. */
  const MEMBER_ONLY = { allow: ['member'] as const }

  function registerRoutes(router: ConsoleRouter): void {
    router.add('GET', '/auth/config', async ({ raw }) => authConfig(raw), PUBLIC)
    registerClaimRoutes(router)
    registerPasskeyRoutes(router)
    registerWalletRoutes(router)
    registerOidcRoutes(router)
    registerReauthRoutes(router)
    registerSessionRoutes(router)
  }

  /** Setup and invite links: each hands out an enrollment for registering a first sign-in method. */
  function registerClaimRoutes(router: ConsoleRouter): void {
    router.add('POST', '/auth/setup', signInFailures('setup', async ({ raw, body }) => {
      const limited = limit(raw, 'setup')
      if (limited) return limited
      const input = objectBody(body)
      const token = stringField(input, 'token')
      if (!setupClaimable()) throw new ConsoleError(409, 'setup_complete', 'This console has already been claimed.')
      if (!db.consumeSetupToken(token)) throw new ConsoleError(400, 'invalid_token', 'This setup link is invalid, used or expired. Ask the gateway operator for a new one.')
      const owner = pendingSetupOwner() ?? store.createOwner({
        label: optionalString(input, 'label') ?? 'Owner',
        email: optionalString(input, 'email')?.toLowerCase() ?? null,
      })
      db.setMeta(SETUP_OWNER_META, owner.id)
      deps.log('Console: setup link used; the owner is registering a sign-in method.')
      recordAudit(raw, { kind: 'member', id: owner.id, label: owner.label }, 'auth.setup_claim')
      return enrollmentFor(owner)
    }), PUBLIC)

    router.add('POST', '/auth/invite', signInFailures('invite', async ({ raw, body }) => {
      const token = stringField(objectBody(body), 'token')
      const tokenHash = sha256Hex(token)
      const limited = limit(raw, `invite:${tokenHash}`)
      if (limited) return limited
      const member = store.consumeInvite(tokenHash, deps.now())
      if (!member) {
        const state = inviteState(tokenHash)
        if (state === 'used') throw new ConsoleError(400, 'invite_used', 'This invite link was already used.')
        if (state === 'expired') throw new ConsoleError(400, 'invite_expired', 'This invite link has expired.')
        throw new ConsoleError(400, 'invalid_token', 'This invite link is invalid.')
      }
      recordAudit(raw, { kind: 'member', id: member.id, label: member.label }, 'auth.invite_accept')
      return enrollmentFor(member)
    }), PUBLIC)
  }

  function registerPasskeyRoutes(router: ConsoleRouter): void {
    router.add('POST', '/auth/passkey/register/options', async (request) => {
      const limited = limit(request.raw)
      if (limited) return limited
      const { member } = await enrollingMember(request, optionalString(objectBody(request.body), 'enrollment'))
      const rp = passkeyRp(request.raw)
      const creation = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rp.hostname,
        userName: member.email ?? member.label,
        userDisplayName: member.label,
        userID: new TextEncoder().encode(member.id),
        attestationType: 'none',
        excludeCredentials: memberPasskeys(member.id).map((row) => ({ id: row.webauthn_id!, transports: parseTransports(row.transports) })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
      })
      db.saveChallenge(creation.challenge, 'register', member.id)
      return creation
    }, PUBLIC)

    router.add('POST', '/auth/passkey/register/verify', async (request) => {
      const limited = limit(request.raw)
      if (limited) return limited
      const input = objectBody(request.body)
      const enrollment = optionalString(input, 'enrollment')
      const { member, viaSession } = await enrollingMember(request, enrollment)
      const response = input.response as RegistrationResponseJSON | undefined
      const challenge = challengeOf(response)
      const saved = challenge ? db.takeChallenge(challenge, 'register') : null
      if (!response || !challenge || !saved || saved.memberId !== member.id) {
        throw new ConsoleError(400, 'invalid_challenge', 'This passkey request expired. Try again.')
      }
      const rp = rpFor(request.raw)
      let verification
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.hostname,
          requireUserVerification: false,
        })
      } catch (error) {
        throw new ConsoleError(400, 'passkey_invalid', `Passkey registration failed: ${errorMessage(error)}`)
      }
      if (!verification.verified) throw new ConsoleError(400, 'passkey_invalid', 'Passkey registration could not be verified.')
      const { credential } = verification.registrationInfo
      if (db.findPasskey(credential.id)) throw new ConsoleError(409, 'credential_exists', 'This passkey is already registered.')
      const added = addCredential(request.raw, member, {
        kind: 'passkey',
        label: optionalString(input, 'label')?.slice(0, 80) ?? 'Passkey',
        webauthnId: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
      }, viaSession ? 'session' : 'enrollment')
      if (enrollment) db.consumeEnrollment(enrollment)
      const current = store.getMember(member.id) ?? member
      if (viaSession) return me((request.principal ?? await authenticate(request.raw))!)
      return startMemberSession(request, current, 'passkey', added.id)
    }, PUBLIC)

    router.add('POST', '/auth/passkey/login/options', async ({ raw }) => {
      const limited = limit(raw)
      if (limited) return limited
      const rp = passkeyRp(raw)
      const request = await generateAuthenticationOptions({ rpID: rp.hostname, userVerification: 'preferred' })
      db.saveChallenge(request.challenge, 'login', null)
      return request
    }, PUBLIC)

    router.add('POST', '/auth/passkey/login/verify', signInFailures('passkey', async (request) => {
      const input = objectBody(request.body)
      const response = input.response as AuthenticationResponseJSON | undefined
      const credentialId = typeof response?.id === 'string' ? response.id : ''
      const limited = limit(request.raw, `passkey:${credentialId}`)
      if (limited) return limited
      const challenge = challengeOf(response)
      if (!response || !challenge || !db.takeChallenge(challenge, 'login')) {
        throw new ConsoleError(400, 'invalid_challenge', 'This sign-in request expired. Try again.')
      }
      const stored = db.findPasskey(credentialId)
      const member = stored ? store.getMember(stored.member_id) : null
      if (!stored || !member) throw new ConsoleError(401, 'unknown_credential', 'This passkey is not registered with this gateway.')
      const userHandle = response.response?.userHandle
      if (userHandle && Buffer.from(userHandle, 'base64url').toString('utf8') !== member.id) {
        throw new ConsoleError(401, 'unknown_credential', 'This passkey is not registered with this gateway.')
      }
      if (member.status !== 'active') throw new ConsoleError(403, 'member_disabled', 'This member cannot sign in.')
      const verification = await verifyPasskey(request.raw, response, challenge, stored)
      db.touchCredential(stored.id, verification.authenticationInfo.newCounter)
      return startMemberSession(request, member, 'passkey', stored.id)
    }), PUBLIC)
  }

  /** Wallet sign-in (EIP-4361). */
  function registerWalletRoutes(router: ConsoleRouter): void {
    router.add('POST', '/auth/wallet/nonce', async ({ raw, body }) => {
      const limited = limit(raw)
      if (limited) return limited
      return walletNonce(raw, objectBody(body).address)
    }, PUBLIC)

    router.add('POST', '/auth/wallet/verify', signInFailures('wallet', async (request) => {
      const input = objectBody(request.body)
      const message = stringField(input, 'message')
      const signature = stringField(input, 'signature')
      const enrollment = optionalString(input, 'enrollment')
      const recovered = recoverSigner(message, signature)
      const limited = limit(request.raw, `wallet:${recovered ?? 'invalid'}`)
      if (limited) return limited
      const signer = verifyWalletSignature(message, signature, recovered)

      const existing = db.findWallet(signer)
      if (existing) {
        if (enrollment) {
          const enrolled = db.peekEnrollment(enrollment)
          if (enrolled !== existing.member_id) throw new ConsoleError(409, 'credential_exists', 'This wallet is already linked to another member.')
          db.consumeEnrollment(enrollment)
        }
        const member = store.getMember(existing.member_id)
        if (!member) throw new ConsoleError(401, 'unknown_credential', 'This wallet is not registered with this gateway.')
        if (member.status !== 'active') throw new ConsoleError(403, 'member_disabled', 'This member cannot sign in.')
        db.touchCredential(existing.id)
        return startMemberSession(request, member, 'wallet', existing.id)
      }

      const label = `Wallet ${signer.slice(0, 6)}…${signer.slice(-4)}`
      if (!enrollment) {
        const { principal, member } = await signedInMember(request)
        if (!member) throw new ConsoleError(401, 'unknown_credential', 'This wallet is not registered. Use your invite link first.')
        await requireFreshSignIn(request, principal)
        addCredential(request.raw, member, { kind: 'wallet', label, address: signer }, 'session')
        return me(principal!)
      }
      const memberId = db.consumeEnrollment(enrollment)
      const member = memberId ? store.getMember(memberId) : null
      if (!member) throw new ConsoleError(400, 'invalid_enrollment', 'This sign-up link has expired. Ask for a new one.')
      const added = addCredential(request.raw, member, { kind: 'wallet', label, address: signer }, 'enrollment')
      return startMemberSession(request, member, 'wallet', added.id)
    }), PUBLIC)
  }

  function registerOidcRoutes(router: ConsoleRouter): void {
    router.add('GET', '/auth/oidc/start', async (request) => {
      if (!oidc) throw new ConsoleError(404, 'oidc_disabled', 'Single sign-on is not configured on this gateway.')
      const limited = limit(request.raw)
      if (limited) return limited
      let enrollment = request.query.get('enrollment') || null
      if (enrollment && !db.peekEnrollment(enrollment)) return loginRedirectTo(request.res, 'invalid_enrollment')
      if (!enrollment && request.query.get('link') === '1') {
        // A signed-in member links their provider account via a fresh enrollment for themselves.
        const { principal, member } = await signedInMember(request)
        if (!member) return loginRedirectTo(request.res, 'unauthenticated')
        try {
          await requireFreshSignIn(request, principal)
        } catch (error) {
          if (error instanceof ConsoleError) return loginRedirectTo(request.res, error.code)
          throw error
        }
        enrollment = db.createEnrollment(member.id)
      }
      let authorization
      try {
        authorization = await oidc.authorizationUrl()
      } catch (error) {
        deps.log(`Console: OIDC discovery failed: ${errorMessage(error)}`)
        return loginRedirectTo(request.res, 'oidc_unavailable')
      }
      db.saveOidcState(authorization.state, { nonce: authorization.nonce, codeVerifier: authorization.codeVerifier, enrollment })
      // Lax, not Strict: it has to come back on the provider's cross-site redirect.
      appendSetCookie(request.res, serializeCookie(request.raw, OIDC_STATE_COOKIE, authorization.state, {
        maxAgeSeconds: OIDC_STATE_TTL_MS / 1000, path: OIDC_COOKIE_PATH, sameSite: 'Lax',
      }))
      return redirect(request.res, authorization.url)
    }, PUBLIC)

    router.add('GET', '/auth/oidc/callback', async (request) => {
      if (!oidc) throw new ConsoleError(404, 'oidc_disabled', 'Single sign-on is not configured on this gateway.')
      const limited = limit(request.raw)
      if (limited) return limited
      const { raw, query, res } = request
      // Every refusal here is a redirect, not a thrown error, so record it on the way out.
      const loginRedirect = (error: string): undefined => {
        recordAudit(raw, { kind: 'system', id: null }, 'auth.sign_in_failed', { method: 'oidc', code: error })
        return loginRedirectTo(res, error)
      }
      const state = query.get('state') ?? ''
      const cookieState = readCookie(raw, OIDC_STATE_COOKIE) ?? ''
      clearCookie(raw, res, OIDC_STATE_COOKIE, OIDC_COOKIE_PATH, 'Lax')
      if (query.get('error')) return loginRedirect('oidc_denied')
      if (!state || !cookieState || !safeEqual(state, cookieState)) return loginRedirect('oidc_state')
      const saved = db.takeOidcState(state)
      const code = query.get('code')
      if (!saved || !code) return loginRedirect('oidc_state')
      let identity: ExternalIdentity
      try {
        identity = await oidc.identityFromCode(code, saved.codeVerifier, saved.nonce)
      } catch (error) {
        deps.log(`Console: OIDC sign-in rejected: ${errorMessage(error)}`)
        return loginRedirect('oidc_failed')
      }
      let enrollmentMemberId: string | null = null
      if (saved.enrollmentHash) {
        enrollmentMemberId = db.consumeEnrollmentHash(saved.enrollmentHash)
        if (!enrollmentMemberId) return loginRedirect('invalid_enrollment')
      }
      const resolved = db.transaction(() => resolveExternalMember(identity, enrollmentMemberId, true, raw))
      if ('error' in resolved) return loginRedirect(resolved.error === 'disabled' ? 'member_disabled' : resolved.error)
      if (resolved.member.status !== 'active') return loginRedirect('member_disabled')
      startSession(raw, res, { kind: 'member', memberId: resolved.member.id }, 'oidc', db.findOidc(identity.issuer, identity.subject)?.id ?? null)
      return redirect(res, '/console')
    }, PUBLIC)
  }

  /**
   * Re-authentication: a fresh proof (passkey or wallet) for the signed-in
   * member's current session. It never signs anyone else in: a credential
   * of another member is refused and the session stays as it was.
   */
  function registerReauthRoutes(router: ConsoleRouter): void {
    router.add('POST', '/auth/reauth/passkey/options', async (request) => {
      const memberId = reauthMemberId(request)
      const limited = limit(request.raw, `reauth:${memberId}`)
      if (limited) return limited
      const rp = passkeyRp(request.raw)
      const passkeys = memberPasskeys(memberId)
      if (passkeys.length === 0) throw new ConsoleError(400, 'no_passkey', 'You have no passkey. Confirm with your wallet instead.')
      const options = await generateAuthenticationOptions({
        rpID: rp.hostname,
        userVerification: 'preferred',
        allowCredentials: passkeys.map((row) => ({ id: row.webauthn_id!, transports: parseTransports(row.transports) })),
      })
      // Bound to the member: a plain sign-in challenge (no member) can't be used here.
      db.saveChallenge(options.challenge, 'login', memberId)
      return options
    }, MEMBER_ONLY)

    router.add('POST', '/auth/reauth/passkey/verify', async (request) => {
      const memberId = reauthMemberId(request)
      const limited = limit(request.raw, `reauth:${memberId}`)
      if (limited) return limited
      const response = objectBody(request.body).response as AuthenticationResponseJSON | undefined
      const challenge = challengeOf(response)
      const saved = challenge ? db.takeChallenge(challenge, 'login') : null
      if (!response || !challenge || !saved || saved.memberId !== memberId) {
        throw new ConsoleError(400, 'invalid_challenge', 'This confirmation request expired. Try again.')
      }
      const stored = db.findPasskey(typeof response.id === 'string' ? response.id : '')
      if (!stored) throw wrongMember(request, 'passkey', 'This passkey is not registered with this gateway.')
      const verification = await verifyPasskey(request.raw, response, challenge, stored)
      if (stored.member_id !== memberId) throw wrongMember(request, 'passkey', 'This passkey belongs to another member. Confirm with your own.')
      db.touchCredential(stored.id, verification.authenticationInfo.newCounter)
      return finishReauth(request, 'passkey', stored.id)
    }, MEMBER_ONLY)

    router.add('POST', '/auth/reauth/wallet/nonce', async (request) => {
      const memberId = reauthMemberId(request)
      const limited = limit(request.raw, `reauth:${memberId}`)
      if (limited) return limited
      return walletNonce(request.raw, objectBody(request.body).address)
    }, MEMBER_ONLY)

    router.add('POST', '/auth/reauth/wallet/verify', async (request) => {
      const memberId = reauthMemberId(request)
      const limited = limit(request.raw, `reauth:${memberId}`)
      if (limited) return limited
      const input = objectBody(request.body)
      const signer = verifyWalletSignature(stringField(input, 'message'), stringField(input, 'signature'))
      const credential = db.findWallet(signer)
      if (!credential || credential.member_id !== memberId) {
        throw wrongMember(request, 'wallet', 'This wallet is not one of your sign-in methods. Confirm with your own.')
      }
      db.touchCredential(credential.id)
      return finishReauth(request, 'wallet', credential.id)
    }, MEMBER_ONLY)
  }

  /** API-key sign-in, sign-out and the current principal. */
  function registerSessionRoutes(router: ConsoleRouter): void {
    router.add('POST', '/auth/api-key', signInFailures('api-key', async (request) => {
      const secret = stringField(objectBody(request.body), 'key').trim()
      const limited = limit(request.raw, `key:${sha256Hex(secret)}`)
      if (limited) return limited
      const key = store.findKeyBySecret(secret)
      if (key?.status === 'revoked') throw new ConsoleError(401, 'key_revoked', 'This API key has been revoked.')
      if (key && key.expiresAt !== null && key.expiresAt <= deps.now()) throw new ConsoleError(401, 'key_expired', 'This API key has expired.')
      if (!keyUsable(key)) throw new ConsoleError(401, 'invalid_key', 'This API key is not valid.')
      const sessionId = startSession(request.raw, request.res, { kind: 'key', keyId: key.id }, 'api-key')
      return me({ kind: 'key', keyId: key.id, sessionId })
    }), PUBLIC)

    router.add('POST', '/auth/logout', async ({ raw, res }) => {
      const cookie = readCookie(raw, SESSION_COOKIE)
      if (cookie) db.deleteSessionBySecret(cookie)
      clearCookie(raw, res, SESSION_COOKIE, '/console', 'Strict')
      return respond(204)
    }, PUBLIC)

    router.add('GET', '/auth/me', async (request) => me(request.principal!), { allow: ['member', 'key'] })
  }

  function authConfig(req?: http.IncomingMessage): AuthConfig {
    return {
      setupRequired: setupClaimable(),
      passkey: passkeyAvailable(req),
      wallet: true,
      oidc: oidcConfig ? { label: oidcConfig.label } : null,
      cloudflareAccess: cloudflare !== null,
      apiKeyLogin: true,
    }
  }

  return {
    authenticate,
    registerRoutes,
    me,
    authConfig,
    credentialsFor,
    revokeMemberSessions(memberId) {
      db.deleteMemberSessions(memberId)
    },
    revokeKeySessions(keyId) {
      db.deleteKeySessions(keyId)
    },
    deleteCredential(memberId, credentialId, keepSessionId = null) {
      const deleted = db.deleteCredential(memberId, credentialId)
      if (deleted) db.deleteMemberSessionsExcept(memberId, keepSessionId)
      return deleted
    },
    setGatewayPort(port) {
      gatewayPort = port
    },
    createSetupLink() {
      if (!setupClaimable()) throw new Error('The console has already been claimed by its owner; invite more members from the console.')
      const token = db.createSetupToken()
      // localhost, not 127.0.0.1: browsers refuse passkeys on IP addresses.
      return `${publicUrl ?? `http://localhost:${gatewayPort}`}/console/setup#${token}`
    },
  }
}

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

function stringField(input: Record<string, unknown>, name: string): string {
  const value = input[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
    throw new ConsoleError(400, 'invalid_request', `"${name}" is required.`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, name: string): string | null {
  const value = input[name]
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 ? value : null
}

/** The challenge the browser signed, read from clientDataJSON so the server can find its saved copy. */
function challengeOf(response: { response?: { clientDataJSON?: unknown } } | undefined): string | null {
  const encoded = response?.response?.clientDataJSON
  if (typeof encoded !== 'string') return null
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { challenge?: unknown }
    return typeof parsed.challenge === 'string' ? parsed.challenge : null
  } catch {
    return null
  }
}

function parseTransports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is AuthenticatorTransportFuture => typeof item === 'string') : undefined
  } catch {
    return undefined
  }
}

function wireAmount(amount: unknown): string | null {
  if (typeof amount === 'number') return usdcToDecimalString(amount)
  if (typeof amount === 'string') return amount
  return null
}

/** Store limits are USDC base units (numbers); the console wants decimal strings for every period. */
function toSpendLimits(value: unknown): SpendLimits {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const limits = {} as SpendLimits
  for (const period of BUDGET_PERIODS) limits[period] = wireAmount(source[period])
  return limits
}
