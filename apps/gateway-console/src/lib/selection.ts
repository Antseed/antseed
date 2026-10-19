/**
 * Plain-language explanations of automatic routing: how the buyer orders a
 * model's sellers, what it has seen of each, and why a request went where it
 * did. Built from the numbers the buyer reports (`RouteSelection`).
 */
import type { RoutePreview, RouteSelection, RoutingSort, ServedSelection } from '../api/types'
import { formatLatency, formatRelative, formatSpeed, formatUsd } from './format'

/** How the sellers are ordered, in one sentence. */
export function orderingSummary(ordering: RouteSelection['ordering'], poolSize: number): string {
  switch (ordering) {
    case 'expected-cost':
      return poolSize > 1
        ? `Ranked by the expected cost of a good answer: price plus waiting time, divided by the success rate this gateway has seen. The ${poolSize} sellers within 30% of the best share the traffic, cheaper and more reliable ones more often.`
        : 'Ranked by the expected cost of a good answer: price plus waiting time, divided by the success rate this gateway has seen. The best seller takes the traffic; no other is close enough to share it.'
    case 'trust':
      return 'Ranked by trust score, highest first. Sellers failing lately go after the healthy ones, and cooling-down sellers last.'
    case 'price':
      return 'Your routing policy sorts by price: cheapest first. Failing and cooling-down sellers still go last.'
    case 'latency':
      return 'Your routing policy sorts by speed: fastest first token first. Failing and cooling-down sellers still go last.'
  }
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function requests(count: number): string {
  const rounded = count >= 10 ? Math.round(count) : Math.round(count * 10) / 10
  return `${rounded} recent request${rounded === 1 ? '' : 's'}`
}

/** What the buyer's record says of the seller: success rate and how much it is based on. */
export function recordSummary(selection: RouteSelection): string {
  if (selection.record === 'none') return 'No requests yet: assumed 80% success until it has answered some.'
  const base = `${percent(selection.successRate)} success over ${requests(selection.observations)}`
  return selection.record === 'other-models' ? `${base} on its other models (counted at half weight)` : base
}

/** The state that moves a seller back in the order, or null when it is healthy. */
export function healthWarning(selection: RouteSelection, now = Date.now()): string | null {
  const reason = selection.lastFailureReason ? `: ${selection.lastFailureReason}` : ''
  const when = selection.lastFailureAt ? `, ${formatRelative(selection.lastFailureAt, now)}` : ''
  if (selection.coolingDown) return `Cooling down after failures in a row${reason}${when}. Tried last.`
  if (selection.failing) return `Failing lately${reason}${when}. Tried after the healthy sellers.`
  return null
}

/** Short facts about a seller, in the order they matter to routing. */
export function selectionFacts(selection: RouteSelection): string[] {
  const facts: string[] = []
  if (selection.ordering === 'expected-cost') facts.push(`${formatUsd(selection.expectedCostUsd)} expected per good answer`)
  facts.push(recordSummary(selection))
  if (selection.firstTokenMs !== null) facts.push(`${formatLatency(selection.firstTokenMs)} first token`)
  if (selection.tokensPerSecond !== null) facts.push(formatSpeed(selection.tokensPerSecond))
  if (selection.sharesTraffic && selection.trafficShare !== null) facts.push(`takes ~${percent(selection.trafficShare)} of the traffic`)
  if (selection.channel === 'open') facts.push('payment channel open')
  else if (selection.channel === 'new') facts.push('first request opens a payment channel (~5 s)')
  if (selection.maxConcurrency !== null && selection.inFlight >= selection.maxConcurrency) {
    facts.push(`at capacity (${selection.inFlight}/${selection.maxConcurrency} in flight): tried after sellers with room`)
  } else if (selection.inFlight > 0) {
    facts.push(`${selection.inFlight}${selection.maxConcurrency !== null ? `/${selection.maxConcurrency}` : ''} in flight`)
  }
  return facts
}

/** The few numbers that set a seller's place, for one compact line: success, speed, traffic share, expected cost. */
export function selectionHeadline(selection: RouteSelection): string {
  const parts: string[] = []
  parts.push(selection.record === 'none'
    ? 'no requests yet'
    : `${percent(selection.successRate)} success (${Math.round(selection.observations)} recent${selection.record === 'other-models' ? ', other models' : ''})`)
  if (selection.firstTokenMs !== null) parts.push(`${formatLatency(selection.firstTokenMs)} first token`)
  if (selection.tokensPerSecond !== null) parts.push(formatSpeed(selection.tokensPerSecond))
  if (selection.sharesTraffic && selection.trafficShare !== null) parts.push(`${percent(selection.trafficShare)} of traffic`)
  if (selection.ordering === 'expected-cost') parts.push(`${formatUsd(selection.expectedCostUsd)} per answer`)
  return parts.join(' · ')
}

/** How a served request's seller came to serve it, in one sentence. */
export function pickSummary(served: ServedSelection): string {
  const place = `#${served.rank} of ${served.of} eligible seller${served.of === 1 ? '' : 's'}`
  switch (served.pick) {
    case 'spread':
      return `Drawn from the ${served.poolSize} sellers sharing this model's traffic (${place}).`
    case 'best':
      return `The best seller for this model on its own (${place}).`
    case 'conversation':
      return `The seller this conversation stays on, so its prompt cache keeps working (${place}).`
    case 'exploration':
      return `A probe: one request in twenty tries a seller with no recent record, so routing keeps learning (${place}).`
    case 'failover':
      return `${served.attempt === 1 ? 'The seller before it' : `The ${served.attempt} sellers before it`} failed this request, so it went to the next one (${place}).`
    case 'order':
      if (served.attempt > 0) return `${served.attempt === 1 ? 'The seller before it' : `The ${served.attempt} sellers before it`} could not take this request (${place}).`
      return served.routeChainPosition !== null
        ? `Seller #${served.routeChainPosition} in your routing policy's route for this model (${place}).`
        : served.ordering === 'trust'
          ? `The most trusted healthy seller (${place}).`
          : `First in the order your routing policy sets (${place}).`
  }
}

type Candidate = RoutePreview['candidates'][number]

/** The sort a preview's routing applies: the policy's own, else what the buyer reports. */
export function previewSort(preview: RoutePreview): RoutingSort {
  if (preview.policy.sort) return preview.policy.sort
  const ordering = preview.candidates.find((candidate) => candidate.selection)?.selection?.ordering
  return ordering === 'trust' || ordering === 'price' || ordering === 'latency' ? ordering : 'balanced'
}

const byPrice = (candidate: Candidate) => (candidate.inputUsdPerMillion ?? Infinity) + (candidate.outputUsdPerMillion ?? Infinity)
const byTrust = (candidate: Candidate) => -(candidate.trustScore ?? -1)

/**
 * A preview's sellers split the way routing sees them: the ones in range, in
 * the order they are tried, and the ones it never selects, ordered by the same
 * sort (`latency` sellers come from `latencyOf`, unknown last).
 */
export function rankCandidates(preview: RoutePreview, latencyOf: (peerId: string) => number | null = () => null): { inRange: Candidate[]; never: Candidate[] } {
  const inRange = preview.candidates.filter((candidate) => candidate.eligible).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
  const sort = previewSort(preview)
  const key = sort === 'trust' ? byTrust
    : sort === 'latency' ? (candidate: Candidate) => latencyOf(candidate.peerId) ?? Infinity
    : byPrice
  const never = preview.candidates.filter((candidate) => !candidate.eligible)
    .sort((a, b) => key(a) - key(b) || byTrust(a) - byTrust(b))
  return { inRange, never }
}

/** Why routing never selects a seller, as one phrase. */
export function neverReason(candidate: Candidate, modelAllowed = true): string {
  if (!modelAllowed) return 'your routing policy does not allow this model'
  return candidate.reasons.join(' · ') || 'outside your routing settings'
}

/**
 * Whether a preview names the model's sellers. A model the policy refuses
 * comes back with no candidates, so the catalog's own offer list is shown instead.
 */
export function previewListsSellers(preview: RoutePreview | undefined): boolean {
  return !!preview && preview.candidates.length > 0
}
