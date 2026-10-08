import type Database from 'better-sqlite3'
import { errorMessage } from './errors.js'
import { AuthDb, randomToken, sha256Hex } from './auth/db.js'
import { RateLimiter, rateLimited } from './auth/http.js'
import { requestIp } from './console-api/access.js'
import type { ConsoleDeps } from './console-api/deps.js'
import { ConsoleError, type ConsoleRouter } from './console-api/router.js'
import type { Enrollment } from './console-api/types.js'
import { consoleBaseUrl, type ConsoleLocation } from './console-location.js'
import type { GatewayStore, MemberRecord } from './store.js'

/**
 * Recovery links let an existing member add a sign-in method when theirs no
 * longer work, typically passkeys after the console moved to another domain
 * (a passkey is bound to the domain it was created on). Only the CLI, i.e.
 * someone with access to the gateway's data, can create one. A link is
 * single use, valid for an hour, replaces the member's earlier unused link,
 * and both creating and using it are audited. Only the SHA-256 of the token
 * is stored.
 */
export const RECOVERY_TTL_MS = 60 * 60 * 1000

/** Active owners, oldest first: the default target of `console-link --recover`. */
export function activeOwners(store: GatewayStore): MemberRecord[] {
  return store.listMembers().filter((member) => member.orgRole === 'owner' && member.status === 'active')
}

export interface RecoveryLink {
  url: string
  member: MemberRecord
  expiresAt: number
}

export function createRecoveryLink(store: GatewayStore, location: ConsoleLocation, memberId: string, now: () => number = Date.now): RecoveryLink {
  const member = store.getMember(memberId)
  if (!member || member.status !== 'active') throw new Error(`Member ${memberId} is not an active member of this console.`)
  const db = store.database
  const token = randomToken(32)
  const createdAt = now()
  const expiresAt = createdAt + RECOVERY_TTL_MS
  db.transaction(() => {
    db.prepare('DELETE FROM console_recovery_tokens WHERE expires_at <= ? OR (member_id = ? AND used_at IS NULL)').run(createdAt, member.id)
    db.prepare('INSERT INTO console_recovery_tokens (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256Hex(token), member.id, createdAt, expiresAt)
  })()
  store.recordAudit({
    actor: { kind: 'cli', id: null },
    action: 'auth.recovery_link_create',
    target: { kind: 'member', id: member.id, label: member.label },
    details: { expiresAt },
  })
  return { url: `${consoleBaseUrl(location)}/console/recover#${token}`, member, expiresAt }
}

/** Marks a live token used and returns its member id; null when unknown, used or expired. */
export function consumeRecoveryToken(db: Database.Database, token: string, now: number): string | null {
  const hash = sha256Hex(token)
  const row = db.prepare('SELECT member_id FROM console_recovery_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(hash, now) as
    { member_id: string } | undefined
  if (!row) return null
  const changed = db.prepare('UPDATE console_recovery_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now, hash).changes
  return changed === 1 ? row.member_id : null
}

/** Drops every recovery link, e.g. when a data dir is imported on a new host. */
export function clearRecoveryTokens(db: Database.Database): void {
  db.prepare('DELETE FROM console_recovery_tokens').run()
}

/**
 * `POST /auth/recover { token }` (public): trades a recovery link for an
 * enrollment, which the console's usual sign-up screen uses to register a
 * passkey, wallet or SSO account for that member and sign them in.
 */
export function registerRecoveryRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const limiter = new RateLimiter([{ limit: 10, ms: 60_000 }, { limit: 50, ms: 3_600_000 }], deps.now)
  const auditRecovery = (ip: string | null, actor: { kind: 'member' | 'system'; id: string | null; label?: string | null }, action: string, details: Record<string, unknown> = {}): void => {
    try {
      deps.store.recordAudit({ actor, action, details, ip })
    } catch (error) {
      deps.log(`Console: AUDIT WRITE FAILED for ${action}: ${errorMessage(error)}`)
    }
  }

  router.add('POST', '/auth/recover', async (request) => {
    const ip = requestIp(request, deps)
    const wait = limiter.hit(`ip:${ip ?? 'unknown'}`)
    if (wait) return rateLimited(wait)
    const token = request.body && typeof request.body === 'object' ? (request.body as { token?: unknown }).token : undefined
    const memberId = typeof token === 'string' && token.length > 0 && token.length <= 200
      ? consumeRecoveryToken(deps.store.database, token, deps.now())
      : null
    const member = memberId ? deps.store.getMember(memberId) : null
    if (!member || member.status !== 'active') {
      auditRecovery(ip, { kind: 'system', id: null }, 'auth.sign_in_failed', { method: 'recovery', code: 'invalid_token' })
      throw new ConsoleError(400, 'invalid_token', 'This recovery link is invalid, used or expired. Create a new one on the gateway with `antseed gateway console-link --recover`.')
    }
    const enrollment = new AuthDb(deps.store.database, deps.now).createEnrollment(member.id)
    auditRecovery(ip, { kind: 'member', id: member.id, label: member.label }, 'auth.recovery_claim')
    deps.log(`Console: recovery link used for member ${member.id}; they are adding a sign-in method.`)
    const result: Enrollment = { enrollment, label: member.label, orgRole: member.orgRole }
    return result
  }, { public: true })
}
