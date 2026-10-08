import type { BuyerLimits, PeerList, RoutingPolicy, RoutingSort } from '../api/types'
import { formatPricePerMillion } from './format'
import { samePeerId } from './peer-id'

/**
 * Form state for the routing policy editor. Peer lists are stored by
 * reference (`allowedPeerLists` / `blockedPeerLists`), so editing a list
 * changes every policy that uses it; the gateway expands them. Numbers are
 * kept as strings so a field can be blank (= inherit from the level above).
 */
export interface PolicyDraft {
  allowMode: 'any' | 'only'
  allowedPeerIds: string[]
  allowedListIds: string[]
  blockedPeerIds: string[]
  blockedListIds: string[]
  minTrustScore: string
  minReputation: string
  requireVerified: boolean
  requireTee: boolean
  maxInputUsdPerMillion: string
  maxOutputUsdPerMillion: string
  maxCachedInputUsdPerMillion: string
  maxImageUsdPerImage: string
  preferFreePeers: 'inherit' | 'yes' | 'no'
  sort: RoutingSort | ''
  modelsMode: 'any' | 'only'
  allowedModels: string[]
  routes: DraftRoute[]
}

export interface DraftRoute {
  model: string
  peerIds: string[]
  strict: boolean
}

export const SORT_LABELS: Record<RoutingSort, string> = {
  balanced: 'Balanced',
  price: 'Lowest price',
  latency: 'Lowest latency',
  trust: 'Highest trust',
}

export function emptyDraft(): PolicyDraft {
  return {
    allowMode: 'any', allowedPeerIds: [], allowedListIds: [],
    blockedPeerIds: [], blockedListIds: [],
    minTrustScore: '', minReputation: '', requireVerified: false, requireTee: false,
    maxInputUsdPerMillion: '', maxOutputUsdPerMillion: '', maxCachedInputUsdPerMillion: '', maxImageUsdPerImage: '',
    preferFreePeers: 'inherit', sort: '',
    modelsMode: 'any', allowedModels: [],
    routes: [],
  }
}

function numberText(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

function preferFreeText(value: boolean | undefined): PolicyDraft['preferFreePeers'] {
  if (value === undefined) return 'inherit'
  return value ? 'yes' : 'no'
}

export function policyToDraft(policy: RoutingPolicy | null | undefined): PolicyDraft {
  const draft = emptyDraft()
  if (!policy) return draft
  return {
    ...draft,
    allowMode: policy.allowedPeerIds || policy.allowedPeerLists ? 'only' : 'any',
    allowedPeerIds: [...(policy.allowedPeerIds ?? [])],
    allowedListIds: [...(policy.allowedPeerLists ?? [])],
    blockedPeerIds: [...(policy.blockedPeerIds ?? [])],
    blockedListIds: [...(policy.blockedPeerLists ?? [])],
    minTrustScore: numberText(policy.minTrustScore),
    minReputation: numberText(policy.minReputation),
    requireVerified: policy.requireVerified === true,
    requireTee: policy.requireTee === true,
    maxInputUsdPerMillion: numberText(policy.maxInputUsdPerMillion),
    maxOutputUsdPerMillion: numberText(policy.maxOutputUsdPerMillion),
    maxCachedInputUsdPerMillion: numberText(policy.maxCachedInputUsdPerMillion),
    maxImageUsdPerImage: numberText(policy.maxImageUsdPerImage),
    preferFreePeers: preferFreeText(policy.preferFreePeers),
    sort: policy.sort ?? '',
    modelsMode: policy.allowedModels ? 'only' : 'any',
    allowedModels: [...(policy.allowedModels ?? [])],
    routes: Object.entries(policy.modelRoutes ?? {}).map(([model, route]) => ({ model, peerIds: [...route.peerIds], strict: route.strict === true })),
  }
}

export class DraftError extends Error {}

function parseNumber(label: string, value: string, max?: number): number | undefined {
  const raw = value.trim()
  if (raw === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) throw new DraftError(`${label} must be a positive number.`)
  if (max !== undefined && parsed > max) throw new DraftError(`${label} must be at most ${max}.`)
  return parsed
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/** Ids of lists that still exist; a reference to a deleted list is dropped on save. */
function knownLists(listIds: string[], lists: readonly PeerList[] | null): string[] {
  const ids = unique(listIds)
  return lists ? ids.filter((id) => lists.some((list) => list.id === id)) : ids
}

/**
 * Turns editor state into a policy; throws `DraftError` with a field message
 * when invalid. Pass `lists` to drop references to lists that were deleted.
 */
export function draftToPolicy(draft: PolicyDraft, lists: readonly PeerList[] | null = null): RoutingPolicy {
  const policy: RoutingPolicy = {}
  if (draft.allowMode === 'only') {
    const allowedLists = knownLists(draft.allowedListIds, lists)
    const allowedIds = unique(draft.allowedPeerIds)
    // With only lists, the allow list is their members; no ids and no lists means no seller.
    if (allowedIds.length > 0 || allowedLists.length === 0) policy.allowedPeerIds = allowedIds
    if (allowedLists.length > 0) policy.allowedPeerLists = allowedLists
  }
  const blocked = unique(draft.blockedPeerIds)
  if (blocked.length > 0) policy.blockedPeerIds = blocked
  const blockedLists = knownLists(draft.blockedListIds, lists)
  if (blockedLists.length > 0) policy.blockedPeerLists = blockedLists
  const minTrust = parseNumber('Minimum trust', draft.minTrustScore, 100)
  if (minTrust !== undefined) policy.minTrustScore = minTrust
  const minReputation = parseNumber('Minimum reputation', draft.minReputation, 100)
  if (minReputation !== undefined) policy.minReputation = minReputation
  if (draft.requireVerified) policy.requireVerified = true
  if (draft.requireTee) policy.requireTee = true
  const caps = [
    ['maxInputUsdPerMillion', 'Input price cap'],
    ['maxOutputUsdPerMillion', 'Output price cap'],
    ['maxCachedInputUsdPerMillion', 'Cached input price cap'],
    ['maxImageUsdPerImage', 'Image price cap'],
  ] as const
  for (const [key, label] of caps) {
    const value = parseNumber(label, draft[key])
    if (value !== undefined) policy[key] = value
  }
  if (draft.preferFreePeers !== 'inherit') policy.preferFreePeers = draft.preferFreePeers === 'yes'
  if (draft.sort) policy.sort = draft.sort
  if (draft.modelsMode === 'only') policy.allowedModels = unique(draft.allowedModels)
  const routes = draft.routes.filter((route) => route.model.trim() !== '')
  if (routes.length > 0) {
    const seen = new Set<string>()
    policy.modelRoutes = {}
    for (const route of routes) {
      const model = route.model.trim()
      if (seen.has(model)) throw new DraftError(`Model "${model}" has two fallback chains.`)
      seen.add(model)
      const peerIds = unique(route.peerIds)
      if (peerIds.length === 0) throw new DraftError(`Add at least one seller to the "${model}" chain.`)
      policy.modelRoutes[model] = route.strict ? { peerIds, strict: true } : { peerIds }
    }
  }
  return policy
}

function isEmptyPolicy(policy: RoutingPolicy | null | undefined): boolean {
  return !policy || Object.keys(policy).length === 0
}

/** For nullable `routingPolicy` fields: an empty policy is stored as null (inherit everything). */
export function policyOrNull(policy: RoutingPolicy): RoutingPolicy | null {
  return isEmptyPolicy(policy) ? null : policy
}

/** Short human summary of a policy for tables. */
export function describePolicy(policy: RoutingPolicy | null | undefined): string {
  if (isEmptyPolicy(policy)) return 'Inherits'
  const p = policy!
  const parts: string[] = []
  if (p.allowedPeerIds || p.allowedPeerLists) {
    const lists = p.allowedPeerLists?.length ? ` + ${p.allowedPeerLists.length} list${p.allowedPeerLists.length === 1 ? '' : 's'}` : ''
    parts.push(`${p.allowedPeerIds?.length ?? 0} allowed${lists}`)
  }
  if (p.blockedPeerIds?.length || p.blockedPeerLists?.length) {
    const lists = p.blockedPeerLists?.length ? ` + ${p.blockedPeerLists.length} list${p.blockedPeerLists.length === 1 ? '' : 's'}` : ''
    parts.push(`${p.blockedPeerIds?.length ?? 0} blocked${lists}`)
  }
  if (p.requireTee) parts.push('TEE only')
  if (p.requireVerified) parts.push('verified only')
  if (p.minTrustScore !== undefined) parts.push(`trust ≥ ${p.minTrustScore}`)
  if (p.minReputation !== undefined) parts.push(`reputation ≥ ${p.minReputation}`)
  if (p.maxInputUsdPerMillion !== undefined || p.maxOutputUsdPerMillion !== undefined) parts.push('price caps')
  if (p.allowedModels) parts.push(`${p.allowedModels.length} models`)
  if (p.modelRoutes) parts.push(`${Object.keys(p.modelRoutes).length} fallback chains`)
  if (p.sort) parts.push(SORT_LABELS[p.sort].toLowerCase())
  if (p.preferFreePeers) parts.push('free first')
  return parts.join(' · ') || 'Custom'
}

/**
 * The buyer's hard limits as short phrases, e.g. ["reputation ≥ 40",
 * "verified sellers only", "≤ $15.00/M in", "≤ $60.00/M out"]. Empty when none apply.
 */
export function describeBuyerLimits(limits: BuyerLimits): string[] {
  const parts: string[] = []
  if (limits.minPeerReputation > 0) parts.push(`reputation ≥ ${limits.minPeerReputation}`)
  if (limits.requireVerifier) parts.push('verified sellers only')
  if (limits.maxPricing) {
    parts.push(`≤ ${formatPricePerMillion(limits.maxPricing.inputUsdPerMillion)}/M in`)
    parts.push(`≤ ${formatPricePerMillion(limits.maxPricing.outputUsdPerMillion)}/M out`)
    if (limits.maxPricing.cachedInputUsdPerMillion !== null) parts.push(`≤ ${formatPricePerMillion(limits.maxPricing.cachedInputUsdPerMillion)}/M cached`)
  }
  return parts
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
const SORT_CHIPS: Record<RoutingSort, string> = { balanced: 'balanced', price: 'price', latency: 'latency', trust: 'trust' }

/**
 * The policy as short chips for a one-line summary, e.g.
 * ["Allow 3 sellers", "TEE only", "≤ $2/M in", "Sort: price"]. Empty means it inherits everything.
 */
export function policyChips(policy: RoutingPolicy | null | undefined): string[] {
  if (isEmptyPolicy(policy)) return []
  const p = policy!
  const chips: string[] = []
  const lists = (count: number | undefined) => (count ? ` + ${plural(count, 'list')}` : '')
  if (p.allowedPeerIds || p.allowedPeerLists) {
    const ids = p.allowedPeerIds?.length ?? 0
    chips.push(ids === 0 && !p.allowedPeerLists?.length ? 'No seller allowed' : `Allow ${ids ? plural(ids, 'seller') : ''}${ids ? lists(p.allowedPeerLists?.length) : plural(p.allowedPeerLists!.length, 'list')}`)
  }
  if (p.blockedPeerIds?.length || p.blockedPeerLists?.length) {
    const ids = p.blockedPeerIds?.length ?? 0
    chips.push(`Block ${ids ? plural(ids, 'seller') + lists(p.blockedPeerLists?.length) : plural(p.blockedPeerLists!.length, 'list')}`)
  }
  if (p.requireTee) chips.push('TEE only')
  if (p.requireVerified) chips.push('Verified only')
  if (p.minTrustScore !== undefined) chips.push(`Trust ≥ ${p.minTrustScore}`)
  if (p.minReputation !== undefined) chips.push(`Reputation ≥ ${p.minReputation}`)
  if (p.maxInputUsdPerMillion !== undefined) chips.push(`≤ $${p.maxInputUsdPerMillion}/M in`)
  if (p.maxOutputUsdPerMillion !== undefined) chips.push(`≤ $${p.maxOutputUsdPerMillion}/M out`)
  if (p.maxCachedInputUsdPerMillion !== undefined) chips.push(`≤ $${p.maxCachedInputUsdPerMillion}/M cached`)
  if (p.maxImageUsdPerImage !== undefined) chips.push(`≤ $${p.maxImageUsdPerImage}/image`)
  if (p.allowedModels) chips.push(p.allowedModels.length === 0 ? 'No model allowed' : plural(p.allowedModels.length, 'model'))
  if (p.modelRoutes && Object.keys(p.modelRoutes).length > 0) chips.push(plural(Object.keys(p.modelRoutes).length, 'fallback chain'))
  if (p.sort) chips.push(`Sort: ${SORT_CHIPS[p.sort]}`)
  if (p.preferFreePeers !== undefined) chips.push(p.preferFreePeers ? 'Free sellers first' : 'Free sellers not first')
  return chips
}

/** Like `draftToPolicy`, but null instead of throwing on an invalid draft (for live summaries). */
export function draftPolicyOrNull(draft: PolicyDraft, lists: readonly PeerList[] | null = null): RoutingPolicy | null {
  try { return draftToPolicy(draft, lists) } catch { return null }
}

export type TemplateId = 'cheapest' | 'trusted' | 'tee' | 'own'

export const POLICY_TEMPLATES: Array<{ id: TemplateId; label: string; description: string }> = [
  { id: 'cheapest', label: 'Cheapest', description: 'Lowest price first, free sellers ahead.' },
  { id: 'trusted', label: 'Most trusted', description: 'Trust 70+ and reputation 60+, ranked by trust.' },
  { id: 'tee', label: 'TEE only', description: 'Only sellers running in a trusted execution environment.' },
  { id: 'own', label: 'Own peers only', description: 'Only sellers in one of your peer lists.' },
]

/** A starting policy for a template. `own` needs the peer ids of the chosen list. */
export function templatePolicy(id: TemplateId, ownPeerIds: string[] = []): RoutingPolicy {
  switch (id) {
    case 'cheapest': return { sort: 'price', preferFreePeers: true }
    case 'trusted': return { sort: 'trust', minTrustScore: 70, minReputation: 60 }
    case 'tee': return { requireTee: true }
    case 'own': return { allowedPeerIds: unique(ownPeerIds) }
  }
}

export type PeerAction = 'allow' | 'block' | 'prefer' | 'clear'

/**
 * Applies a Network-page row action to a scope's policy:
 * allow adds the seller to the allow list (creating one restricts the scope to it),
 * block adds it to the block list, prefer puts it first in the model's fallback chain,
 * clear removes it everywhere. Never mutates the input.
 */
export function applyPeerAction(policy: RoutingPolicy | null | undefined, action: PeerAction, peerId: string, model?: string): RoutingPolicy {
  const next: RoutingPolicy = structuredClone(policy ?? {})
  const without = (list: string[] | undefined) => list?.filter((entry) => !samePeerId(entry, peerId))
  if (action === 'allow') {
    next.allowedPeerIds = [...(without(next.allowedPeerIds) ?? []), peerId]
    next.blockedPeerIds = without(next.blockedPeerIds)
  } else if (action === 'block') {
    next.blockedPeerIds = [...(without(next.blockedPeerIds) ?? []), peerId]
    if (next.allowedPeerIds) next.allowedPeerIds = without(next.allowedPeerIds)
    // An allow list emptied by a block would mean "no seller"; drop it instead (the dialog warns first).
    if (next.allowedPeerIds?.length === 0 && !next.allowedPeerLists?.length) delete next.allowedPeerIds
  } else if (action === 'prefer') {
    if (!model) throw new Error('Pick a model to prefer this seller for.')
    const routes = { ...(next.modelRoutes ?? {}) }
    const current = routes[model]
    routes[model] = { ...(current ?? {}), peerIds: [peerId, ...(without(current?.peerIds) ?? [])] }
    next.modelRoutes = routes
    next.blockedPeerIds = without(next.blockedPeerIds)
  } else {
    if (next.allowedPeerIds) next.allowedPeerIds = without(next.allowedPeerIds)
    next.blockedPeerIds = without(next.blockedPeerIds)
    if (next.modelRoutes) {
      next.modelRoutes = Object.fromEntries(Object.entries(next.modelRoutes)
        .map(([key, route]) => [key, { ...route, peerIds: without(route.peerIds) ?? [] }] as const)
        .filter(([, route]) => route.peerIds.length > 0))
    }
  }
  if (next.blockedPeerIds?.length === 0) delete next.blockedPeerIds
  if (next.modelRoutes && Object.keys(next.modelRoutes).length === 0) delete next.modelRoutes
  return next
}

/** True when blocking this seller would remove the last seller from the scope's own allow list. */
export function blockEmptiesAllowList(policy: RoutingPolicy | null | undefined, peerId: string): boolean {
  const allowed = policy?.allowedPeerIds
  if (!allowed || policy?.allowedPeerLists?.length) return false
  return allowed.length > 0 && allowed.every((entry) => samePeerId(entry, peerId))
}

const DRAFT_FIELD_LABELS: Partial<Record<keyof PolicyDraft, string>> = {
  allowMode: 'allowed sellers', minTrustScore: 'minimum trust', minReputation: 'minimum reputation', requireVerified: 'verified only',
  requireTee: 'TEE only', maxInputUsdPerMillion: 'input price cap', maxOutputUsdPerMillion: 'output price cap',
  maxCachedInputUsdPerMillion: 'cached input price cap', maxImageUsdPerImage: 'image price cap', preferFreePeers: 'free sellers first',
  sort: 'sort order', modelsMode: 'allowed models',
}

/** Draft fields a template sets, as a partial draft (only what the template restricts or ranks). */
export function templateDraft(policy: RoutingPolicy): Partial<PolicyDraft> {
  const full = policyToDraft(policy)
  const empty = emptyDraft()
  const out: Partial<PolicyDraft> = {}
  for (const key of Object.keys(full) as Array<keyof PolicyDraft>) {
    if (JSON.stringify(full[key]) !== JSON.stringify(empty[key])) (out as Record<string, unknown>)[key] = full[key]
  }
  if (policy.allowedPeerIds || policy.allowedPeerLists) {
    out.allowMode = 'only'
    out.allowedPeerIds = full.allowedPeerIds
    out.allowedListIds = full.allowedListIds
  }
  return out
}

/** Labels of fields the draft already sets to something else than the template would. */
export function templateConflicts(draft: PolicyDraft, template: Partial<PolicyDraft>): string[] {
  const empty = emptyDraft()
  const labels = new Set<string>()
  for (const key of Object.keys(template) as Array<keyof PolicyDraft>) {
    const current = JSON.stringify(draft[key])
    if (current === JSON.stringify(empty[key]) || current === JSON.stringify(template[key])) continue
    const label = DRAFT_FIELD_LABELS[key] ?? (key === 'allowedPeerIds' || key === 'allowedListIds' ? 'allowed sellers' : null)
    if (label) labels.add(label)
  }
  return [...labels]
}

/** Applies a template on top of the draft: fields the template sets win, everything else is kept. */
export function mergeTemplate(draft: PolicyDraft, template: Partial<PolicyDraft>): PolicyDraft {
  return { ...draft, ...template }
}

/** Moves a list item one place up (-1) or down (+1); out-of-range moves return a copy unchanged. */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = [...items]
  const target = index + delta
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item as T)
  return next
}

/**
 * True when the policy has an allow list that names no seller: no ids, and
 * its peer lists (when known) are empty or gone. Such a policy lets no
 * seller serve, so saving one needs an explicit confirmation.
 */
export function hasEmptyAllowList(policy: RoutingPolicy | null | undefined, lists: readonly PeerList[] | null = null): boolean {
  if (!policy || (policy.allowedPeerIds === undefined && policy.allowedPeerLists === undefined)) return false
  if ((policy.allowedPeerIds ?? []).some((id) => id.trim() !== '')) return false
  const listIds = policy.allowedPeerLists ?? []
  if (listIds.length === 0) return true
  if (!lists) return false
  return listIds.every((id) => (lists.find((list) => list.id === id)?.peerIds.length ?? 0) === 0)
}
