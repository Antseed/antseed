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
 * The buyer's hard limits expressed as a policy: `buyer.minPeerReputation`
 * and a required verifier. They apply to every request, automatic or
 * pinned. Buyer max pricing is not included: it is hierarchical (per
 * provider / per service) and stays enforced by the router plugin's
 * `allowsPeerForPolicy`, which every candidate still passes through.
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
 * `buyer.routingPreferences` as a policy: the top level of the chain for
 * automatic routing, so a gateway policy narrows under it like any other
 * level (it can tighten the trust minimum or the allow list, never loosen
 * them, and the buyer's block list always holds). Like without a gateway,
 * it does not judge pinned requests. The soft input-price limit is not a
 * policy field: it only ranks (see `rankingPreferences`).
 */
export function buyerPreferencePolicy(prefs: ModelRoutingPreferences): RoutingPolicy {
  const policy: RoutingPolicy = {}
  if (prefs.allowedPeerIds.length > 0) policy.allowedPeerIds = [...prefs.allowedPeerIds]
  if (prefs.blockedPeerIds.length > 0) policy.blockedPeerIds = [...prefs.blockedPeerIds]
  if (prefs.minTrustScore > 0) policy.minTrustScore = prefs.minTrustScore
  if (prefs.preferFreePeers) policy.preferFreePeers = true
  return policy
}

/**
 * The buyer's routing preferences reduced to ranking only, for requests that
 * carry a gateway policy: exclusions (trust minimum, allow and block lists)
 * were already applied from the merged policy, while preferFree and the soft
 * input-price penalty still order candidates. The merged policy's
 * `preferFreePeers` (a gateway level's, else the buyer's) decides free-first.
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
  /** Why `trustScore` is below the seller's own score (a ranking penalty), named in trust exclusions. */
  trustPenalty?: string | null
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

/** Up to 4 decimals; a sub-cent price keeps two significant digits so it never reads $0. */
function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`
  return `$${Math.round(value * 10_000) / 10_000}`
}

/** "trust 40", or "trust 40 (halved from 80: …)" when a penalty lowered it. */
function trustLabel(trust: number, penalty: string | null | undefined): string {
  return penalty ? `trust ${Math.round(trust)} (${penalty})` : `trust ${Math.round(trust)}`
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
    else if (facts.trustScore < policy.minTrustScore) reasons.push(`${trustLabel(facts.trustScore, facts.trustPenalty)} below ${policy.minTrustScore}`)
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
 * The policy as it applies to a routing service, which is paid per ranking
 * and returns no inference: without the token and image price caps, and
 * without `requireVerified` (verification proves which model a seller ran).
 * `requireTee` still applies, since a router reads the whole conversation.
 */
export function routingServicePolicy(policy: RoutingPolicy): RoutingPolicy {
  const {
    maxInputUsdPerMillion: _input,
    maxOutputUsdPerMillion: _output,
    maxCachedInputUsdPerMillion: _cached,
    maxImageUsdPerImage: _image,
    requireVerified: _verified,
    ...rest
  } = policy
  return rest
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
  trustPenalty: string | null = null,
): string[] {
  const reasons: string[] = []
  if (idIn(prefs.blockedPeerIds, peerId)) reasons.push('blocked by buyer config')
  else if (prefs.allowedPeerIds.length > 0 && !idIn(prefs.allowedPeerIds, peerId)) reasons.push('not in buyer allow list')
  if (prefs.minTrustScore > 0) {
    if (effectiveTrust === null) reasons.push(`trust unknown, buyer minimum ${prefs.minTrustScore}`)
    else if (effectiveTrust < prefs.minTrustScore) reasons.push(`${trustLabel(effectiveTrust, trustPenalty)} below buyer minimum ${prefs.minTrustScore}`)
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
