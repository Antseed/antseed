import { ConsoleError } from '../console-api/router.js'
import { badRequest, notFound } from '../console-api/serialize.js'
import type { AdminTokenRecord } from '../store.js'
import { recordAudit, requiredText, type Actor, type ServiceContext } from './context.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_TOKEN_DAYS = 90
export const MAX_TOKEN_DAYS = 365

/**
 * `expiresInDays`: omitted → 90, 1…365, or null for a token that never
 * expires, which only an owner (or the operator's CLI) may create (`allowNever`).
 */
export function tokenExpiry(value: unknown, now: number, allowNever: boolean): number | null {
  if (value === undefined) return now + DEFAULT_TOKEN_DAYS * DAY_MS
  if (value === null) {
    if (!allowNever) throw new ConsoleError(403, 'forbidden', 'Only an owner can create a token that never expires')
    return null
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TOKEN_DAYS) {
    throw badRequest(`expiresInDays must be a whole number from 1 to ${MAX_TOKEN_DAYS}, or null`)
  }
  return now + value * DAY_MS
}

/**
 * Mints a management token for `/console/api` (`Authorization: Bearer`).
 * It remembers who made it and stops working when that member is disabled
 * or no longer an admin, and when it expires.
 */
export function createAdminToken(
  ctx: ServiceContext,
  actor: Actor,
  input: { label: string; scope: 'admin' | 'read'; expiresAt: number | null; createdBy: string | null },
): { token: AdminTokenRecord; secret: string } {
  const label = requiredText(input.label, 'label', 200)
  if (input.scope !== 'admin' && input.scope !== 'read') throw badRequest('scope must be admin or read')
  const { token, secret } = ctx.store.createAdminToken({ label, scope: input.scope, createdBy: input.createdBy, expiresAt: input.expiresAt })
  ctx.log(`console: management token ${token.id} (${input.scope}) created`)
  recordAudit(ctx, actor, 'token.create', { kind: 'token', id: token.id, label }, { scope: input.scope, expiresAt: input.expiresAt })
  return { token, secret }
}

/** Revokes a token; `revoked` is false when it already was. */
export function revokeAdminToken(ctx: ServiceContext, actor: Actor, id: string): { token: AdminTokenRecord; revoked: boolean } {
  const token = ctx.store.getAdminToken(id)
  if (!token) throw notFound('Token')
  if (!ctx.store.revokeAdminToken(token.id)) return { token, revoked: false }
  recordAudit(ctx, actor, 'token.revoke', { kind: 'token', id: token.id, label: token.label })
  return { token, revoked: true }
}
