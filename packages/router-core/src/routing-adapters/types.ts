import type {
  PeerInfo,
  RouteCandidate,
  RouteRecommendation,
  RouterModelEntry,
  RouterOptions,
  RouterPricing,
  RoutingModelsContext,
  RoutingProtocol,
  RouteSelectionContext,
  SerializedHttpRequest,
} from '@antseed/node'

/**
 * One setting a router accepts with each ranking, described so a host (CLI, desktop) can
 * validate it and render a control for it without knowing the routing protocol.
 */
export type RouterOptionSpec = {
  key: string
  label: string
  description?: string
} & (
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number; default?: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'string'; values?: readonly string[]; default?: string }
)

/** A candidate the buyer allows, with the prompt-cache reuse it observed for it. */
export type RankCandidate = RouteCandidate & { expectedCachedInputTokens: number }

/**
 * Buyer side of one routing protocol. The protocol-neutral `ModelRoutingClient` picks the
 * adapter by the protocol the router advertises; adding a routing API means adding an adapter
 * here, its wire binding in `@antseed/protocol/routing`, and a provider plugin for sellers.
 */
export interface RoutingClientAdapter {
  readonly protocol: RoutingProtocol
  /** Settings this protocol accepts with each ranking. Unknown keys are rejected. */
  readonly options: readonly RouterOptionSpec[]
  /** The models the router can rank: a free control-plane request. */
  listModels(router: PeerInfo, context: RoutingModelsContext): Promise<RouterModelEntry[]>
  /**
   * The paid ranking. Returns allowed candidates in the router's order, each at most once;
   * a router can never name a destination the buyer did not send.
   */
  rank(args: {
    request: SerializedHttpRequest
    /** `request.body`, decoded. */
    body: Record<string, unknown>
    router: PeerInfo
    candidates: readonly RankCandidate[]
    options: RouterOptions
    context: RouteSelectionContext
  }): Promise<RouteRecommendation[]>
}

/** The router says none of the candidates can be ranked; the host may refresh the model list and retry once. */
export class RouterCannotRankError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouterCannotRankError'
  }
}

/** Router settings that the router's protocol does not accept; nothing was paid. */
export class InvalidRouterOptionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRouterOptionsError'
  }
}

/** Check `options` against a protocol's option specs; throws `InvalidRouterOptionsError`. */
export function validateRouterOptions(specs: readonly RouterOptionSpec[], options: RouterOptions | undefined): RouterOptions {
  if (options === undefined) return {}
  const byKey = new Map(specs.map(spec => [spec.key, spec]))
  const unknown = Object.keys(options).filter(key => !byKey.has(key))
  if (unknown.length) {
    const supported = specs.map(spec => spec.key).join(', ') || 'none'
    throw new InvalidRouterOptionsError(`Unknown router option(s): ${unknown.join(', ')}. Supported: ${supported}.`)
  }
  for (const [key, value] of Object.entries(options)) {
    const spec = byKey.get(key)!
    const fail = (expected: string): never => { throw new InvalidRouterOptionsError(`Router option ${key} must be ${expected}.`) }
    if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') fail('true or false')
    } else if (spec.type === 'string') {
      if (typeof value !== 'string' || (spec.values && !spec.values.includes(value))) fail(spec.values ? `one of ${spec.values.join(', ')}` : 'a string')
    } else {
      const range = spec.minimum !== undefined && spec.maximum !== undefined ? ` from ${spec.minimum} to ${spec.maximum}` : ''
      if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value))
        || (spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum)) {
        fail(`${spec.type === 'integer' ? 'an integer' : 'a number'}${range}`)
      }
    }
  }
  return { ...options }
}

/** Candidate pricing for a router; sellers without a cached-input price bill cache reads at the input price. */
export function candidatePricing(candidate: Pick<RouteCandidate, 'inputUsdPerMillion' | 'outputUsdPerMillion' | 'cachedInputUsdPerMillion'>): RouterPricing {
  return {
    inputUsdPerMillion: candidate.inputUsdPerMillion,
    cachedInputUsdPerMillion: candidate.cachedInputUsdPerMillion ?? candidate.inputUsdPerMillion,
    outputUsdPerMillion: candidate.outputUsdPerMillion,
  }
}
