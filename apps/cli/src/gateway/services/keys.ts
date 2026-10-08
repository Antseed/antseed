import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import type { RoutingPolicy } from '../../routing-policy/policy.js'
import { effectiveKeyLimits } from '../accounting.js'
import { BUDGET_PERIODS, NO_BUDGET_LIMITS, type BudgetLimits } from '../limits.js'
import { checkPolicyInput, policyInputProblem, type PolicyInputCheck } from '../policy-resolver.js'
import { ConsoleError } from '../console-api/router.js'
import { badRequest, limitsToWire, notFound } from '../console-api/serialize.js'
import type { ApiKeyRecord, GatewayStore } from '../store.js'
import { changedFields, recordAudit, requiredText, throwIfProblem, type Actor, type PolicyConfirmations, type ServiceContext } from './context.js'

/**
 * API keys. A key has two layers of limits and routing policy: the admin
 * layer (`limits`, `routingPolicy`, workspace admins only) and the owner
 * layer (`ownerLimits`, `ownerRoutingPolicy`), which the key's owner changes
 * freely; each only narrows, so an owner never gets past the admin layer.
 *
 * `as` says which side of that line the caller is on: 'admin' for workspace
 * and org admins, management tokens and the CLI; 'owner' for a member
 * acting on their own key. Who may act as what is the caller's check.
 */
export type KeyActingAs = 'admin' | 'owner'

function forbidden(message: string): ConsoleError {
  return new ConsoleError(403, 'forbidden', message)
}

function requireKeyRecord(store: GatewayStore, id: string): ApiKeyRecord {
  const key = store.getKey(id)
  if (!key) throw notFound('Key')
  return key
}

function keyTarget(key: ApiKeyRecord): { kind: string; id: string; label: string } {
  return { kind: 'key', id: key.id, label: key.label }
}

/**
 * Owner-layer caps above the admin layer's for the same period: they would
 * never apply. No owner cap (null) is fine: the admin cap still holds.
 */
export function narrowedOwnerLimits(admin: BudgetLimits, owner: Partial<BudgetLimits>): string[] {
  return BUDGET_PERIODS.filter((period) => {
    const wanted = owner[period] ?? null
    const cap = admin[period]
    return wanted !== null && cap !== null && wanted > cap
  }).map((period) => `ownerLimits.${period}`)
}

/**
 * Policy checks for the key's two layers as they would be after a change:
 * the admin layer under workspace and member, the owner layer under the
 * admin layer.
 */
function keyPolicyChecks(
  store: GatewayStore,
  key: Pick<ApiKeyRecord, 'id' | 'workspaceId' | 'ownerMemberId' | 'routingPolicy' | 'ownerRoutingPolicy'>,
  sent: { routingPolicy?: RoutingPolicy | null; ownerRoutingPolicy?: RoutingPolicy | null },
): Array<{ field: string; check: PolicyInputCheck }> {
  const next = { ...key, ...sent } as ApiKeyRecord
  const target = { key: next, workspaceId: key.workspaceId, ...(key.ownerMemberId ? { memberId: key.ownerMemberId } : {}) }
  const checks: Array<{ field: string; check: PolicyInputCheck }> = []
  if (sent.routingPolicy !== undefined) checks.push({ field: 'routingPolicy', check: checkPolicyInput(store, target, 'key', sent.routingPolicy) })
  if (sent.ownerRoutingPolicy !== undefined) checks.push({ field: 'ownerRoutingPolicy', check: checkPolicyInput(store, target, 'key-owner', sent.ownerRoutingPolicy) })
  return checks
}

/** Only an earlier expiry from a key's owner; admins may set any. */
function checkOwnerExpiry(key: Pick<ApiKeyRecord, 'expiresAt'>, expiresAt: number | null): void {
  if (expiresAt === null && key.expiresAt !== null) throw forbidden('Only workspace admins can remove a key\'s expiry')
  if (expiresAt !== null && key.expiresAt !== null && expiresAt > key.expiresAt) throw forbidden('Only workspace admins can extend a key\'s expiry')
}

export interface CreateKeyInput extends PolicyConfirmations {
  label: string
  /** The workspace the key pays from; without one, the workspace paying with `buyerIdentity` (default identity) is used. */
  workspaceId?: string
  buyerIdentity?: string
  /** Undefined: the creating member (`self`). Null: nobody (an operator key). */
  ownerMemberId?: string | null
  limits?: BudgetLimits
  routingPolicy?: RoutingPolicy | null
  ownerLimits?: BudgetLimits
  ownerRoutingPolicy?: RoutingPolicy | null
  topupEnabled?: boolean
  expiresAt?: number | null
}

/**
 * Creates a key. Acting as an owner (a member creating their own key), what
 * they send is their owner layer; the admin layer stays empty and their
 * member caps and policy apply above it, bounded by their `maxKeys`.
 */
export function createKey(
  ctx: ServiceContext,
  actor: Actor,
  input: CreateKeyInput,
  options: { as: KeyActingAs; self?: string | null } = { as: 'admin' },
): { key: ApiKeyRecord; secret: string } {
  const { store } = ctx
  const admin = options.as === 'admin'
  const self = options.self ?? null
  const label = requiredText(input.label, 'label', 200)
  const workspace = input.workspaceId
    ? store.getWorkspace(input.workspaceId)
    : store.ensureWorkspaceForIdentity(input.buyerIdentity ?? DEFAULT_BUYER_IDENTITY)
  if (!workspace) throw notFound('Workspace')
  if (input.buyerIdentity && input.buyerIdentity !== workspace.buyerIdentity) {
    throw badRequest(`Workspace "${workspace.name}" pays with identity "${workspace.buyerIdentity}", not "${input.buyerIdentity}"`)
  }
  const workspaceId = workspace.id

  let ownerMemberId = self
  if (input.ownerMemberId !== undefined) {
    const requested = input.ownerMemberId
    if (requested !== self && !admin) throw forbidden('Only workspace admins can create keys for others')
    if (requested) {
      const owner = store.getMember(requested)
      if (!owner || owner.status !== 'active') throw badRequest('The key owner must be an active member')
      if (!store.memberWorkspaceRoles(requested).has(workspaceId)) throw badRequest('The key owner must belong to the workspace')
    }
    ownerMemberId = requested
  }
  const topupEnabled = input.topupEnabled ?? false
  if (topupEnabled && !admin) throw forbidden('Only workspace admins can enable top-ups')
  if (topupEnabled && workspace.buyerIdentity === DEFAULT_BUYER_IDENTITY) throw badRequest('Keys paid from the default wallet cannot be topped up')
  if (!admin && self) {
    const member = store.getMember(self)
    if (member && member.maxKeys !== null && store.countActiveKeysForMember(self) >= member.maxKeys) {
      throw new ConsoleError(409, 'max_keys_reached', `You can have at most ${member.maxKeys} active key(s)`)
    }
  }
  const sentLimits = input.limits
  const sentPolicy = input.routingPolicy
  const sentOwnerLimits = input.ownerLimits
  const sentOwnerPolicy = input.ownerRoutingPolicy
  if (!admin && ((sentLimits && sentOwnerLimits) || (sentPolicy !== undefined && sentOwnerPolicy !== undefined))) {
    throw badRequest('Send either limits/routingPolicy or ownerLimits/ownerRoutingPolicy')
  }
  // An owner's limits and policy, however sent, are their owner layer.
  let limits = NO_BUDGET_LIMITS
  let routingPolicy: RoutingPolicy | null = null
  let ownerLimits = sentOwnerLimits ?? NO_BUDGET_LIMITS
  let ownerRoutingPolicy = sentOwnerPolicy ?? null
  if (admin) {
    limits = sentLimits ?? NO_BUDGET_LIMITS
    routingPolicy = sentPolicy ?? null
  } else {
    ownerLimits = sentOwnerLimits ?? sentLimits ?? NO_BUDGET_LIMITS
    if (sentOwnerPolicy === undefined) ownerRoutingPolicy = sentPolicy ?? null
  }
  throwIfProblem(policyInputProblem(
    keyPolicyChecks(store, { id: 'key_new', workspaceId, ownerMemberId, routingPolicy: null, ownerRoutingPolicy: null }, {
      ...(routingPolicy ? { routingPolicy } : {}),
      ...(ownerRoutingPolicy ? { ownerRoutingPolicy } : {}),
    }),
    input,
    { fields: narrowedOwnerLimits(limits, ownerLimits), effective: limitsToWire(effectiveKeyLimits({ limits, ownerLimits })) },
  ))
  const { key, secret } = store.createKey({
    label,
    workspaceId,
    ownerMemberId,
    limits,
    routingPolicy,
    ownerLimits,
    ownerRoutingPolicy,
    topupEnabled,
    expiresAt: input.expiresAt ?? null,
  })
  ctx.log(`console: key ${key.id} created in ${workspaceId}`)
  recordAudit(ctx, actor, 'key.create', keyTarget(key), {
    workspaceId, ownerMemberId, limits: key.limits, routingPolicy: key.routingPolicy,
    ownerLimits: key.ownerLimits, ownerRoutingPolicy: key.ownerRoutingPolicy, topupEnabled, expiresAt: key.expiresAt,
  })
  return { key, secret }
}

export interface UpdateKeyInput extends PolicyConfirmations {
  label?: string
  /** Only accepted when it is the key's own workspace: keys never move. */
  workspaceId?: unknown
  /** Admin layer; only the periods present change, null clears a cap. */
  limits?: Partial<BudgetLimits>
  routingPolicy?: RoutingPolicy | null
  /** Owner layer. */
  ownerLimits?: Partial<BudgetLimits>
  ownerRoutingPolicy?: RoutingPolicy | null
  expiresAt?: number | null
  topupEnabled?: boolean
  ownerMemberId?: string | null
}

/** Changes a key. The admin layer, top-ups and ownership are the admins'; an owner edits their layer and may only shorten the expiry. */
export function updateKey(ctx: ServiceContext, actor: Actor, id: string, input: UpdateKeyInput, options: { as: KeyActingAs } = { as: 'admin' }): ApiKeyRecord {
  const { store } = ctx
  const key = requireKeyRecord(store, id)
  const admin = options.as === 'admin'
  if (input.workspaceId !== undefined && input.workspaceId !== key.workspaceId) throw badRequest('A key cannot move to another workspace')
  const topupEnabled = input.topupEnabled
  if (topupEnabled !== undefined && !admin) throw forbidden('Only workspace admins can change top-ups')
  if (topupEnabled && key.buyerIdentity === DEFAULT_BUYER_IDENTITY) throw badRequest('Keys paid from the default wallet cannot be topped up')
  let ownerMemberId: string | null | undefined
  if (input.ownerMemberId !== undefined) {
    if (!admin) throw forbidden('Only workspace admins can change a key\'s owner')
    ownerMemberId = input.ownerMemberId
    if (ownerMemberId && !store.memberWorkspaceRoles(ownerMemberId).has(key.workspaceId)) throw badRequest('The key owner must belong to the workspace')
  }
  if (!admin && input.limits !== undefined) throw forbidden('Only workspace admins can change a key\'s limits; set ownerLimits instead')
  if (!admin && input.routingPolicy !== undefined) throw forbidden('Only workspace admins can change a key\'s routing policy; set ownerRoutingPolicy instead')
  const { limits, routingPolicy, ownerLimits, ownerRoutingPolicy, expiresAt } = input
  if (expiresAt !== undefined && !admin) checkOwnerExpiry(key, expiresAt)

  const nextLimits = { ...key.limits, ...(limits ?? {}) }
  const nextOwnerLimits = { ...key.ownerLimits, ...(ownerLimits ?? {}) }
  throwIfProblem(policyInputProblem(
    keyPolicyChecks(store, key, {
      ...(routingPolicy !== undefined ? { routingPolicy } : {}),
      ...(ownerRoutingPolicy !== undefined ? { ownerRoutingPolicy } : {}),
    }),
    input,
    {
      fields: ownerLimits ? narrowedOwnerLimits(nextLimits, ownerLimits) : [],
      effective: limitsToWire(effectiveKeyLimits({ limits: nextLimits, ownerLimits: nextOwnerLimits })),
    },
  ))
  const updated = store.updateKey(key.id, {
    ...(input.label !== undefined ? { label: requiredText(input.label, 'label', 200) } : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(routingPolicy !== undefined ? { routingPolicy } : {}),
    ...(ownerLimits !== undefined ? { ownerLimits } : {}),
    ...(ownerRoutingPolicy !== undefined ? { ownerRoutingPolicy } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(topupEnabled !== undefined ? { topupEnabled } : {}),
    ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
  })
  recordAudit(ctx, actor, 'key.update', keyTarget(updated), {
    changes: changedFields(key, updated, ['label', 'limits', 'routingPolicy', 'ownerLimits', 'ownerRoutingPolicy', 'topupEnabled', 'expiresAt', 'ownerMemberId']),
  })
  return updated
}

/** A new secret for the same key id (usage, limits and policy stay); ends the key's console sessions. */
export function rotateKey(ctx: ServiceContext, actor: Actor, id: string): { key: ApiKeyRecord; secret: string } {
  const key = requireKeyRecord(ctx.store, id)
  if (key.status !== 'active') throw new ConsoleError(409, 'key_revoked', 'Revoked keys cannot be rotated')
  const rotated = ctx.store.rotateKey(key.id)
  ctx.sessions?.revokeKeySessions(key.id)
  ctx.log(`console: key ${key.id} rotated`)
  recordAudit(ctx, actor, 'key.rotate', keyTarget(key))
  return rotated
}

/** Revokes a key at once and ends its console sessions. */
export function revokeKey(ctx: ServiceContext, actor: Actor, id: string): ApiKeyRecord {
  const key = requireKeyRecord(ctx.store, id)
  const revoked = ctx.store.revokeKey(key.id)
  ctx.sessions?.revokeKeySessions(key.id)
  ctx.log(`console: key ${key.id} revoked`)
  recordAudit(ctx, actor, 'key.revoke', keyTarget(key))
  return revoked
}
