import { hasOwnerLayer, type ApiKeyPatch, type KeyWithLayers } from '../api'
import type { ApiKey, RoutingPolicy, SpendLimits, Usdc } from '../api/types'
import { describeLimits, LIMIT_PERIODS, usdcToNumber } from './format'
import { describePolicy } from './policy'
import { combinePolicies } from './policy-match'

/** Which layer of a key the viewer edits: admins the admin layer, the owner their own; both when an admin owns the key. */
export interface KeyEditRights {
  admin: boolean
  owner: boolean
  /** The gateway has the separate owner layer (`ownerLimits` / `ownerRoutingPolicy`). */
  layered: boolean
}

export function keyEditRights(key: ApiKey | null, viewer: { memberId: string; workspaceAdmin: boolean }, layeredHint = false): KeyEditRights {
  const owner = key ? key.ownerMemberId === viewer.memberId : true
  return { admin: viewer.workspaceAdmin, owner, layered: key ? hasOwnerLayer(key) : layeredHint }
}

/** The lower of two limits; null is no limit. */
function tighter(x: Usdc | null, y: Usdc | null): Usdc | null {
  if (x === null) return y
  if (y === null) return x
  return usdcToNumber(x) <= usdcToNumber(y) ? x : y
}

/** The tighter of two limit sets, period by period (null = no limit). */
export function tighterLimits(a: SpendLimits | null | undefined, b: SpendLimits | null | undefined): SpendLimits {
  const out = {} as SpendLimits
  for (const period of LIMIT_PERIODS) out[period] = tighter(a?.[period] ?? null, b?.[period] ?? null)
  return out
}

/** What applies to the key from its own two layers (workspace and member levels come on top). */
export function keyEffective(key: KeyWithLayers | ApiKey): { limits: SpendLimits; policy: RoutingPolicy } {
  const owner = hasOwnerLayer(key) ? key : null
  return {
    limits: tighterLimits(key.limits, owner?.ownerLimits),
    policy: combinePolicies(key.routingPolicy, owner?.ownerRoutingPolicy ?? null),
  }
}

/**
 * The PATCH body for a key edit. Only fields the caller may change are sent:
 * the gateway refuses `topupEnabled` from non-admins and answers 409
 * `narrowed` when an owner tries to loosen something.
 */
export function keyPatch(rights: KeyEditRights, before: ApiKey, form: {
  label: string; expiresAt: number | null; topupEnabled: boolean
  adminLimits: SpendLimits; adminPolicy: RoutingPolicy | null
  ownerLimits: SpendLimits; ownerPolicy: RoutingPolicy | null
}): ApiKeyPatch {
  const patch: ApiKeyPatch = { label: form.label }
  if (form.expiresAt !== before.expiresAt) patch.expiresAt = form.expiresAt
  if (rights.admin) {
    patch.limits = form.adminLimits
    patch.routingPolicy = form.adminPolicy
    if (form.topupEnabled !== before.topupEnabled) patch.topupEnabled = form.topupEnabled
  }
  if (rights.owner && rights.layered) {
    patch.ownerLimits = form.ownerLimits
    patch.ownerRoutingPolicy = form.ownerPolicy
  } else if (rights.owner && !rights.admin) {
    // Older gateways keep one layer and narrow what an owner sends into it.
    patch.limits = form.ownerLimits
    patch.routingPolicy = form.ownerPolicy
  }
  return patch
}

const FIELD_NAMES: Record<string, string> = {
  allowedPeerIds: 'allowed sellers', allowedPeerLists: 'allowed peer lists', allowedModels: 'allowed models', modelRoutes: 'fallback chains',
  maxInputUsdPerMillion: 'input price cap', maxOutputUsdPerMillion: 'output price cap', maxCachedInputUsdPerMillion: 'cached input price cap',
  maxImageUsdPerImage: 'image price cap', minTrustScore: 'minimum trust', minReputation: 'minimum reputation',
}

/** "ownerRoutingPolicy.allowedPeerIds" → "allowed sellers"; "ownerLimits.daily" → "daily limit". */
function narrowedFieldLabel(field: string): string {
  const [, name = field] = field.split('.')
  if (/Limits$|^limits$/.test(field.split('.')[0] ?? '')) return `${name} limit`
  return FIELD_NAMES[name] ?? name
}

/** Explains a 409 `narrowed` answer from its details (`fields`, `effectiveRoutingPolicy`, `effectiveLimits`). */
export function narrowedSummary(details: Record<string, unknown>): string[] {
  const lines: string[] = []
  const fields = details['fields']
  if (Array.isArray(fields) && fields.length) {
    lines.push(`Narrowed by the levels above: ${[...new Set(fields.map((field) => narrowedFieldLabel(String(field))))].join(', ')}.`)
  }
  const policy = details['effectiveRoutingPolicy'] as RoutingPolicy | undefined
  if (policy && typeof policy === 'object') lines.push(`Routing that would apply: ${describePolicy(policy)}.`)
  const limits = details['effectiveLimits'] as SpendLimits | undefined
  if (limits && typeof limits === 'object') lines.push(`Limits that would apply: ${describeLimits(limits)}.`)
  return lines
}
