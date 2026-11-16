import { createAdminToken, revokeAdminToken, tokenExpiry } from '../../services/tokens.js'
import type { AdminTokenRecord } from '../../store.js'
import { requestActor, requireOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { respond, type ConsoleRouter } from '../router.js'
import { asObject, badRequest, notFound, requiredString } from '../serialize.js'
import type { AdminToken } from '../types.js'

function tokenDto(token: AdminTokenRecord): AdminToken {
  return {
    id: token.id,
    label: token.label,
    hint: token.hint,
    scope: token.scope,
    createdByMemberId: token.createdBy,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
  }
}

/**
 * Management tokens: org admins (signed in, not via another token) mint and
 * revoke them (rules in `services/tokens.ts`).
 */
export function registerAdminTokenRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  router.add('GET', '/admin-tokens', async ({ principal }) => {
    requireOrgAdmin(principal, store)
    return store.listAdminTokens().map(tokenDto)
  }, { allow: ['member'] })

  router.add('POST', '/admin-tokens', async (request) => {
    const { principal, body } = request
    requireOrgAdmin(principal, store)
    const input = asObject(body)
    const label = requiredString(input, 'label')
    const scope = input['scope'] ?? 'read'
    if (scope !== 'admin' && scope !== 'read') throw badRequest('scope must be admin or read')
    const caller = principal?.kind === 'member' ? store.getMember(principal.memberId) : null
    const expiresAt = tokenExpiry(input['expiresInDays'], deps.now(), caller?.orgRole === 'owner')
    const { token, secret } = createAdminToken(deps, requestActor(deps, request), { label, scope, expiresAt, createdBy: caller?.id ?? null })
    return respond(201, { token: tokenDto(token), secret })
  }, { allow: ['member'] })

  router.add('DELETE', '/admin-tokens/:id', async (request) => {
    requireOrgAdmin(request.principal, store)
    const { revoked } = revokeAdminToken(deps, requestActor(deps, request), request.params['id']!)
    if (!revoked) throw notFound('Token')
    return respond(204)
  }, { allow: ['member'] })
}
