/**
 * Why automatic routing put a seller where it did, in numbers rather than
 * prose, so a console can explain it. Built by the buyer for every eligible
 * seller of a route preview, and for the seller that served a request (sent
 * to the gateway in `ROUTE_SELECTION_HEADER`).
 */
export type RouteSelection = {
  /** Expected cost of one successful answer in USD (price plus waiting, over the success rate); lower ranks first. */
  expectedCostUsd: number
  /** Price of one attempt at a typical request; null when the seller advertises no price. */
  expectedPriceUsd: number | null
  /** Expected seconds to a complete answer, a new payment channel's reserve included. */
  expectedSeconds: number
  /** Chance of a good answer, from the buyer's own record (0.8 before it has one). */
  successRate: number
  /** Recent requests behind the record, decayed with a 15-minute half-life. */
  observations: number
  /** `model`: this seller on this model; `other-models`: its other models at half weight; `none`: no record yet. */
  record: 'model' | 'other-models' | 'none'
  /** Measured on this model only. */
  firstTokenMs: number | null
  tokensPerSecond: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastFailureReason: string | null
  /** Success rate below 50%: tried after healthy sellers. */
  failing: boolean
  /** In a short cooldown after consecutive failures: tried last. */
  coolingDown: boolean
  /** Not seen in the last 10 minutes (or never): an exploration candidate. */
  stale: boolean
  /**
   * How the eligible sellers were put in order: `expected-cost` (the buyer's
   * adaptive order, which spreads traffic), `trust` (highest trust first, the
   * buyer's order without routing preferences), or the policy's `price` /
   * `latency` sort. Failing and cooling-down sellers go last in every order,
   * and a route chain's sellers go first.
   */
  ordering: 'expected-cost' | 'trust' | 'price' | 'latency'
  /** Among the sellers sharing this model's traffic (within 30% of the best). */
  sharesTraffic: boolean
  /** Its share of the shared traffic (0–1), when it shares it. */
  trafficShare: number | null
  /** How many sellers share the traffic. */
  poolSize: number
  /** `open`: the buyer already pays it; `new`: the first request would reserve a channel; `free`; null when unknown. */
  channel: 'open' | 'new' | 'free' | null
  /** This buyer's requests in flight with the seller, against what it advertises it can take. */
  inFlight: number
  maxConcurrency: number | null
  /** Position in an explicit route chain of the policy, when one orders it. */
  routeChainPosition: number | null
}

/** On a served request: how this seller came to serve it. */
export type ServedSelection = RouteSelection & {
  /** 1-based position among the eligible sellers, and how many there were. */
  rank: number
  of: number
  /**
   * `spread`: drawn from the sellers sharing traffic; `best`: the best on its own;
   * `conversation`: the seller this conversation stays on (prompt cache);
   * `exploration`: a probe of a seller with no recent data;
   * `failover`: the sellers before it failed this request;
   * `order`: next in the policy's or the buyer's order.
   */
  pick: 'spread' | 'best' | 'conversation' | 'exploration' | 'failover' | 'order'
  /** Sellers tried before it for this request. */
  attempt: number
}

/** Buyer → gateway, on the response of a model-routed request. */
export const ROUTE_SELECTION_HEADER = 'x-antseed-route-selection'

const PICKS = new Set<ServedSelection['pick']>(['spread', 'best', 'conversation', 'exploration', 'failover', 'order'])
const RECORDS = new Set<RouteSelection['record']>(['model', 'other-models', 'none'])
const CHANNELS = new Set(['open', 'new', 'free'])
const ORDERINGS = new Set<RouteSelection['ordering']>(['expected-cost', 'trust', 'price', 'latency'])
const MAX_HEADER_BYTES = 2048

export function encodeServedSelection(selection: ServedSelection): string {
  return Buffer.from(JSON.stringify(selection), 'utf8').toString('base64url')
}

/** The served selection from a header value, or null when it is absent or malformed. */
export function decodeServedSelection(value: string | string[] | undefined): ServedSelection | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || raw.length > MAX_HEADER_BYTES) return null
  try {
    return parseServedSelection(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null)

/** A route selection read back from JSON (the buyer's preview, or the request log), or null when malformed. */
export function parseRouteSelection(value: unknown): RouteSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const s = value as Record<string, unknown>
  const expectedCostUsd = num(s.expectedCostUsd)
  const expectedSeconds = num(s.expectedSeconds)
  const successRate = num(s.successRate)
  const observations = num(s.observations)
  const poolSize = count(s.poolSize)
  const inFlight = count(s.inFlight)
  if (expectedCostUsd === null || expectedSeconds === null || successRate === null || observations === null
    || poolSize === null || inFlight === null || !RECORDS.has(s.record as RouteSelection['record'])
    || !ORDERINGS.has(s.ordering as RouteSelection['ordering'])) return null
  const share = num(s.trafficShare)
  return {
    expectedCostUsd,
    expectedPriceUsd: num(s.expectedPriceUsd),
    expectedSeconds,
    successRate: Math.min(1, Math.max(0, successRate)),
    observations: Math.max(0, observations),
    record: s.record as RouteSelection['record'],
    firstTokenMs: num(s.firstTokenMs),
    tokensPerSecond: num(s.tokensPerSecond),
    lastSuccessAt: num(s.lastSuccessAt),
    lastFailureAt: num(s.lastFailureAt),
    lastFailureReason: typeof s.lastFailureReason === 'string' ? s.lastFailureReason.slice(0, 200) : null,
    failing: s.failing === true,
    coolingDown: s.coolingDown === true,
    stale: s.stale === true,
    ordering: s.ordering as RouteSelection['ordering'],
    sharesTraffic: s.sharesTraffic === true,
    trafficShare: share === null ? null : Math.min(1, Math.max(0, share)),
    poolSize,
    channel: CHANNELS.has(s.channel as string) ? (s.channel as RouteSelection['channel']) : null,
    inFlight,
    maxConcurrency: count(s.maxConcurrency),
    routeChainPosition: count(s.routeChainPosition),
  }
}

/** A served selection read back from JSON, or null when malformed. */
export function parseServedSelection(value: unknown): ServedSelection | null {
  const base = parseRouteSelection(value)
  if (!base) return null
  const s = value as Record<string, unknown>
  const rank = count(s.rank)
  const of = count(s.of)
  const attempt = count(s.attempt)
  if (rank === null || of === null || attempt === null || !PICKS.has(s.pick as ServedSelection['pick'])) return null
  return { ...base, rank, of, attempt, pick: s.pick as ServedSelection['pick'] }
}
