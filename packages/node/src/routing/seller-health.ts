/**
 * Adaptive seller selection for automatic routing.
 *
 * Each buyer learns, from its own traffic, how every seller serves every
 * model: how often requests succeed, how soon the answer starts and how fast
 * it streams. Observations fade with a half-life, so a seller that blipped
 * once barely moves and a seller that fixed itself recovers as soon as it
 * serves again — no timers. Trust stays a gate applied before this: every
 * seller the buyer has not used starts from the same prior, so with no
 * observations the order is plain price order.
 *
 * Sellers are ranked by expected cost of one successful answer: price plus the
 * value of the time it takes, divided by the chance it succeeds. Traffic is
 * spread across sellers that are close to the best instead of all going to
 * one, and a small share probes sellers the buyer has not heard from lately,
 * so failover always has fresh data and recovered sellers are noticed.
 *
 * Nothing here talks to anyone: it is local state plus public metadata.
 */

/** Observations lose half their weight every 15 minutes. */
export const SELLER_HEALTH_HALF_LIFE_MS = 15 * 60_000
/** Chance of success assumed for a seller the buyer has not used. */
export const SELLER_SUCCESS_PRIOR = 0.8
/** The prior counts as this many observations. */
export const SELLER_HEALTH_PRIOR_WEIGHT = 2
/** Value of one second of waiting, in USD. Makes a seller 15 s slower worth ~$0.003 more per request. */
export const DEFAULT_TIME_VALUE_USD_PER_SECOND = 0.0002
/** Sellers within this fraction of the best expected cost share the traffic. */
export const SELLER_SPREAD_TOLERANCE = 0.3
/** Share of requests that probe a seller the buyer has no recent data on. */
export const SELLER_EXPLORATION_RATE = 0.05
/** A seller not observed for this long is due for a probe. */
export const SELLER_STALE_AFTER_MS = 10 * 60_000
/**
 * Extra wait counted for a seller the buyer has no open payment channel with:
 * the first request has to reserve funds on-chain before it is served.
 */
export const NEW_RESERVE_SECONDS = 5
/** Below this chance of success a seller is tried only after every healthier one. */
export const UNHEALTHY_SUCCESS_PROBABILITY = 0.5

/** Weight of a seller's record on its other models, for a model with no data of its own. */
const SELLER_WIDE_WEIGHT = 0.5
const DEFAULT_FIRST_TOKEN_MS = 4_000
const DEFAULT_TOKENS_PER_SECOND = 50
const LATENCY_EMA_ALPHA = 0.3
const MIN_THROUGHPUT_TOKENS = 20
const MAX_ENTRIES = 2_048
/** Entries not observed for a day carry no weight worth keeping. */
const RETENTION_MS = 24 * 60 * 60_000

export type SellerHealthStats = {
  /** Time-decayed count of successful requests. */
  successes: number
  /** Time-decayed count of failed requests. */
  failures: number
  /** When `successes`/`failures` were last decayed. */
  decayedAt: number
  /** Typical time until the answer starts, in ms. */
  firstTokenMs: number | null
  /** Typical output speed once the answer streams. */
  tokensPerSecond: number | null
  lastSuccessAt: number
  lastFailureAt: number
  lastFailureReason: string | null
}

export type SellerSuccessTiming = {
  /** Time until the answer started. For a non-streamed answer, the whole request. */
  firstTokenMs: number
  /** Time from the first frame to the end, for a streamed answer. */
  streamMs?: number
  outputTokens?: number
  streamed: boolean
}

function emptyStats(now: number): SellerHealthStats {
  return {
    successes: 0,
    failures: 0,
    decayedAt: now,
    firstTokenMs: null,
    tokensPerSecond: null,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastFailureReason: null,
  }
}

function ema(previous: number | null, sample: number): number {
  return previous === null ? sample : previous * (1 - LATENCY_EMA_ALPHA) + sample * LATENCY_EMA_ALPHA
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function sellerHealthKey(peerId: string, serviceId: string | null | undefined): string {
  return `${peerId.trim().toLowerCase().replace(/^0x/, '')}|${(serviceId ?? '').trim().toLowerCase()}`
}

/** What one buyer has observed of every seller and model it used. */
export class SellerHealthBook {
  private readonly _entries = new Map<string, SellerHealthStats>()

  constructor(private readonly _halfLifeMs = SELLER_HEALTH_HALF_LIFE_MS) {}

  private _decayed(stats: SellerHealthStats, now: number): SellerHealthStats {
    const elapsed = now - stats.decayedAt
    if (elapsed <= 0) return stats
    const factor = 0.5 ** (elapsed / this._halfLifeMs)
    return { ...stats, successes: stats.successes * factor, failures: stats.failures * factor, decayedAt: now }
  }

  private _update(peerId: string, serviceId: string | null, now: number, apply: (stats: SellerHealthStats) => SellerHealthStats): void {
    const key = sellerHealthKey(peerId, serviceId)
    const current = this._entries.get(key)
    this._entries.delete(key)
    this._entries.set(key, apply(current ? this._decayed(current, now) : emptyStats(now)))
    if (this._entries.size > MAX_ENTRIES) {
      const oldest = this._entries.keys().next().value
      if (oldest !== undefined) this._entries.delete(oldest)
    }
  }

  recordSuccess(peerId: string, serviceId: string | null, now: number, timing?: SellerSuccessTiming): void {
    this._update(peerId, serviceId, now, (stats) => {
      const next = { ...stats, successes: stats.successes + 1, lastSuccessAt: now }
      if (!timing || !finiteNonNegative(timing.firstTokenMs)) return next
      const outputTokens = timing.outputTokens ?? 0
      if (timing.streamed) {
        next.firstTokenMs = ema(stats.firstTokenMs, timing.firstTokenMs)
        if (outputTokens >= MIN_THROUGHPUT_TOKENS && finiteNonNegative(timing.streamMs) && timing.streamMs > 0) {
          next.tokensPerSecond = ema(stats.tokensPerSecond, outputTokens / (timing.streamMs / 1000))
        }
      } else {
        // Only the whole duration is known: take out the generation time at
        // the speed seen so far to estimate when the answer would have started.
        const tokensPerSecond = stats.tokensPerSecond ?? DEFAULT_TOKENS_PER_SECOND
        next.firstTokenMs = ema(stats.firstTokenMs, Math.max(0, timing.firstTokenMs - (outputTokens / tokensPerSecond) * 1000))
      }
      return next
    })
  }

  /** `weight` lets a failure that can only be the seller's (a forged receipt) count for more than one. */
  recordFailure(peerId: string, serviceId: string | null, now: number, reason: string, weight = 1): void {
    this._update(peerId, serviceId, now, (stats) => ({
      ...stats,
      failures: stats.failures + Math.max(0, weight),
      lastFailureAt: now,
      lastFailureReason: reason,
    }))
  }

  /** A failure that applies to every model the seller serves (e.g. a forged receipt) when the model is unknown. */
  recordSellerFailure(peerId: string, now: number, reason: string, weight = 1): void {
    const prefix = sellerHealthKey(peerId, null)
    let matched = false
    for (const key of [...this._entries.keys()]) {
      if (!key.startsWith(prefix)) continue
      const [, serviceId] = key.split('|')
      this.recordFailure(peerId, serviceId ?? null, now, reason, weight)
      matched = true
    }
    if (!matched) this.recordFailure(peerId, null, now, reason, weight)
  }

  /**
   * Decayed view of one seller's model. For a model the buyer has not used
   * with this seller yet, what it saw on the seller's other models counts at
   * half weight: a seller rejecting every request on one model usually does
   * on the next. Speed is per model and is not carried over.
   */
  stats(peerId: string, serviceId: string | null, now: number): SellerHealthStats | null {
    const exact = this._entries.get(sellerHealthKey(peerId, serviceId))
    if (exact) return this._decayed(exact, now)
    const prefix = sellerHealthKey(peerId, null)
    let sellerWide: SellerHealthStats | null = null
    for (const [key, entry] of this._entries) {
      if (!key.startsWith(prefix)) continue
      const decayed = this._decayed(entry, now)
      sellerWide ??= { ...emptyStats(now) }
      sellerWide.successes += decayed.successes * SELLER_WIDE_WEIGHT
      sellerWide.failures += decayed.failures * SELLER_WIDE_WEIGHT
      if (decayed.lastSuccessAt > sellerWide.lastSuccessAt) sellerWide.lastSuccessAt = decayed.lastSuccessAt
      if (decayed.lastFailureAt > sellerWide.lastFailureAt) {
        sellerWide.lastFailureAt = decayed.lastFailureAt
        sellerWide.lastFailureReason = decayed.lastFailureReason
      }
    }
    return sellerWide
  }

  entries(now: number): Array<{ peerId: string; serviceId: string | null; stats: SellerHealthStats }> {
    return [...this._entries.entries()].map(([key, stats]) => {
      const [peerId, serviceId] = key.split('|')
      return { peerId: peerId!, serviceId: serviceId || null, stats: this._decayed(stats, now) }
    })
  }

  /** Forget a seller entirely, e.g. when an operator asks to give it another chance. */
  forget(peerId: string): void {
    const prefix = sellerHealthKey(peerId, null)
    for (const key of [...this._entries.keys()]) if (key.startsWith(prefix)) this._entries.delete(key)
  }

  serialize(now: number): Array<[string, SellerHealthStats]> {
    return [...this._entries.entries()]
      .filter(([, stats]) => now - Math.max(stats.lastSuccessAt, stats.lastFailureAt) < RETENTION_MS)
      .map(([key, stats]) => [key, this._decayed(stats, now)])
  }

  /** Restore persisted entries, dropping anything malformed or from the future. */
  static parse(raw: unknown, now: number, halfLifeMs = SELLER_HEALTH_HALF_LIFE_MS): SellerHealthBook {
    const book = new SellerHealthBook(halfLifeMs)
    if (!Array.isArray(raw)) return book
    for (const item of raw.slice(-MAX_ENTRIES)) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[0].includes('|')) continue
      const value = item[1] as Partial<SellerHealthStats> | null
      if (!value || typeof value !== 'object') continue
      const decayedAt = finiteNonNegative(value.decayedAt) ? Math.min(value.decayedAt, now) : now
      const lastSuccessAt = finiteNonNegative(value.lastSuccessAt) ? Math.min(value.lastSuccessAt, now) : 0
      const lastFailureAt = finiteNonNegative(value.lastFailureAt) ? Math.min(value.lastFailureAt, now) : 0
      if (now - Math.max(lastSuccessAt, lastFailureAt) >= RETENTION_MS) continue
      book._entries.set(item[0], {
        successes: finiteNonNegative(value.successes) ? Math.min(value.successes, 1e6) : 0,
        failures: finiteNonNegative(value.failures) ? Math.min(value.failures, 1e6) : 0,
        decayedAt,
        firstTokenMs: finiteNonNegative(value.firstTokenMs) ? value.firstTokenMs : null,
        tokensPerSecond: finiteNonNegative(value.tokensPerSecond) && value.tokensPerSecond > 0 ? value.tokensPerSecond : null,
        lastSuccessAt,
        lastFailureAt,
        lastFailureReason: typeof value.lastFailureReason === 'string' ? value.lastFailureReason.slice(0, 200) : null,
      })
    }
    return book
  }
}

export function successProbability(stats: SellerHealthStats | null, prior = SELLER_SUCCESS_PRIOR): number {
  const successes = stats?.successes ?? 0
  const failures = stats?.failures ?? 0
  return (successes + SELLER_HEALTH_PRIOR_WEIGHT * prior) / (successes + failures + SELLER_HEALTH_PRIOR_WEIGHT)
}

/** Size of the request being routed, for weighing price against time. */
export type RouteRequestShape = { inputTokens: number; outputTokens: number }

export type AdaptiveRouteInput = {
  peerId: string
  serviceId: string | null
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  /** A flat price per request (e.g. per image) that replaces token pricing. */
  requestUsd?: number | null
  coolingDown: boolean
  /**
   * The buyer already has an open payment channel with this seller, or the
   * seller is free. Unknown (undefined) disables the reserve-aware rules.
   */
  channelOpen?: boolean
  /**
   * This buyer already has as many requests in flight with the seller as it
   * advertises it can take: another one would queue. Tried after sellers
   * with room, never drawn for spreading.
   */
  saturated?: boolean
}

export type AdaptiveRouteScore = {
  successProbability: number
  expectedSeconds: number
  /** Price of one attempt at this request, in USD; null when the seller advertises no price. */
  expectedPriceUsd: number | null
  /** Expected cost of one successful answer, price and time together, in USD. Lower is better. */
  score: number
  unhealthy: boolean
  /** Not observed within `SELLER_STALE_AFTER_MS`, or never. */
  stale: boolean
  stats: SellerHealthStats | null
}

export type NetworkSpeed = { firstTokenMs: number; tokensPerSecond: number }

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Typical speed among sellers the buyer has measured, used for sellers it has not. */
export function networkSpeed(stats: Array<SellerHealthStats | null>): NetworkSpeed {
  return {
    firstTokenMs: median(stats.flatMap((entry) => entry?.firstTokenMs != null ? [entry.firstTokenMs] : [])) ?? DEFAULT_FIRST_TOKEN_MS,
    tokensPerSecond: median(stats.flatMap((entry) => entry?.tokensPerSecond != null ? [entry.tokensPerSecond] : [])) ?? DEFAULT_TOKENS_PER_SECOND,
  }
}

export function scoreAdaptiveRoute(
  input: AdaptiveRouteInput,
  stats: SellerHealthStats | null,
  shape: RouteRequestShape,
  network: NetworkSpeed,
  now: number,
  timeValueUsdPerSecond = DEFAULT_TIME_VALUE_USD_PER_SECOND,
): AdaptiveRouteScore {
  const probability = successProbability(stats)
  const firstTokenMs = stats?.firstTokenMs ?? network.firstTokenMs
  const tokensPerSecond = stats?.tokensPerSecond ?? network.tokensPerSecond
  const expectedSeconds = firstTokenMs / 1000 + shape.outputTokens / Math.max(1, tokensPerSecond)
    + (input.channelOpen === false ? NEW_RESERVE_SECONDS : 0)
  const expectedPriceUsd = finiteNonNegative(input.requestUsd)
    ? input.requestUsd
    : input.inputUsdPerMillion !== null && input.outputUsdPerMillion !== null
      ? (shape.inputTokens * input.inputUsdPerMillion + shape.outputTokens * input.outputUsdPerMillion) / 1_000_000
      : null
  // Sellers with no advertised price rank after priced ones (see the ordering);
  // among themselves, count them at a dollar per million tokens.
  const pricePart = expectedPriceUsd ?? (shape.inputTokens + shape.outputTokens) / 1_000_000
  const lastObservedAt = Math.max(stats?.lastSuccessAt ?? 0, stats?.lastFailureAt ?? 0)
  return {
    successProbability: probability,
    expectedSeconds,
    expectedPriceUsd,
    score: (pricePart + timeValueUsdPerSecond * expectedSeconds) / Math.max(probability, 0.01),
    unhealthy: probability < UNHEALTHY_SUCCESS_PROBABILITY,
    stale: now - lastObservedAt >= SELLER_STALE_AFTER_MS,
    stats,
  }
}

export type AdaptiveOrderOptions = {
  now: number
  /**
   * Stable key of the conversation this request belongs to. The same key
   * picks the same seller from the shared pool every time, so a seller keeps
   * the conversation's prompt cache; different conversations still spread.
   */
  affinityKey?: string | null
  /** Uniform [0, 1). Injected so tests are deterministic. */
  random?: () => number
  timeValueUsdPerSecond?: number
  spreadTolerance?: number
  explorationRate?: number
}

export type AdaptiveOrder<T> = {
  ordered: T[]
  scores: Map<T, AdaptiveRouteScore>
  /** Sellers sharing traffic for this request (the first one was drawn from them). */
  pool: T[]
  /** Set when this request probes a seller with no recent data. */
  explored: T | null
}

/**
 * Order candidates for one request. Ready, healthy sellers come first: one is
 * drawn from those within `spreadTolerance` of the best expected cost,
 * weighted toward the cheapest; the rest follow by expected cost. Unhealthy
 * sellers follow, then sellers cooling down. With `explorationRate`, a seller
 * the buyer has no recent data on goes first instead, with the usual order
 * behind it as the fallback.
 */
export function orderAdaptiveRoutes<T>(
  candidates: T[],
  input: (candidate: T) => AdaptiveRouteInput,
  book: SellerHealthBook,
  shape: RouteRequestShape,
  options: AdaptiveOrderOptions,
): AdaptiveOrder<T> {
  const { now } = options
  const random = options.random ?? Math.random
  const tolerance = options.spreadTolerance ?? SELLER_SPREAD_TOLERANCE
  const explorationRate = options.explorationRate ?? SELLER_EXPLORATION_RATE
  const inputs = new Map(candidates.map((candidate) => [candidate, input(candidate)]))
  const stats = new Map(candidates.map((candidate) => {
    const { peerId, serviceId } = inputs.get(candidate)!
    return [candidate, book.stats(peerId, serviceId, now)]
  }))
  const network = networkSpeed([...stats.values()])
  const scores = new Map(candidates.map((candidate) => [
    candidate,
    scoreAdaptiveRoute(inputs.get(candidate)!, stats.get(candidate)!, shape, network, now, options.timeValueUsdPerSecond),
  ]))

  // Priced sellers first, then by expected cost; ties keep the incoming order.
  const position = new Map(candidates.map((candidate, index) => [candidate, index]))
  const byScore = (a: T, b: T): number => Number(scores.get(a)!.expectedPriceUsd === null) - Number(scores.get(b)!.expectedPriceUsd === null)
    || scores.get(a)!.score - scores.get(b)!.score
    || position.get(a)! - position.get(b)!
  const cooling = candidates.filter((candidate) => inputs.get(candidate)!.coolingDown).sort(byScore)
  const ready = candidates.filter((candidate) => !inputs.get(candidate)!.coolingDown)
  const saturated = (candidate: T): boolean => inputs.get(candidate)!.saturated === true
  const healthy = ready.filter((candidate) => !scores.get(candidate)!.unhealthy)
    .sort((a, b) => Number(saturated(a)) - Number(saturated(b)) || byScore(a, b))
  const unhealthy = ready.filter((candidate) => scores.get(candidate)!.unhealthy).sort(byScore)

  const leader = healthy[0]
  const best = leader ? scores.get(leader)!.score : null
  const leaderPriced = leader ? scores.get(leader)!.expectedPriceUsd !== null : false
  let pool = best === null ? [] : healthy.filter((candidate) => scores.get(candidate)!.score <= best * (1 + tolerance)
    && (scores.get(candidate)!.expectedPriceUsd !== null) === leaderPriced
    && saturated(candidate) === saturated(leader!))
  // Spreading must not open payment channels for its own sake: share traffic
  // among sellers the buyer already pays, and only reserve on a new seller
  // when it is the best choice outright (or failover needs it).
  const channelOpen = (candidate: T): boolean | undefined => inputs.get(candidate)!.channelOpen
  if (pool.some((candidate) => channelOpen(candidate) === false)) {
    const open = pool.filter((candidate) => channelOpen(candidate) !== false)
    pool = open.length > 0 ? open : pool.slice(0, 1)
  }
  let ordered = [...healthy, ...unhealthy, ...cooling]
  if (pool.length > 0) {
    // Weight 1/score²: twice as expensive gets a quarter of the traffic. The
    // pool may no longer hold the leader (it needed a new channel), so even a
    // single remaining seller goes first.
    const weights = pool.map((candidate) => 1 / Math.max(scores.get(candidate)!.score, 1e-9) ** 2)
    const picked = pool.length === 1
      ? pool[0]!
      : options.affinityKey
        ? rendezvousPick(pool, weights, (candidate) => inputs.get(candidate)!.peerId, options.affinityKey)
        : weightedPick(pool, weights, random())
    ordered = [picked, ...ordered.filter((candidate) => candidate !== picked)]
  }

  let explored: T | null = null
  // Probes are separate requests, never a turn of an ongoing conversation
  // (that would move it off its cached seller), never open a channel, and
  // never go to a seller already at its concurrency limit.
  if (pool.length > 0 && !options.affinityKey && explorationRate > 0 && random() < explorationRate) {
    explored = ready.filter((candidate) => !pool.includes(candidate) && scores.get(candidate)!.stale
      && channelOpen(candidate) !== false && !saturated(candidate)).sort(byScore)[0] ?? null
    if (explored) ordered = [explored, ...ordered.filter((candidate) => candidate !== explored)]
  }
  return { ordered, scores, pool, explored }
}

function weightedPick<T>(pool: T[], weights: number[], draw: number): T {
  let remaining = draw * weights.reduce((sum, weight) => sum + weight, 0)
  for (const [index, weight] of weights.entries()) {
    remaining -= weight
    if (remaining < 0) return pool[index]!
  }
  return pool[pool.length - 1]!
}

/** FNV-1a over the key and seller, mapped to (0, 1]. */
function stableUnit(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash + 1) / 0x1_0000_0001
}

/**
 * Weighted rendezvous hashing: each conversation maps to one seller, with
 * sellers' shares proportional to their weights. When the pool changes, only
 * the conversations of a seller that left (or the share a newcomer takes)
 * move; everyone else stays where their cache is.
 */
function rendezvousPick<T>(pool: T[], weights: number[], peerId: (candidate: T) => string, key: string): T {
  let best: T = pool[0]!
  let bestScore = Number.NEGATIVE_INFINITY
  for (const [index, candidate] of pool.entries()) {
    const score = Math.log(stableUnit(`${key}|${peerId(candidate)}`)) / weights[index]!
    if (score > bestScore) { bestScore = score; best = candidate }
  }
  return best
}

/**
 * How long to wait for a seller to start answering before trying the next
 * one: four times what it usually takes, never under 30 s or over 2 min.
 * Null when the buyer has too little data on the seller to judge.
 */
export function adaptiveFirstTokenTimeoutMs(stats: SellerHealthStats | null, expectedOutputTokens: number, streamed: boolean): number | null {
  if (!stats || stats.firstTokenMs === null || stats.successes < 2) return null
  const generationMs = streamed ? 0 : (expectedOutputTokens / (stats.tokensPerSecond ?? DEFAULT_TOKENS_PER_SECOND)) * 1000
  return Math.round(Math.min(120_000, Math.max(30_000, 4 * (stats.firstTokenMs + generationMs))))
}
