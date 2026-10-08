/**
 * A routing policy says which sellers may serve a request and how the
 * eligible ones are ranked. Policies are set at several levels (gateway
 * default, workspace, member, API key, preset) and combined with
 * `narrowPolicy`: a lower level can only restrict what the level above it
 * allows, never widen it.
 *
 * The gateway resolves the effective policy for each request and hands it to
 * the buyer in `ROUTING_POLICY_HEADER`, authenticated by
 * `GATEWAY_CONTROL_HEADER`. The buyer combines it with its own process-wide
 * routing config the same way, so a request can never escape the buyer's
 * configuration either.
 */

import { canonicalModelKey } from '@antseed/node/model-identity'

export const ROUTING_POLICY_HEADER = 'x-antseed-routing-policy'
/** Shared secret proving the routing policy came from the local gateway. */
export const GATEWAY_CONTROL_HEADER = 'x-antseed-gateway-auth'
/** File, relative to the data dir, holding the gateway↔buyer control secret. */
export const GATEWAY_CONTROL_SECRET_FILE = 'gateway/buyer-control.secret'
/** Overrides the secret file, e.g. when the buyer and gateway run in separate containers. */
export const GATEWAY_CONTROL_SECRET_ENV = 'ANTSEED_GATEWAY_CONTROL_SECRET'

export type RoutingSort = 'balanced' | 'price' | 'latency' | 'trust'

export interface RoutingPolicy {
  /** Only these sellers may serve. Undefined means any seller; an empty list means none. */
  allowedPeerIds?: string[]
  /** These sellers never serve. */
  blockedPeerIds?: string[]
  /**
   * Saved peer lists (ids), by reference, so editing a list changes every
   * policy that uses it. Allowed lists add their members to the allowed
   * sellers (the allow list exists once either field is set); blocked lists
   * add theirs to the blocked ones. The gateway expands them with
   * `expandPeerLists` before routing; the buyer refuses policies that still
   * carry them.
   */
  allowedPeerLists?: string[]
  blockedPeerLists?: string[]
  /**
   * Further allow specs a seller must also match, each read like
   * `allowedPeerIds` ∪ `allowedPeerLists` (an AND of ORs). `narrowPolicy`
   * produces them when it combines allow specs that reference peer lists, so
   * a lower level adding a list can never widen the level above it.
   * `expandPeerLists` intersects them into `allowedPeerIds`.
   */
  allowedPeerGroups?: AllowGroup[]
  /** Minimum trust score, 0–100. */
  minTrustScore?: number
  /** Minimum reputation, 0–100. */
  minReputation?: number
  /** Only sellers whose responses pass a verifier (e.g. TEE attestation). */
  requireVerified?: boolean
  /**
   * Only sellers advertising the TEE verifier capability. A capability check,
   * not a verification result, so it works whether or not this buyer runs
   * verification.
   */
  requireTee?: boolean
  /** Price caps; a seller over any cap is not eligible. */
  maxInputUsdPerMillion?: number
  maxOutputUsdPerMillion?: number
  maxCachedInputUsdPerMillion?: number
  maxImageUsdPerImage?: number
  /** Rank free sellers first among the eligible ones. */
  preferFreePeers?: boolean
  /** How eligible sellers are ordered. Defaults to 'balanced'. */
  sort?: RoutingSort
  /**
   * Only these models (service ids, without a `peer@` prefix), matched with
   * `sameRoutingModel`. Undefined means any model.
   */
  allowedModels?: string[]
  /**
   * Ordered sellers to try first per model (a fallback chain). Sellers that
   * the rest of the policy excludes are skipped; after the chain the normal
   * ranking continues unless `strict` is set on the entry. Keys are matched
   * with `sameRoutingModel`.
   */
  modelRoutes?: Record<string, ModelRoute>
}

/** One allow spec: a seller matches when it is in `peerIds` or in any of `peerLists`. */
export interface AllowGroup {
  peerIds?: string[]
  peerLists?: string[]
}

export interface ModelRoute {
  peerIds: string[]
  /** Only the listed sellers may serve this model. */
  strict?: boolean
}

/** The service part of a model id: `peer@model` → `model`. */
export function modelServiceId(model: string): string {
  const trimmed = model.trim()
  const at = trimmed.indexOf('@')
  return at > 0 ? trimmed.slice(at + 1) : trimmed
}

/**
 * The key every policy model comparison uses (gateway `allowedModels`, the
 * buyer's allow check, per-model routes), the same canonical key the buyer
 * routes by: a pinned `peer@model` counts as its service, case and cosmetic
 * variants (`GPT-5.6`, `gpt-56`, vendor paths, release dates) collapse.
 */
export function policyModelKey(model: string): string {
  const service = modelServiceId(model)
  return canonicalModelKey(service) || service.toLowerCase()
}

/** Whether two model ids name the same model for routing-policy purposes. */
export function sameRoutingModel(a: string, b: string): boolean {
  const key = policyModelKey(a)
  return key !== '' && key === policyModelKey(b)
}

/** The policy's route for a model, by exact key first, then by `sameRoutingModel`. */
export function findModelRoute(policy: RoutingPolicy | null | undefined, model: string | null | undefined): ModelRoute | null {
  if (!policy?.modelRoutes || !model) return null
  const exact = policy.modelRoutes[model]
  if (exact) return exact
  const wanted = policyModelKey(model)
  if (!wanted) return null
  for (const [key, route] of Object.entries(policy.modelRoutes)) {
    if (policyModelKey(key) === wanted) return route
  }
  return null
}

export function normalizePeerId(peerId: string): string {
  return peerId.trim().toLowerCase().replace(/^0x/, '')
}

function normalizeList(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  return [...new Set(values.map(normalizePeerId).filter((value) => value.length > 0))]
}

function intersect(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const right = new Set(b)
  return a.filter((value) => right.has(value))
}

function union(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return [...new Set([...a, ...b])]
}

function maxOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

function minOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

function normalizeListIds(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

function intersectModels(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const right = new Set(b.map(policyModelKey))
  return a.filter((model) => right.has(policyModelKey(model)))
}

function normalizeModels(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const model = value.trim()
    const key = policyModelKey(model)
    if (!model || seen.has(key)) continue
    seen.add(key)
    result.push(model)
  }
  return result
}

/** An `AllowGroup` with both lists present. */
type ResolvedAllowGroup = Required<AllowGroup>

/** A policy's allow specs as groups that must all match; empty when any seller may serve. */
function allowGroupsOf(policy: RoutingPolicy): ResolvedAllowGroup[] {
  const groups = (policy.allowedPeerGroups ?? []).map((group) => ({ peerIds: group.peerIds ?? [], peerLists: group.peerLists ?? [] }))
  if (policy.allowedPeerIds !== undefined || policy.allowedPeerLists !== undefined) {
    groups.unshift({ peerIds: policy.allowedPeerIds ?? [], peerLists: policy.allowedPeerLists ?? [] })
  }
  return groups
}

function isSubset(a: readonly string[], b: readonly string[]): boolean {
  const right = new Set(b)
  return a.every((value) => right.has(value))
}

/**
 * Combines allow specs as one set per level: a seller must be allowed by
 * every level (its ids or its lists). Groups without lists intersect at once;
 * groups with lists stay separate until `expandPeerLists` knows their
 * members. A group that contains another one adds nothing and is dropped.
 */
function combineAllowSpecs(groups: ResolvedAllowGroup[]): Pick<RoutingPolicy, 'allowedPeerIds' | 'allowedPeerLists' | 'allowedPeerGroups'> {
  if (groups.length === 0) return {}
  let idsOnly: string[] | undefined
  const withLists: ResolvedAllowGroup[] = []
  for (const group of groups) {
    if (group.peerLists.length === 0) idsOnly = intersect(idsOnly, group.peerIds)
    else withLists.push(group)
  }
  const all = idsOnly === undefined ? withLists : [{ peerIds: idsOnly, peerLists: [] }, ...withLists]
  const within = (a: ResolvedAllowGroup, b: ResolvedAllowGroup): boolean =>
    isSubset(a.peerIds, b.peerIds) && isSubset(a.peerLists, b.peerLists)
  let kept: ResolvedAllowGroup[] = []
  for (const group of all) {
    if (kept.some((other) => within(other, group))) continue
    kept = [...kept.filter((other) => !within(group, other)), group]
  }
  const [first, ...rest] = kept
  const result: Pick<RoutingPolicy, 'allowedPeerIds' | 'allowedPeerLists' | 'allowedPeerGroups'> = {}
  if (first!.peerIds.length > 0 || first!.peerLists.length === 0) result.allowedPeerIds = first!.peerIds
  if (first!.peerLists.length > 0) result.allowedPeerLists = first!.peerLists
  if (rest.length > 0) {
    result.allowedPeerGroups = rest.map((group) => ({
      ...(group.peerIds.length > 0 ? { peerIds: group.peerIds } : {}),
      peerLists: group.peerLists,
    }))
  }
  return result
}

/**
 * A child's route for a model under the parent's. Under a strict parent the
 * result stays strict and may only name the parent's sellers (the child's
 * order, or the parent's list when the child names none); otherwise the
 * child's chain replaces the parent's.
 */
function narrowRoute(parent: ModelRoute, child: ModelRoute): ModelRoute {
  if (!parent.strict) return { peerIds: [...child.peerIds], ...(child.strict ? { strict: true } : {}) }
  if (child.peerIds.length === 0) return { peerIds: [...parent.peerIds], strict: true }
  const allowed = new Set(parent.peerIds)
  return { peerIds: child.peerIds.filter((peerId) => allowed.has(peerId)), strict: true }
}

/** Merges route maps by model (`policyModelKey`), keeping the first spelling of each key. */
function narrowModelRoutes(
  parent: Record<string, ModelRoute> | undefined,
  child: Record<string, ModelRoute> | undefined,
): Record<string, ModelRoute> | undefined {
  if (!child) return parent && Object.keys(parent).length > 0 ? parent : undefined
  const result: Record<string, ModelRoute> = { ...(parent ?? {}) }
  const keys = new Map(Object.keys(result).map((model) => [policyModelKey(model), model]))
  for (const [model, route] of Object.entries(child)) {
    const key = policyModelKey(model)
    const existing = keys.get(key)
    if (existing === undefined) {
      keys.set(key, model)
      result[model] = route
    } else {
      result[existing] = narrowRoute(result[existing]!, route)
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Combines a parent policy with a child's. Restrictions accumulate (allow
 * specs intersect as sets of sellers, peer lists included, block lists
 * union, minimums take the higher value, caps the lower, `requireVerified`
 * and `requireTee` are sticky); ranking
 * preferences (`sort`, `preferFreePeers`, non-strict per-model routes) take
 * the child's value when it sets one. A strict parent route stays strict and
 * can only lose sellers.
 */
export function narrowPolicy(parent: RoutingPolicy, child: RoutingPolicy | null | undefined): RoutingPolicy {
  if (!child) return normalizePolicy(parent)
  const p = normalizePolicy(parent)
  const c = normalizePolicy(child)
  const result: RoutingPolicy = {
    ...combineAllowSpecs([...allowGroupsOf(p), ...allowGroupsOf(c)]),
    blockedPeerIds: union(p.blockedPeerIds, c.blockedPeerIds),
    blockedPeerLists: union(p.blockedPeerLists, c.blockedPeerLists),
    minTrustScore: maxOf(p.minTrustScore, c.minTrustScore),
    minReputation: maxOf(p.minReputation, c.minReputation),
    requireVerified: p.requireVerified || c.requireVerified ? true : undefined,
    requireTee: p.requireTee || c.requireTee ? true : undefined,
    maxInputUsdPerMillion: minOf(p.maxInputUsdPerMillion, c.maxInputUsdPerMillion),
    maxOutputUsdPerMillion: minOf(p.maxOutputUsdPerMillion, c.maxOutputUsdPerMillion),
    maxCachedInputUsdPerMillion: minOf(p.maxCachedInputUsdPerMillion, c.maxCachedInputUsdPerMillion),
    maxImageUsdPerImage: minOf(p.maxImageUsdPerImage, c.maxImageUsdPerImage),
    preferFreePeers: c.preferFreePeers ?? p.preferFreePeers,
    sort: c.sort ?? p.sort,
    allowedModels: intersectModels(p.allowedModels, c.allowedModels),
    modelRoutes: narrowModelRoutes(p.modelRoutes, c.modelRoutes),
  }
  return stripUndefined(result)
}

export function normalizePolicy(policy: RoutingPolicy): RoutingPolicy {
  // Keys naming the same model (`GPT-X`, `gpt-x`) collapse into the first,
  // combined like a parent and child route so a strict entry never loosens.
  let modelRoutes: Record<string, ModelRoute> | undefined
  if (policy.modelRoutes) {
    for (const [rawModel, route] of Object.entries(policy.modelRoutes)) {
      const model = rawModel.trim()
      if (!model) continue
      const normalized: ModelRoute = { peerIds: normalizeList(route.peerIds) ?? [], ...(route.strict ? { strict: true } : {}) }
      modelRoutes = narrowModelRoutes(modelRoutes, { [model]: normalized })
    }
  }
  return stripUndefined({
    ...policy,
    allowedModels: normalizeModels(policy.allowedModels),
    allowedPeerIds: normalizeList(policy.allowedPeerIds),
    blockedPeerIds: normalizeList(policy.blockedPeerIds),
    allowedPeerLists: normalizeListIds(policy.allowedPeerLists),
    blockedPeerLists: normalizeListIds(policy.blockedPeerLists),
    allowedPeerGroups: policy.allowedPeerGroups?.length
      ? policy.allowedPeerGroups.map((group) => stripUndefined({ peerIds: normalizeList(group.peerIds), peerLists: normalizeListIds(group.peerLists) }))
      : undefined,
    modelRoutes,
  })
}

/**
 * Replaces peer list references with the lists' current members. A list that
 * no longer exists contributes no sellers, so an allow list made only of
 * deleted lists lets no seller serve (it never widens to "any seller").
 * Expand each level before `narrowPolicy`, so allow lists intersect as sets
 * of sellers rather than as list ids.
 */
export function expandPeerLists(policy: RoutingPolicy, listPeers: (listId: string) => readonly string[] | null): RoutingPolicy {
  const { allowedPeerLists, blockedPeerLists, allowedPeerGroups, ...rest } = policy
  if (allowedPeerLists === undefined && blockedPeerLists === undefined && allowedPeerGroups === undefined) return normalizePolicy(rest)
  const members = (ids: string[]) => ids.flatMap((id) => listPeers(id) ?? [])
  const expanded: RoutingPolicy = { ...rest }
  let allowed: string[] | undefined
  for (const group of allowGroupsOf(policy)) {
    allowed = intersect(allowed, normalizeList([...group.peerIds, ...members(group.peerLists)]))
  }
  if (allowed !== undefined) expanded.allowedPeerIds = allowed
  if (blockedPeerLists !== undefined && blockedPeerLists.length > 0) {
    expanded.blockedPeerIds = [...(rest.blockedPeerIds ?? []), ...members(blockedPeerLists)]
  }
  return normalizePolicy(expanded)
}

/**
 * The policy without settings that change nothing: the default sort, flags
 * set to false, an empty route map. A policy that is empty after this routes
 * exactly like no policy at all, so the gateway does not send it.
 */
export function meaningfulPolicy(policy: RoutingPolicy): RoutingPolicy {
  const result = normalizePolicy(policy)
  if (result.sort === 'balanced') delete result.sort
  if (result.preferFreePeers === false) delete result.preferFreePeers
  if (result.requireVerified === false) delete result.requireVerified
  if (result.requireTee === false) delete result.requireTee
  if (result.modelRoutes && Object.keys(result.modelRoutes).length === 0) delete result.modelRoutes
  return result
}

/**
 * Fields where `sent` asked for more than `effective` (the policy after
 * narrowing `sent` under every level above it) allows: sellers or models the
 * levels above do not allow, a looser minimum or price cap, a requirement
 * turned off, a model route that lost sellers. Both must have their peer
 * lists expanded. Settings `sent` leaves out never count.
 */
export function narrowedFields(sent: RoutingPolicy, effective: RoutingPolicy): string[] {
  const fields: string[] = []
  if (sent.allowedPeerIds !== undefined) {
    const allowed = effective.allowedPeerIds
    if (allowed !== undefined && !isSubset(normalizeList(sent.allowedPeerIds)!, allowed)) fields.push('allowedPeerIds')
  }
  if (sent.allowedModels !== undefined && effective.allowedModels !== undefined) {
    const allowed = new Set(effective.allowedModels.map(policyModelKey))
    if (sent.allowedModels.some((model) => !allowed.has(policyModelKey(model)))) fields.push('allowedModels')
  }
  for (const field of ['minTrustScore', 'minReputation'] as const) {
    if (sent[field] !== undefined && (effective[field] ?? 0) > sent[field]!) fields.push(field)
  }
  for (const field of ['maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion', 'maxImageUsdPerImage'] as const) {
    if (sent[field] !== undefined && effective[field] !== undefined && effective[field]! < sent[field]!) fields.push(field)
  }
  for (const field of ['requireVerified', 'requireTee'] as const) {
    if (sent[field] === false && effective[field] === true) fields.push(field)
  }
  if (sent.modelRoutes) {
    for (const [model, route] of Object.entries(sent.modelRoutes)) {
      const actual = findModelRoute(effective, model)
      const peers = normalizeList(route.peerIds) ?? []
      if (!actual || (route.strict && !actual.strict) || actual.peerIds.length !== peers.length || !isSubset(peers, actual.peerIds)) {
        fields.push('modelRoutes')
        break
      }
    }
  }
  return fields
}

/** Whether the policy lets this seller serve at all (allow and block lists only). */
export function policyAllowsPeer(policy: RoutingPolicy, peerId: string): boolean {
  const id = normalizePeerId(peerId)
  if (policy.blockedPeerIds?.some((blocked) => normalizePeerId(blocked) === id)) return false
  if (policy.allowedPeerIds && !policy.allowedPeerIds.some((allowed) => normalizePeerId(allowed) === id)) return false
  // Unexpanded list references cannot be checked here; only listed ids count.
  if (policy.allowedPeerGroups?.some((group) => !group.peerIds?.some((allowed) => normalizePeerId(allowed) === id))) return false
  return true
}

/**
 * The `allowedModels` check shared by the gateway and the buyer. A pinned
 * `peer@model` is judged by its service; with an allow list, no model at all
 * is refused rather than routed to anything.
 */
export function policyAllowsModel(policy: RoutingPolicy | null | undefined, model: string | null | undefined): boolean {
  if (!policy?.allowedModels) return true
  if (!model) return false
  return policy.allowedModels.some((allowed) => sameRoutingModel(allowed, model))
}

export function encodePolicyHeader(policy: RoutingPolicy): string {
  return Buffer.from(JSON.stringify(stripUndefined(policy)), 'utf8').toString('base64url')
}

/** Returns null for a malformed header; callers must then reject the request rather than route unrestricted. */
export function decodePolicyHeader(value: string): RoutingPolicy | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!isRoutingPolicy(parsed)) return null
    // The buyer cannot resolve list ids; refuse rather than ignore a restriction.
    if (parsed.allowedPeerLists !== undefined || parsed.blockedPeerLists !== undefined || parsed.allowedPeerGroups !== undefined) return null
    return normalizePolicy(parsed)
  } catch {
    return null
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

export function isRoutingPolicy(value: unknown): value is RoutingPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const policy = value as Record<string, unknown>
  const lists = ['allowedPeerIds', 'blockedPeerIds', 'allowedPeerLists', 'blockedPeerLists', 'allowedModels'] as const
  if (lists.some((key) => policy[key] !== undefined && !isStringArray(policy[key]))) return false
  const numbers = ['minTrustScore', 'minReputation', 'maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion', 'maxImageUsdPerImage'] as const
  if (numbers.some((key) => !isOptionalNumber(policy[key]))) return false
  const flags = ['requireVerified', 'requireTee', 'preferFreePeers'] as const
  if (flags.some((key) => policy[key] !== undefined && typeof policy[key] !== 'boolean')) return false
  if (policy['sort'] !== undefined && !['balanced', 'price', 'latency', 'trust'].includes(policy['sort'] as string)) return false
  const groups = policy['allowedPeerGroups']
  if (groups !== undefined) {
    if (!Array.isArray(groups)) return false
    for (const group of groups as unknown[]) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) return false
      const entry = group as Record<string, unknown>
      if (entry['peerIds'] !== undefined && !isStringArray(entry['peerIds'])) return false
      if (entry['peerLists'] !== undefined && !isStringArray(entry['peerLists'])) return false
    }
  }
  const routes = policy['modelRoutes']
  if (routes !== undefined) {
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) return false
    for (const route of Object.values(routes as Record<string, unknown>)) {
      if (!route || typeof route !== 'object') return false
      const entry = route as Record<string, unknown>
      if (!isStringArray(entry['peerIds'])) return false
      if (entry['strict'] !== undefined && typeof entry['strict'] !== 'boolean') return false
    }
  }
  return true
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
