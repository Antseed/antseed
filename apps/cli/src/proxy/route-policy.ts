import { createHash, timingSafeEqual } from 'node:crypto'
import type { ModelRoutingPreferences } from '@antseed/node'
import {
  findModelRoute,
  normalizePeerId,
  policyAllowsPeer,
  type RoutingPolicy,
} from '../routing-policy/policy.js'

/**
 * Buyer-side evaluation of a gateway routing policy. The buyer proxy applies
 * the policy the local gateway sends with each request (see
 * `routing-policy/policy.ts`) under its own hard limits (see `buyerHardPolicy`).
 * Everything here is pure so the real routing path and
 * `GET /_antseed/route-preview` share one implementation.
 */

/** Constant-time comparison of two secrets of any length. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * The buyer's hard limits expressed as a policy, so a gateway policy narrows
 * under them: `buyer.minPeerReputation` and a required verifier. Buyer max
 * pricing is not included: it is hierarchical (per provider / per service)
 * and stays enforced by the router plugin's `allowsPeerForPolicy`, which
 * every candidate still passes through.
 *
 * `buyer.routingPreferences` (minTrustScore, allow/block lists, preferFree,
 * the soft input-price cap) are deliberately absent: they are the buyer's
 * defaults for automatic routing, and a gateway policy replaces them (the
 * gateway console is the authority for its keys). See `rankingPreferences`.
 */
export function buyerHardPolicy(input: {
  minPeerReputation?: number | null
  verifierRequired?: boolean
}): RoutingPolicy {
  const policy: RoutingPolicy = {}
  if (typeof input.minPeerReputation === 'number' && input.minPeerReputation > 0) {
    policy.minReputation = input.minPeerReputation
  }
  if (input.verifierRequired) policy.requireVerified = true
  return policy
}

/**
 * The buyer's routing preferences reduced to ranking only, for requests that
 * carry a gateway policy: nothing is excluded (no trust minimum, no allow or
 * block list), while preferFree and the soft input-price penalty still order
 * candidates. A policy that sets `preferFreePeers` decides it.
 */
export function rankingPreferences(prefs: ModelRoutingPreferences, policy: RoutingPolicy): ModelRoutingPreferences {
  return {
    ...prefs,
    preferFreePeers: policy.preferFreePeers ?? prefs.preferFreePeers,
    minTrustScore: 0,
    allowedPeerIds: [],
    blockedPeerIds: [],
  }
}

/** A buyer-limit reason labelled with its level, e.g. "buyer config: reputation 30 below 40". */
export function buyerConfigReason(reason: string): string {
  const plain = reason
    .replace(/ below buyer minimum /, ' below ')
    .replace(/ over buyer cap /, ' over cap ')
    .replace(/^outside buyer /, 'outside ')
  return `buyer config: ${plain}`
}

/** What the policy evaluator needs to know about one seller's offer for the requested model. */
export interface PolicyPeerFacts {
  peerId: string
  /** Buyer trust score, 0–100 (null when unscored). */
  trustScore: number | null
  /** Reputation used by the buyer's `minPeerReputation`, 0–100 (null when unknown). */
  reputation: number | null
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  cachedInputUsdPerMillion: number | null
  /** Highest per-image price the offer can charge (null for non-image offers). */
  imageUsdPerImage: number | null
  /** Null when the seller passes or can be verified; otherwise why it cannot. */
  unverifiedReason: string | null
  /** Whether the seller advertises the TEE verifier capability. */
  teeCapable: boolean
}

function formatUsd(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000
  return `$${rounded}`
}

function idIn(list: string[] | undefined, peerId: string): boolean {
  const id = normalizePeerId(peerId)
  return list?.some((entry) => normalizePeerId(entry) === id) ?? false
}

/** Why the policy excludes this seller; empty when it does not. */
export function policyExclusionReasons(policy: RoutingPolicy, facts: PolicyPeerFacts): string[] {
  const reasons: string[] = []
  if (!policyAllowsPeer(policy, facts.peerId)) {
    reasons.push(idIn(policy.blockedPeerIds, facts.peerId) ? 'blocked' : 'not in allow list')
  }
  if (policy.minTrustScore !== undefined && policy.minTrustScore > 0) {
    if (facts.trustScore === null) reasons.push(`trust unknown, minimum ${policy.minTrustScore}`)
    else if (facts.trustScore < policy.minTrustScore) reasons.push(`trust ${Math.round(facts.trustScore)} below ${policy.minTrustScore}`)
  }
  if (policy.minReputation !== undefined && policy.minReputation > 0) {
    if (facts.reputation === null) reasons.push(`reputation unknown, minimum ${policy.minReputation}`)
    else if (facts.reputation < policy.minReputation) reasons.push(`reputation ${Math.round(facts.reputation)} below ${policy.minReputation}`)
  }
  const isImageOffer = facts.imageUsdPerImage !== null
  if (isImageOffer) {
    reasons.push(...priceCapReasons('image', facts.imageUsdPerImage, policy.maxImageUsdPerImage, true))
  } else {
    reasons.push(...priceCapReasons('input', facts.inputUsdPerMillion, policy.maxInputUsdPerMillion, true))
    reasons.push(...priceCapReasons('output', facts.outputUsdPerMillion, policy.maxOutputUsdPerMillion, true))
    // A seller without a cached-input price never charges a cached rate, so
    // the cap only bites when one is advertised.
    reasons.push(...priceCapReasons('cached input', facts.cachedInputUsdPerMillion, policy.maxCachedInputUsdPerMillion, false))
  }
  if (policy.requireVerified && facts.unverifiedReason) reasons.push(facts.unverifiedReason)
  if (policy.requireTee && !facts.teeCapable) reasons.push('no TEE')
  return reasons
}

function priceCapReasons(label: string, price: number | null, cap: number | undefined, unknownFails: boolean): string[] {
  if (cap === undefined) return []
  if (price === null) return unknownFails ? [`${label} price unknown, cap ${formatUsd(cap)}`] : []
  return price > cap ? [`${label} price ${formatUsd(price)} over cap ${formatUsd(cap)}`] : []
}

/**
 * Why the policy forbids a hard pin (`peer@model`, `x-antseed-pin-peer`,
 * session pin): the seller-level checks plus a strict model route that does
 * not list the pinned seller.
 */
export function pinnedPeerExclusionReasons(policy: RoutingPolicy, facts: PolicyPeerFacts, model: string | null): string[] {
  const reasons = policyExclusionReasons(policy, facts)
  const route = findModelRoute(policy, model)
  if (route?.strict && !idIn(route.peerIds, facts.peerId)) reasons.push('not in strict route for this model')
  return reasons
}

/** Why the buyer's own routing preferences exclude a seller, mirroring `isModelRouteEligible`. */
export function preferenceExclusionReasons(
  prefs: ModelRoutingPreferences,
  peerId: string,
  effectiveTrust: number | null,
): string[] {
  const reasons: string[] = []
  if (idIn(prefs.blockedPeerIds, peerId)) reasons.push('blocked by buyer config')
  else if (prefs.allowedPeerIds.length > 0 && !idIn(prefs.allowedPeerIds, peerId)) reasons.push('not in buyer allow list')
  if (prefs.minTrustScore > 0) {
    if (effectiveTrust === null) reasons.push(`trust unknown, buyer minimum ${prefs.minTrustScore}`)
    else if (effectiveTrust < prefs.minTrustScore) reasons.push(`trust ${Math.round(effectiveTrust)} below buyer minimum ${prefs.minTrustScore}`)
  }
  return reasons
}

export interface PolicyOrderingAccessors<T> {
  peerId: (candidate: T) => string
  totalPrice: (candidate: T) => number | null
  trustScore: (candidate: T) => number | null
  /** Recent latency in ms, or null when the buyer has not measured this seller. */
  latencyMs: (candidate: T) => number | null
  coolingDown: (candidate: T) => boolean
}

export interface PolicyOrdering<T> {
  ordered: T[]
  /** Candidates a strict model route removed, keyed by normalized peer id. */
  excluded: Map<string, string>
  /** Position in the model route's chain, keyed by normalized peer id (0-based). */
  chainPosition: Map<string, number>
}

function nullsLast(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * direction
}

/**
 * Re-orders already-eligible candidates by the policy's ranking preferences.
 * The incoming order is the buyer's own ("balanced") ranking and breaks every
 * tie. Ready sellers stay ahead of cooling-down ones in every mode. With
 * `sort: 'latency'`, sellers the buyer has not measured yet rank after the
 * measured ones, in balanced order.
 *
 * A model route's chain then moves its sellers to the front in chain order
 * (ready ones first); `strict` drops everyone else.
 */
export function orderByPolicy<T>(
  candidates: T[],
  policy: RoutingPolicy,
  model: string | null,
  get: PolicyOrderingAccessors<T>,
): PolicyOrdering<T> {
  const indexed = candidates.map((candidate, index) => ({ candidate, index }))
  const sort = policy.sort ?? 'balanced'
  indexed.sort((a, b) => {
    const coolingA = get.coolingDown(a.candidate)
    const coolingB = get.coolingDown(b.candidate)
    if (coolingA !== coolingB) return coolingA ? 1 : -1
    if (policy.preferFreePeers) {
      const freeA = get.totalPrice(a.candidate) === 0
      const freeB = get.totalPrice(b.candidate) === 0
      if (freeA !== freeB) return freeA ? -1 : 1
    }
    let primary = 0
    if (sort === 'price') primary = nullsLast(get.totalPrice(a.candidate), get.totalPrice(b.candidate), 1)
    else if (sort === 'latency') primary = nullsLast(get.latencyMs(a.candidate), get.latencyMs(b.candidate), 1)
    else if (sort === 'trust') primary = nullsLast(get.trustScore(a.candidate), get.trustScore(b.candidate), -1)
    return primary || a.index - b.index
  })
  let ordered = indexed.map(({ candidate }) => candidate)
  const excluded = new Map<string, string>()
  const chainPosition = new Map<string, number>()

  const route = findModelRoute(policy, model)
  if (route) {
    const chain = route.peerIds.map(normalizePeerId)
    chain.forEach((peerId, position) => { if (!chainPosition.has(peerId)) chainPosition.set(peerId, position) })
    const inChain = ordered
      .filter((candidate) => chainPosition.has(normalizePeerId(get.peerId(candidate))))
      .sort((a, b) => {
        const coolingA = get.coolingDown(a)
        const coolingB = get.coolingDown(b)
        if (coolingA !== coolingB) return coolingA ? 1 : -1
        return chainPosition.get(normalizePeerId(get.peerId(a)))! - chainPosition.get(normalizePeerId(get.peerId(b)))!
      })
    const rest = ordered.filter((candidate) => !chainPosition.has(normalizePeerId(get.peerId(candidate))))
    if (route.strict) {
      for (const candidate of rest) excluded.set(normalizePeerId(get.peerId(candidate)), 'not in strict route for this model')
      ordered = inChain
    } else {
      ordered = [...inChain, ...rest]
    }
  }
  return { ordered, excluded, chainPosition }
}
