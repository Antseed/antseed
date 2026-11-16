import { badRequest } from '../console-api/serialize.js'
import type { AuditRecord, GatewayStore } from '../store.js'

const DEFAULT_AUDIT_LIMIT = 100
const MAX_AUDIT_LIMIT = 500

/**
 * The audit log, newest first. `before` is the opaque `nextBefore` cursor of
 * the previous page; `action` matches a verb and everything under it ("key"
 * matches "key.create"); `actorId` is a member, key or token id.
 */
export function listAuditEntries(
  store: GatewayStore,
  filter: { before?: string | null; limit?: number; actorId?: string | null; action?: string | null } = {},
): { entries: AuditRecord[]; nextBefore: string | null } {
  const before = filter.before ?? null
  if (before !== null && !/^\d{1,15}$/.test(before)) throw badRequest('before must be a cursor from a previous page')
  const limit = filter.limit ?? DEFAULT_AUDIT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) throw badRequest(`limit must be between 1 and ${MAX_AUDIT_LIMIT}`)
  return store.listAudit({ before, limit, actorId: filter.actorId || null, action: filter.action || null })
}
