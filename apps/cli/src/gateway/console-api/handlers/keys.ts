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
  keyUsageForDtos,
  limitsFromWire,
  notFound,
  optionalBoolean,
  optionalString,
  optionalTimestamp,
  policyFromWire,
  requiredString,
} from '../serialize.js'

type KeyAccess = 'none' | 'read' | 'owner' | 'admin'

/**
 * What the caller may do with a key: workspace admins manage it, its owner
 * self-serves, a key session reads itself. A key without an owner is the org
 * admins' (no member budget applies to it), so a workspace admin only reads it.
 */
function keyAccess(deps: ConsoleDeps, p: Principal | null, key: ApiKeyRecord): KeyAccess {
  if (!p) return 'none'
  if (p.kind === 'key') return p.keyId === key.id ? 'read' : 'none'
  if (isOrgAdmin(deps.store, p)) return 'admin'
  if (p.kind !== 'member') return 'none'
  const role = workspaceRole(deps.store, p, key.workspaceId)
  if (role === 'admin') return key.ownerMemberId === null ? 'read' : 'admin'
  if (role === 'member' && key.ownerMemberId === p.memberId) return 'owner'
  return 'none'
}

function requireKeyAccess(deps: ConsoleDeps, p: Principal | null, id: string, needed: 'read' | 'owner' | 'admin'): { key: ApiKeyRecord; access: KeyAccess } {
  const key = deps.store.getKey(id)
  if (!key) throw notFound('Key')
  const access = keyAccess(deps, p, key)
  if (access === 'none') throw notFound('Key')
  const rank = { none: 0, read: 1, owner: 2, admin: 3 }
  if (rank[access] < rank[needed]) {
    if (p?.kind === 'member' && key.ownerMemberId === null) throw new ConsoleError(403, 'forbidden', 'Only organization admins can change keys without an owner')
    throw new ConsoleError(403, 'forbidden', needed === 'admin' ? 'Only workspace admins can do this' : 'You cannot change this key')
  }
  return { key, access }
}

/**
 * Member budgets only reach keys with an owner, so a key without one is the
 * org admins' (and management tokens') to make; a workspace admin's keys
 * belong to someone in the workspace.
 */
function requireOwnerlessAllowed(deps: ConsoleDeps, p: Principal | null, ownerMemberId: string | null | undefined): void {
  if (ownerMemberId !== null || isOrgAdmin(deps.store, p)) return
  throw new ConsoleError(403, 'forbidden', 'Only organization admins can have keys without an owner')
}

/**
 * API keys (business rules in `services/keys.ts`). Members create, rotate
 * and revoke their own keys in workspaces they belong to, up to their
 * `maxKeys`; workspace admins manage every key in their workspace and may
 * create keys for its members; only admins turn on x402 top-ups or change a
 * key's owner; keys without an owner are the org admins' alone (workspace
 * admins only see them). Rotation issues a new secret for the same key id
 * and ends the key's console sessions.
 */
export function registerKeyRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  router.add('GET', '/keys', async ({ principal, query }) => {
    const workspace = query.get('workspace')
    const member = query.get('member')
    if (principal?.kind === 'member') activeMember(store, principal)
    const keys = store.listKeys({ ...(workspace ? { workspaceId: workspace } : {}), ...(member ? { ownerMemberId: member } : {}) })
      .filter((key) => keyAccess(deps, principal, key) !== 'none')
    const now = deps.now()
    const usage = keyUsageForDtos(store, keys.map((key) => key.id), now)
    return keys.map((key) => apiKeyDto(store, key, now, usage.get(key.id)))
  }, { allow: ['member', 'token', 'key'] })

  router.add('POST', '/keys', async (request) => {
    const { principal, body } = request
    const input = asObject(body)
    const label = requiredString(input, 'label')
    const workspaceId = requiredString(input, 'workspaceId')
    requireWorkspaceAccess(store, principal, workspaceId)
    const admin = workspaceRole(store, principal, workspaceId) === 'admin'
    const self = principal?.kind === 'member' ? principal.memberId : null
    const ownerMemberId = input['ownerMemberId'] !== undefined ? optionalString(input, 'ownerMemberId') ?? null : undefined
    requireOwnerlessAllowed(deps, principal, ownerMemberId)
    const { key, secret } = createKey(deps, requestActor(deps, request), {
      label,
      workspaceId,
      ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
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
    const ownerMemberId = input['ownerMemberId'] !== undefined ? optionalString(input, 'ownerMemberId') ?? null : undefined
    if (access === 'admin' && key.ownerMemberId !== null) requireOwnerlessAllowed(deps, principal, ownerMemberId)
    const updated = updateKey(deps, requestActor(deps, request), key.id, {
      ...(input['workspaceId'] !== undefined ? { workspaceId: input['workspaceId'] } : {}),
      ...(input['label'] !== undefined ? { label: requiredString(input, 'label') } : {}),
      ...(input['topupEnabled'] !== undefined ? { topupEnabled: optionalBoolean(input, 'topupEnabled') } : {}),
      ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
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
