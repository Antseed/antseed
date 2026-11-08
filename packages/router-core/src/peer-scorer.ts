import { normalizedModelReputationScore, type PeerInfo } from '@antseed/node'

export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
}

export interface ScoringWeights {
  price: number
  latency: number
  capacity: number
  reputation: number
  freshness: number
  reliability: number
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  price: 0.30,
  latency: 0.25,
  capacity: 0.20,
  reputation: 0.10,
  freshness: 0.10,
  reliability: 0.05,
}

export interface PeerMetrics {
  latencyEma: number | undefined
  failureStreak: number
  totalFailures: number
  totalAttempts: number
  cooldownUntil: number | undefined
}

export interface ScoredCandidate {
  peer: PeerInfo
  provider: string
  providerRank: number
  offer: TokenPricingUsdPerMillion
  score: number
}

interface CandidateInput {
  peer: PeerInfo
  provider: string
  providerRank: number
  offer: TokenPricingUsdPerMillion
  metrics: PeerMetrics
}

interface ScoringContext {
  now: number
  medianLatency: number
  maxPeerStalenessMs: number
  maxFailures: number
  weights?: Partial<ScoringWeights>
}

function normalizedInverted(value: number, min: number, range: number): number {
  if (range <= 0) {
    return 1
  }
  return 1 - (value - min) / range
}

function effectiveReputation(p: PeerInfo): number {
  return normalizedModelReputationScore(p) ?? 0
}

function availableCapacity(p: PeerInfo): number {
  const max = p.maxConcurrency ?? 1
  const current = p.currentLoad ?? 0
  return Math.max(0, max - current)
}

function freshnessFactor(p: PeerInfo, now: number, maxPeerStalenessMs: number): number {
  if (!Number.isFinite(p.lastSeen)) return 0.5
  const age = Math.max(0, now - p.lastSeen)
  if (age >= maxPeerStalenessMs) return 0
  return 1 - (age / maxPeerStalenessMs)
}

function reliabilityFactor(metrics: PeerMetrics, maxFailures: number): number {
  const historicalPenalty = metrics.totalAttempts > 0 ? metrics.totalFailures / metrics.totalAttempts : 0
  const streakPenalty = Math.min(1, metrics.failureStreak / maxFailures)
  return Math.max(0, 1 - Math.max(historicalPenalty, streakPenalty))
}

function peerLatency(metrics: PeerMetrics, medianLatency: number): number {
  return metrics.latencyEma ?? medianLatency
}

function tieBreak(a: PeerInfo, aLatencyEma: number | undefined, b: PeerInfo, bLatencyEma: number | undefined): number {
  const latA = aLatencyEma ?? Number.POSITIVE_INFINITY
  const latB = bLatencyEma ?? Number.POSITIVE_INFINITY
  if (latA !== latB) {
    return latA - latB
  }
  return a.peerId.localeCompare(b.peerId)
}

/**
 * Score and rank candidates using the composite scoring algorithm.
 *
 * Calculates normalization context (min/max price, latency, capacity),
 * scores each candidate with weighted factors, and returns candidates
 * sorted by score (highest first).
 */
export function scoreCandidates(
  candidates: CandidateInput[],
  context: ScoringContext,
): ScoredCandidate[] {
  if (candidates.length === 0) return []

  const w: ScoringWeights = { ...DEFAULT_WEIGHTS, ...context.weights }

  // --- Normalization context ---
  const knownPrices = candidates
    .map((c) => c.offer.inputUsdPerMillion)
    .filter((value) => Number.isFinite(value))
  const fallbackPrice = knownPrices.length > 0 ? Math.max(...knownPrices) * 1.25 : 1
  let minPrice = knownPrices.length > 0 ? Math.min(...knownPrices) : fallbackPrice
  let maxPrice = knownPrices.length > 0 ? Math.max(...knownPrices) : fallbackPrice
  let minLatency = Number.POSITIVE_INFINITY
  let maxLatency = 0
  let maxCap = 0

  for (const c of candidates) {
    const price = c.offer.inputUsdPerMillion
    if (price < minPrice) minPrice = price
    if (price > maxPrice) maxPrice = price

    const lat = peerLatency(c.metrics, context.medianLatency)
    if (lat < minLatency) minLatency = lat
    if (lat > maxLatency) maxLatency = lat

    const cap = availableCapacity(c.peer)
    if (cap > maxCap) maxCap = cap
  }

  const priceRange = maxPrice - minPrice
  const latencyRange = maxLatency - minLatency

  // --- Score each candidate ---
  const scored: ScoredCandidate[] = []

  for (const c of candidates) {
    // Price factor (lower is better, inverted)
    const price = c.offer.inputUsdPerMillion ?? fallbackPrice
    const priceFactor = normalizedInverted(price, minPrice, priceRange)

    // Latency factor (lower is better, inverted)
    const lat = peerLatency(c.metrics, context.medianLatency)
    const latencyFactor = normalizedInverted(lat, minLatency, latencyRange)

    // Capacity factor (higher is better)
    const capFactor = maxCap > 0
      ? availableCapacity(c.peer) / maxCap
      : 1

    // Reputation factor (higher is better, normalized 0-100 to 0-1)
    const repFactor = effectiveReputation(c.peer) / 100
    const fresh = freshnessFactor(c.peer, context.now, context.maxPeerStalenessMs)
    const reliability = reliabilityFactor(c.metrics, context.maxFailures)

    const score =
      w.price * priceFactor +
      w.latency * latencyFactor +
      w.capacity * capFactor +
      w.reputation * repFactor +
      w.freshness * fresh +
      w.reliability * reliability

    scored.push({
      peer: c.peer,
      provider: c.provider,
      providerRank: c.providerRank,
      offer: c.offer,
      score,
    })
  }

  const latencies = latencyByPeer(candidates)

  // Sort by score descending, tie-break by latency then peerId
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) < 1e-9) {
      return tieBreak(a.peer, latencies.get(a.peer.peerId), b.peer, latencies.get(b.peer.peerId))
    }
    return b.score - a.score
  })

  return rotateEqualScoreHead(scored, latencies)
}

function latencyByPeer(candidates: CandidateInput[]): Map<string, number | undefined> {
  const latencies = new Map<string, number | undefined>()
  for (const candidate of candidates) {
    const peerId = candidate.peer.peerId
    if (!latencies.has(peerId)) latencies.set(peerId, candidate.metrics.latencyEma)
  }
  return latencies
}

function storedLatency(latencies: Map<string, number | undefined>, peerId: string): number {
  return latencies.get(peerId) ?? Number.POSITIVE_INFINITY
}

// One counter per tied seller set. A single counter phase-locks when two
// pools are scored one after the other.
const MAX_SCORE_POOLS = 4096
const equalScoreRotation = new Map<string, number>()

function rememberScoreRotation(key: string, step: number): void {
  if (equalScoreRotation.has(key)) equalScoreRotation.delete(key)
  equalScoreRotation.set(key, step)
  while (equalScoreRotation.size > MAX_SCORE_POOLS) {
    const oldest = equalScoreRotation.keys().next().value
    if (oldest === undefined) break
    equalScoreRotation.delete(oldest)
  }
}

function rotateEqualScoreHead(
  scored: ScoredCandidate[],
  latencies: Map<string, number | undefined>,
): ScoredCandidate[] {
  if (scored.length < 2) return scored
  const best = scored[0]
  if (!best) return scored
  const bestLatency = storedLatency(latencies, best.peer.peerId)
  let group = 1
  while (group < scored.length) {
    const next = scored[group]
    if (!next || Math.abs(next.score - best.score) >= 1e-9) break
    if (storedLatency(latencies, next.peer.peerId) !== bestLatency) break
    group += 1
  }
  if (group < 2) return scored
  const ids: string[] = []
  for (let index = 0; index < group; index += 1) {
    const peerId = scored[index]?.peer.peerId
    if (peerId) ids.push(peerId)
  }
  ids.sort()
  const step = ((equalScoreRotation.get(ids.join('\n')) ?? 0) + 1) >>> 0
  rememberScoreRotation(ids.join('\n'), step)
  const offset = step % group
  if (offset === 0) return scored
  const head = scored.slice(0, group)
  for (let index = 0; index < group; index += 1) {
    const next = head[(index + offset) % group]
    if (next) scored[index] = next
  }
  return scored
}
