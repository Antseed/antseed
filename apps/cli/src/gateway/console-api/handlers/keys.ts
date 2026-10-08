import { createKey, revokeKey, rotateKey, updateKey } from '../../services/keys.js'
import type { ApiKeyRecord } from '../../store.js'
import { activeMember, isOrgAdmin, requestActor, requireWorkspaceAccess, workspaceRole } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, respond, type ConsoleRouter, type Principal } from '../router.js'
import {
  apiKeyDto,
  asObject,
  confirmations,
  fullLimitsFromWire,
  limitsFromWire,
  notFound,
  optionalBoolean,
  optionalString,
  optionalTimestamp,
  policyFromWire,
  requiredString,
} from '../serialize.js'

type KeyAccess = 'none' | 'read' | 'owner' | 'admin'

/** What the caller may do with a key: workspace admins manage it, its owner self-serves, a key session reads itself. */
function keyAccess(deps: ConsoleDeps, p: Principal | null, key: ApiKeyRecord): KeyAccess {
  if (!p) return 'none'
  if (p.kind === 'key') return p.keyId === key.id ? 'read' : 'none'
  if (isOrgAdmin(deps.store, p)) return 'admin'
  if (p.kind !== 'member') return 'none'
  const role = workspaceRole(deps.store, p, key.workspaceId)
  if (role === 'admin') return 'admin'
  if (role === 'member' && key.ownerMemberId === p.memberId) return 'owner'
  return 'none'
}

function requireKeyAccess(deps: ConsoleDeps, p: Principal | null, id: string, needed: 'read' | 'owner' | 'admin'): { key: ApiKeyRecord; access: KeyAccess } {
  const key = deps.store.getKey(id)
  if (!key) throw notFound('Key')
  const access = keyAccess(deps, p, key)
  if (access === 'none') throw notFound('Key')
  const rank = { none: 0, read: 1, owner: 2, admin: 3 }
  if (rank[access] < rank[needed]) throw new ConsoleError(403, 'forbidden', needed === 'admin' ? 'Only workspace admins can do this' : 'You cannot change this key')
  return { key, access }
}

/**
 * API keys (business rules in `services/keys.ts`). Members create, rotate
 * and revoke their own keys in workspaces they belong to, up to their
 * `maxKeys`; workspace admins manage every key in their workspace and may
 * create keys for its members; only admins turn on x402 top-ups or change a
 * key's owner. Rotation issues a new secret for the same key id and ends the
 * key's console sessions.
 */
export function registerKeyRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  router.add('GET', '/keys', async ({ principal, query }) => {
    const workspace = query.get('workspace')
    const member = query.get('member')
    if (principal?.kind === 'member') activeMember(store, principal)
    return store.listKeys({ ...(workspace ? { workspaceId: workspace } : {}), ...(member ? { ownerMemberId: member } : {}) })
      .filter((key) => keyAccess(deps, principal, key) !== 'none')
      .map((key) => apiKeyDto(store, key, deps.now()))
  }, { allow: ['member', 'token', 'key'] })

  router.add('POST', '/keys', async (request) => {
    const { principal, body } = request
    const input = asObject(body)
    const label = requiredString(input, 'label')
    const workspaceId = requiredString(input, 'workspaceId')
    requireWorkspaceAccess(store, principal, workspaceId)
    const admin = workspaceRole(store, principal, workspaceId) === 'admin'
    const self = principal?.kind === 'member' ? principal.memberId : null
    const { key, secret } = createKey(deps, requestActor(deps, request), {
      label,
      workspaceId,
      ...(input['ownerMemberId'] !== undefined ? { ownerMemberId: optionalString(input, 'ownerMemberId') ?? null } : {}),
      ...(input['topupEnabled'] !== undefined ? { topupEnabled: optionalBoolean(input, 'topupEnabled') } : {}),
      ...(input['limits'] !== undefined ? { limits: fullLimitsFromWire(input['limits']) } : {}),
      ...(input['routingPolicy'] !== undefined ? { routingPolicy: policyFromWire(input['routingPolicy']) } : {}),
      ...(input['ownerLimits'] !== undefined ? { ownerLimits: fullLimitsFromWire(input['ownerLimits']) } : {}),
      ...(input['ownerRoutingPolicy'] !== undefined ? { ownerRoutingPolicy: policyFromWire(input['ownerRoutingPolicy'], 'ownerRoutingPolicy') } : {}),
      expiresAt: optionalTimestamp(input, 'expiresAt') ?? null,
      ...confirmations(input),
    }, { as: admin ? 'admin' : 'owner', self })
    return respond(201, { key: apiKeyDto(store, key, deps.now()), secret })
  })

  router.add('PATCH', '/keys/:id', async (request) => {
    const { principal, params, body } = request
    const input = asObject(body)
    const { key, access } = requireKeyAccess(deps, principal, params['id']!, 'owner')
    const updated = updateKey(deps, requestActor(deps, request), key.id, {
      ...(input['workspaceId'] !== undefined ? { workspaceId: input['workspaceId'] } : {}),
      ...(input['label'] !== undefined ? { label: requiredString(input, 'label') } : {}),
      ...(input['topupEnabled'] !== undefined ? { topupEnabled: optionalBoolean(input, 'topupEnabled') } : {}),
      ...(input['ownerMemberId'] !== undefined ? { ownerMemberId: optionalString(input, 'ownerMemberId') ?? null } : {}),
      ...(input['limits'] !== undefined ? { limits: limitsFromWire(input['limits']) } : {}),
      ...(input['routingPolicy'] !== undefined ? { routingPolicy: policyFromWire(input['routingPolicy']) } : {}),
      ...(input['ownerLimits'] !== undefined ? { ownerLimits: limitsFromWire(input['ownerLimits']) } : {}),
      ...(input['ownerRoutingPolicy'] !== undefined ? { ownerRoutingPolicy: policyFromWire(input['ownerRoutingPolicy'], 'ownerRoutingPolicy') } : {}),
      ...(input['expiresAt'] !== undefined ? { expiresAt: optionalTimestamp(input, 'expiresAt') } : {}),
      ...confirmations(input),
    }, { as: access === 'admin' ? 'admin' : 'owner' })
    return apiKeyDto(store, updated, deps.now())
  })

  router.add('POST', '/keys/:id/rotate', async (request) => {
    const { key } = requireKeyAccess(deps, request.principal, request.params['id']!, 'owner')
    const rotated = rotateKey(deps, requestActor(deps, request), key.id)
    return { key: apiKeyDto(store, rotated.key, deps.now()), secret: rotated.secret }
  })

  router.add('POST', '/keys/:id/revoke', async (request) => {
    const { key } = requireKeyAccess(deps, request.principal, request.params['id']!, 'owner')
    return apiKeyDto(store, revokeKey(deps, requestActor(deps, request), key.id), deps.now())
  })
}
