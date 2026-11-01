import { QueryClient } from '@tanstack/query-core'
import { buildNetworkServiceOffers, effectiveModelReputationScore, hasLiveDiffVerdict, isModelRouteEligible, normalizedModelReputationScore, type AntseedNode, type RouterModelEntry, type ModelRoutingPreferences, type PeerInfo, type RouteCandidate, type RouteRecommendation, type SerializedHttpRequest } from '@antseed/node'
import { detectRequestServiceApiProtocol } from './service-api-adapter.js'
import { findMissingRouteParameters, getExplicitProviderOverride, resolvePeerRoutePlan } from './routing.js'
import { overrideRoutedModelInBody } from './request-utils.js'
import type { RoutingSelection, RoutingServiceTarget } from '@antseed/node'
import { candidatePricing, InvalidRouterOptionsError, RouterCannotRankError, routerModelResolver, routingClientAdapter, routingProtocolOfTarget, validateRouterOptions, type ModelRoutingClientApi } from '@antseed/router-core'

const MODELS_TIMEOUT_MS = 5_000

/**
 * Router model catalogs (free, per routing protocol) in a TanStack Query Core cache: reused for
 * `ttlMs`, shared by concurrent callers so a burst of requests sends one models request, and
 * removed when a routing attempt fails.
 */
export class RoutingModelsCache {
  private readonly queries = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always', gcTime: Infinity, structuralSharing: false } },
  })

  constructor(private readonly ttlMs = 60_000) {}

  async get(client: Pick<ModelRoutingClientApi, 'listModels'>, target: RoutingServiceTarget, peers: PeerInfo[], node: Pick<AntseedNode, 'sendRequest'>): Promise<RouterModelEntry[]> {
    const models = await this.queries.fetchQuery({
      queryKey: modelsKey(target),
      staleTime: this.ttlMs,
      queryFn: () => {
        const signal = AbortSignal.timeout(MODELS_TIMEOUT_MS)
        return client.listModels(target, peers, {
          signal,
          sendRequest: (peer, request) => {
            if (peer.peerId !== target.peerId) throw new Error('Router models must come from the selected routing-service peer')
            return node.sendRequest(peer, request, { signal, controlPlane: true })
          },
        })
      },
    })
    return structuredClone(models)
  }

  invalidate(target: RoutingServiceTarget): void {
    this.queries.removeQueries({ queryKey: modelsKey(target), exact: true })
  }

  expiresAt(target: RoutingServiceTarget): number {
    return (this.queries.getQueryState(modelsKey(target))?.dataUpdatedAt ?? 0) + this.ttlMs
  }
}

function modelsKey(target: RoutingServiceTarget): readonly [string, string, string] {
  return [target.peerId, target.provider, target.serviceId]
}

type ExecutionCandidate = RouteCandidate & { peer: PeerInfo }

/**
 * Build the text-model destinations this buyer's policies allow. The router chooses among them.
 * `preferences` apply as for automatic routing: the peer allow and block lists and `minTrustScore`
 * exclude, judged on the same effective reputation (`effectiveModelReputationScore`, including the
 * live-DIFF verification penalty) automatic routing uses; `maxInputUsdPerMillion` is a soft ranking limit there and never excludes here.
 */
export function eligibleRouterCandidates(
  request: SerializedHttpRequest,
  peers: PeerInfo[],
  requiredParameters: readonly string[],
  preferences: ModelRoutingPreferences | null,
  allowsPeer: (request: SerializedHttpRequest, peer: PeerInfo) => boolean,
): ExecutionCandidate[] {
  const protocol = detectRequestServiceApiProtocol(request)
  const explicitProvider = getExplicitProviderOverride(request)
  // A seller may advertise one model under several names (`glm-5.3`, `glm-5-3`, `z-ai-glm-5-3`)
  // that all resolve to the same service. Keep one destination per seller, provider and service:
  // routing protocols require unique candidate IDs. The cheapest advertised offer wins.
  const candidatesByKey = new Map<string, ExecutionCandidate>()
  const offers = buildNetworkServiceOffers(peers)
  // As in automatic routing, a missing cached-input price lowers a seller's effective reputation
  // only when some seller of the same request does advertise one.
  const preferCachedPricing = offers.some(offer => offer.type === 'text' && offer.cachedInputUsdPerMillion !== undefined)
  for (const offer of offers) {
    // Keep only available, priced text services compatible with the request and required parameters.
    const peer = peers.find(candidate => candidate.peerId === offer.peerId)
    if (!peer || offer.type !== 'text' || (explicitProvider && offer.provider !== explicitProvider)) continue
    if (offer.inputUsdPerMillion === undefined || offer.outputUsdPerMillion === undefined) continue
    const plan = resolvePeerRoutePlan(peer, protocol, offer.serviceId, offer.provider, 'strict')
    if (!plan?.serviceId || findMissingRouteParameters(peer, plan, plan.serviceId, requiredParameters).length) continue
    const rewritten = overrideRoutedModelInBody(request.body, request.headers, plan.serviceId)
    // Check peer policy against the model/provider we would actually send, not the automatic alias.
    const policyRequest = { ...request, body: rewritten.body, headers: { ...rewritten.headers, 'x-antseed-provider': offer.provider } }
    if (!allowsPeer(policyRequest, peer)) continue
    const candidate = {
      peer, peerId: peer.peerId, provider: offer.provider, serviceId: plan.serviceId,
      inputUsdPerMillion: offer.inputUsdPerMillion, outputUsdPerMillion: offer.outputUsdPerMillion,
      ...(offer.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion } : {}),
    }
    const effectiveReputationScore = effectiveModelReputationScore(
      normalizedModelReputationScore(peer),
      offer.cachedInputUsdPerMillion !== undefined,
      preferCachedPricing,
      offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0,
      hasLiveDiffVerdict(peer, offer.serviceId),
    )
    if (preferences && !isModelRouteEligible({ ...candidate, effectiveReputationScore }, preferences)) continue
    const key = JSON.stringify([candidate.peerId, candidate.provider, candidate.serviceId])
    const existing = candidatesByKey.get(key)
    if (!existing || routeCandidatePrice(candidate) < routeCandidatePrice(existing)) candidatesByKey.set(key, candidate)
  }
  return [...candidatesByKey.values()]
}

function routeCandidatePrice(candidate: Pick<RouteCandidate, 'inputUsdPerMillion' | 'outputUsdPerMillion'>): number {
  return candidate.inputUsdPerMillion + candidate.outputUsdPerMillion
}

/**
 * Keep recommendations that match allowed destinations, in the router's order.
 * Each result names its provider, so a model-only entry becomes one entry per allowed
 * provider and the normal dispatch path can never pick a provider the buyer did not allow.
 * Invalid entries and duplicates are discarded; a suggested `reasoningEffort` is kept but not yet applied.
 */
export function resolveRouterRecommendations(routes: readonly RouteRecommendation[], candidates: readonly RouteCandidate[]): RouteRecommendation[] {
  if (!Array.isArray(routes) || routes.length > 512) return []
  const resolved: RouteRecommendation[] = []
  const seen = new Set<string>()
  for (const route of routes) {
    if (!route || typeof route.serviceId !== 'string' || !route.serviceId
      || (route.provider !== undefined && (typeof route.provider !== 'string' || !route.provider.trim()))
      || (route.peerId !== undefined && (typeof route.peerId !== 'string' || !/^[0-9a-f]{40}$/.test(route.peerId)))) continue
    for (const candidate of candidates) {
      if (candidate.serviceId !== route.serviceId || (route.peerId !== undefined && candidate.peerId !== route.peerId)
        || (route.provider !== undefined && candidate.provider !== route.provider)) continue
      const entry = { serviceId: route.serviceId, provider: candidate.provider, ...(route.peerId ? { peerId: route.peerId } : {}),
        ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) }
      const key = JSON.stringify([entry.peerId ?? null, entry.provider, entry.serviceId])
      if (seen.has(key)) continue
      seen.add(key)
      resolved.push(entry)
    }
  }
  return resolved
}

/**
 * Turn one recommendation into an ordinary inference request: set the model, and pin
 * the seller/provider when the router chose them. The normal dispatch path does the rest.
 */
export function requestForRecommendation(request: SerializedHttpRequest, route: RouteRecommendation, requestId: string): SerializedHttpRequest {
  const rewritten = overrideRoutedModelInBody(request.body, request.headers, route.serviceId)
  if (!rewritten.overridden) throw new Error('Could not apply router recommendation')
  const headers = { ...rewritten.headers }
  delete headers['x-antseed-pin-peer']
  delete headers['x-antseed-prefer-peer']
  if (route.peerId) headers['x-antseed-pin-peer'] = route.peerId
  // Keep the caller's provider restriction unless the router named an exact provider.
  if (route.provider) headers['x-antseed-provider'] = route.provider
  return { ...request, requestId, body: rewritten.body, headers }
}

/**
 * Buy recommendations from the selected routing service and keep only allowed ones.
 * This does not send inference; BuyerProxy dispatches each recommendation normally.
 */
export async function executeRouterSelection(args: {
  node: Pick<AntseedNode, 'sendRequest'>;
  client: ModelRoutingClientApi;
  request: SerializedHttpRequest;
  peers: PeerInfo[];
  candidates: ExecutionCandidate[];
  conversationKey: string | null;
  selection: Extract<RoutingSelection, { kind: 'router' }>;
  signal: AbortSignal;
  modelsCache?: RoutingModelsCache;
  onRoutingRequest?: (requestId: string) => void;
  /** Buyer identity that pays for the ranking (a gateway key's wallet); the default identity when unset. */
  buyerIdentity?: string;
}): Promise<RouteRecommendation[]> {
  const { node, client, request, peers, conversationKey, signal } = args
  const routingService = args.selection.service
  if (!routingService) throw new Error('Select an exact routing-service target')
  const allowedModels = args.selection.allowedModels
  const modelsCache = args.modelsCache ?? new RoutingModelsCache(0)
  // Check the router settings against the router's own protocol before anything is fetched or bought.
  const protocol = routingProtocolOfTarget(peers, routingService)
  const options = protocol ? validateRouterOptions(routingClientAdapter(protocol).options, args.selection.options) : args.selection.options
  const attempt = async (): Promise<RouteRecommendation[]> => {
    const routerModel = routerModelResolver(await untilAborted(signal, modelsCache.get(client, routingService, peers, node)))
    const allowed = args.candidates
      .filter(candidate => allowedModels === undefined || allowedModels.some(model =>
        model.provider === candidate.provider && model.serviceId === candidate.serviceId))
    if (!allowed.length && allowedModels !== undefined) throw new NoEligibleCandidatesError('None of the allowed models is in this router’s model allow list.')
    // Send only models the router lists, within its price limits, named the way the router names them.
    const candidates: RouteCandidate[] = allowed.flatMap(({ peer: _peer, ...candidate }) => {
      const model = routerModel(candidate.serviceId, candidatePricing(candidate))
      return model ? [{ ...candidate, routerModel: model }] : []
    })
    if (!candidates.length) throw new NoEligibleCandidatesError('None of the allowed models can be ranked by this router.')
    const routes = await untilAborted(signal, client.selectRoute(request, peers, {
      signal, conversationKey, candidates, routingService,
      ...(options !== undefined ? { options } : {}),
      // Pay for the recommendation only if it names at least one allowed destination.
      acceptRecommendations: recommendations => resolveRouterRecommendations(recommendations, candidates).length > 0,
      sendRequest: (peer, serviceRequest, options) => {
        if (peer.peerId !== routingService.peerId) throw new Error('Routing request must use the selected routing-service peer')
        // Routing and inference are separate purchases, so they need separate billing IDs.
        if (!serviceRequest.requestId || serviceRequest.requestId === request.requestId) throw new Error('Routing purchases require a distinct request ID')
        args.onRoutingRequest?.(serviceRequest.requestId)
        return node.sendRequest(peer, serviceRequest, { ...options, signal, ...(args.buyerIdentity ? { buyerIdentity: args.buyerIdentity } : {}) })
      },
    }))
    signal.throwIfAborted()
    const resolved = routes ? resolveRouterRecommendations(routes, candidates) : []
    if (!resolved.length) throw new Error('Selected router returned no eligible recommendation')
    return resolved
  }
  try {
    return await attempt()
  } catch (error) {
    // Nothing was left to rank, or the options were refused, before any call: the cached model list is not at fault, so keep it.
    if (error instanceof NoEligibleCandidatesError || error instanceof InvalidRouterOptionsError) throw error
    modelsCache.invalidate(routingService)
    // The router cannot rank any candidate: our cached model list may be stale. Refresh it and retry once; failed ranks are not charged.
    if (error instanceof RouterCannotRankError) {
      try {
        return await attempt()
      } catch (retryError) {
        modelsCache.invalidate(routingService)
        throw retryError
      }
    }
    throw error
  }
}

/** No candidate is left to rank once the buyer's, the key's and the router's model limits apply; nothing was paid. */
export class NoEligibleCandidatesError extends Error {}

/** Stop waiting when `signal` aborts, even if the client ignores it (so timeouts always apply). */
function untilAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let onAbort = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}
