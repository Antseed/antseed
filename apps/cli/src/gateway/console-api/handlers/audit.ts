import { listAuditEntries } from '../../services/audit.js'
import { requireOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import type { ConsoleRouter } from '../router.js'
import type { AuditEntry } from '../types.js'

/**
 * `GET /audit?before=&limit=&actor=&action=` (org admins and tokens): the
 * audit log, newest first (see `services/audit.ts`).
 */
export function registerAuditRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  router.add('GET', '/audit', async ({ principal, query }): Promise<{ entries: AuditEntry[]; nextBefore: string | null }> => {
    requireOrgAdmin(principal, deps.store)
    const rawLimit = query.get('limit')
    return listAuditEntries(deps.store, {
      before: query.get('before'),
      ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
      actorId: query.get('actor'),
      action: query.get('action'),
    })
  })
}
