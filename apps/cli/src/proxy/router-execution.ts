import { buildNetworkServiceOffers, isModelRouteEligible, normalizedModelReputationScore, rankModelRoutes, type AntseedNode, type ModelRoutingPreferences, type PeerInfo, type RouteCandidate, type RouteRecommendation, type SerializedHttpRequest } from '@antseed/node'
import { detectRequestServiceApiProtocol } from './service-api-adapter.js'
import { findMissingRequiredParameters, getExplicitProviderOverride, resolvePeerRoutePlan } from './routing.js'
import { overrideRoutedModelInBody } from './request-utils.js'
import { createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingCatalog, validateRoutingServiceMetadata, type RoutingCatalogV1, type RoutingSelection, type RoutingServiceTarget, type ModelRouterAdapter } from '@antseed/node'
import { QueryClient } from '@tanstack/query-core'

const CATALOG_TIMEOUT_MS = 5_000

export class RoutingCatalogCache {
  private readonly queries = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always', gcTime: Infinity, structuralSharing: false } },
  })

  constructor(private readonly ttlMs = 60_000) {}

  async get(adapter: Pick<ModelRouterAdapter, 'getCatalog'>, target: RoutingServiceTarget | undefined, peers: PeerInfo[]): Promise<{ catalog?: RoutingCatalogV1; expiresAt: number }> {
    const getCatalog = adapter.getCatalog
    if (!target || !getCatalog) return { expiresAt: Number.POSITIVE_INFINITY }
    const queryKey = routingCatalogKey(target)
    const catalog = await this.queries.fetchQuery({
      queryKey, staleTime: this.ttlMs,
      queryFn: async () => {
        const result = await getCatalog.call(adapter, structuredClone(target), structuredClone(peers), AbortSignal.timeout(CATALOG_TIMEOUT_MS))
        if (result === undefined) return null
        validateRoutingCatalog(result)
        return structuredClone(result)
      },
    })
    const expiresAt = (this.queries.getQueryState(queryKey)?.dataUpdatedAt ?? Date.now()) + this.ttlMs
    return catalog ? { catalog: structuredClone(catalog), expiresAt } : { expiresAt }
  }

  invalidate(target: RoutingServiceTarget): void {
    this.queries.removeQueries({ queryKey: routingCatalogKey(target), exact: true })
  }
}

function routingCatalogKey(target: RoutingServiceTarget) {
  return ['routing-catalog', target.peerId, target.provider, target.serviceId] as const
}

/**
 * Recommendation step before inference: build allowed destinations, ask the selected
 * adapter, and resolve its recommendations back to those destinations. The caller
 * then sends the actual inference request; this module does not generate the answer.
 */
export type ExecutionCandidate = RouteCandidate & { peer: PeerInfo; effectiveReputationScore: number | null }

export function routingMetadataForService(adapter: Pick<ModelRouterAdapter, 'routingMetadata'>, catalog?: RoutingCatalogV1) {
  return catalog ? createRoutingServiceMetadata(catalog.preferencesSchema) : adapter.routingMetadata
}

export type ResolvedRouterRecommendation =
  | { serviceId: string; peerId: string; candidate: ExecutionCandidate }
  | { serviceId: string; peerId?: undefined; candidates: ExecutionCandidate[] }

function recommendationCandidates(routes: readonly ResolvedRouterRecommendation[]): ExecutionCandidate[] {
  return routes.flatMap(route => route.peerId === undefined ? route.candidates : [route.candidate])
}

/** Build the text-model destinations this buyer can use, ordered by its existing routing policy. */
export function eligibleRouterCandidates(
  request: SerializedHttpRequest,
  peers: PeerInfo[],
  requiredParameters: readonly string[],
  preferences: ModelRoutingPreferences | null,
  allowsPeer: (request: SerializedHttpRequest, peer: PeerInfo) => boolean,
): ExecutionCandidate[] {
  const protocol = detectRequestServiceApiProtocol(request)
  const explicitProvider = getExplicitProviderOverride(request)
  const candidates: ExecutionCandidate[] = []
  for (const offer of buildNetworkServiceOffers(peers)) {
    // Keep only available, priced text services compatible with the request and required parameters.
    const peer = peers.find(candidate => candidate.peerId === offer.peerId)
    if (!peer || offer.type !== 'text' || (explicitProvider && offer.provider !== explicitProvider)) continue
    if (peer.maxConcurrency !== undefined && peer.currentLoad !== undefined && peer.currentLoad >= peer.maxConcurrency) continue
    if (offer.inputUsdPerMillion === undefined || offer.outputUsdPerMillion === undefined) continue
    const plan = resolvePeerRoutePlan(peer, protocol, offer.serviceId, offer.provider, 'strict')
    if (!plan?.serviceId || (requiredParameters.length && plan.selection?.requiresTransform)) continue
    if (findMissingRequiredParameters(peer, offer.provider, plan.serviceId, requiredParameters).length) continue
    const rewritten = overrideRoutedModelInBody(request.body, request.headers, plan.serviceId)
    // Check peer policy against the model/provider we would actually send, not the automatic alias.
    const policyRequest = { ...request, body: rewritten.body, headers: { ...rewritten.headers, 'x-antseed-provider': offer.provider } }
    if (!allowsPeer(policyRequest, peer)) continue
    const candidate = {
      peer, peerId: peer.peerId, provider: offer.provider, serviceId: plan.serviceId,
      inputUsdPerMillion: offer.inputUsdPerMillion, outputUsdPerMillion: offer.outputUsdPerMillion,
      effectiveReputationScore: normalizedModelReputationScore(peer),
    }
    if (!preferences || (isModelRouteEligible(candidate, preferences) && candidate.inputUsdPerMillion <= preferences.maxInputUsdPerMillion)) candidates.push(candidate)
  }
  if (preferences) return rankModelRoutes(candidates, preferences)
  return candidates.sort((first, second) => (second.effectiveReputationScore ?? -1) - (first.effectiveReputationScore ?? -1)
    || first.peerId.localeCompare(second.peerId))
}

/** Return the first eligible destination from a recommendation list, or null if none match. */
export function resolveRouterRecommendation(routes: readonly RouteRecommendation[], candidates: readonly ExecutionCandidate[]): ExecutionCandidate | null {
  return recommendationCandidates(resolveRouterRecommendations(routes, candidates))[0] ?? null
}

/**
 * Match recommendations to the buyer's allowed destinations, preserving recommendation order.
 * Keep model-only choices distinct from exact peers, with their allowed sellers in policy order.
 * Invalid entries and duplicate peer/provider/service destinations are discarded.
 */
export function resolveRouterRecommendations(routes: readonly RouteRecommendation[], candidates: readonly ExecutionCandidate[]): ResolvedRouterRecommendation[] {
  if (!Array.isArray(routes) || routes.length === 0 || routes.length > 512) return []
  const resolved: ResolvedRouterRecommendation[] = []
  const seen = new Set<string>()
  for (const route of routes) {
    if (!route || typeof route.serviceId !== 'string' || !route.serviceId || route.inference !== undefined
      || (route.provider !== undefined && (typeof route.provider !== 'string' || !route.provider.trim()))
      || (route.peerId !== undefined && (typeof route.peerId !== 'string' || !/^[0-9a-f]{40}$/.test(route.peerId)))) continue
    const modelCandidates: ExecutionCandidate[] = []
    for (const candidate of candidates) {
      if (candidate.serviceId !== route.serviceId || (route.peerId !== undefined && candidate.peerId !== route.peerId)) continue
      if (route.provider !== undefined && route.provider !== candidate.provider) continue
      const key = JSON.stringify([candidate.peerId, candidate.provider, candidate.serviceId])
      if (seen.has(key)) continue
      seen.add(key)
      if (route.peerId === undefined) modelCandidates.push(candidate)
      else resolved.push({ serviceId: route.serviceId, peerId: route.peerId, candidate })
    }
    if (modelCandidates.length) resolved.push({ serviceId: route.serviceId, candidates: modelCandidates })
  }
  return resolved
}

/** Rewrite the requested model and pin its inference peer/provider, without sending the request. */
export function requestForRouterCandidate(request: SerializedHttpRequest, candidate: ExecutionCandidate): SerializedHttpRequest {
  const rewritten = overrideRoutedModelInBody(request.body, request.headers, candidate.serviceId)
  if (!rewritten.overridden) throw new Error('Could not apply router recommendation')
  return {
    ...request, body: rewritten.body,
    headers: { ...rewritten.headers, 'x-antseed-pin-peer': candidate.peerId, 'x-antseed-provider': candidate.provider },
  }
}

/**
 * Ask the selected model-router adapter for recommendations and validate the result.
 * Return a request prepared for the first destination plus the model/peer recommendations;
 * BuyerProxy performs inference dispatch and retry handling afterward.
 */
export async function executeRouterSelection(args: {
  node: Pick<AntseedNode, 'sendRequest'>;
  adapter: ModelRouterAdapter;
  request: SerializedHttpRequest;
  peers: PeerInfo[];
  candidates: ExecutionCandidate[];
  conversationKey: string | null;
  selection?: Extract<RoutingSelection, { kind: 'router' }>;
  signal: AbortSignal;
  catalogs?: RoutingCatalogCache;
  onRoutingRequest?: (requestId: string) => void;
}): Promise<{ request: SerializedHttpRequest; recommendations: ResolvedRouterRecommendation[] }> {
  const { node, adapter, request, peers, conversationKey, signal } = args
  const allowedModels = args.selection?.allowedModels
  let candidates = allowedModels === undefined ? args.candidates : args.candidates.filter(candidate =>
    allowedModels.some(model => model.provider === candidate.provider && model.serviceId === candidate.serviceId))
  if (!candidates.length && allowedModels !== undefined) throw new Error('No eligible models match this router’s model allowlist. Update Router settings or select a model.')
  const routingService = args.selection?.service
  const catalogs = args.catalogs ?? new RoutingCatalogCache(0)
  const { catalog } = await catalogs.get(adapter, routingService, peers)
  if (catalog) {
    candidates = candidates.filter(candidate => catalog.models.some(model => model.provider === candidate.provider && model.serviceId === candidate.serviceId))
    if (!candidates.length) throw new Error('No eligible allowed models are supported by this router')
  }
  // Validate this adapter's preference schema and apply its defaults before calling it.
  const metadata = routingMetadataForService(adapter, catalog)
  if (metadata) validateRoutingServiceMetadata(metadata)
  const preferences = resolveRoutingPreferences(metadata?.preferencesSchema ?? { type: 'object', properties: {}, additionalProperties: false }, args.selection?.preferences ?? {})
  signal.throwIfAborted()
  let acceptedKeys: string | null = null
  const candidateKeys = (resolved: readonly ResolvedRouterRecommendation[]) => JSON.stringify(recommendationCandidates(resolved).map(candidate => [candidate.peerId, candidate.provider, candidate.serviceId]))
  let onAbort: () => void = () => {}
  // Stop waiting on cancellation even if the adapter does not observe the supplied signal.
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Routing aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    // Give the adapter request/peer copies so its rewrites do not mutate the buyer's originals.
    const routes = await Promise.race([aborted, adapter.selectRoute(structuredClone(request), structuredClone(peers), {
      signal, conversationKey,
      preferences, preferencesSchemaHash: metadata?.preferencesSchemaHash,
      routingService: routingService ? structuredClone(routingService) : undefined,
      ...(catalog ? { catalog: structuredClone(catalog) } : {}),
      candidates: candidates.map(({ peer: _peer, effectiveReputationScore: _score, ...candidate }) => ({ ...candidate })),
      acceptRecommendations: recommendations => {
        // Remember the accepted destinations and order so the adapter cannot return a different list later.
        if (signal.aborted) return false
        const resolved = resolveRouterRecommendations(recommendations, candidates)
        if (!resolved.length) return false
        const keys = candidateKeys(resolved)
        if (acceptedKeys !== null && acceptedKeys !== keys) return false
        acceptedKeys = keys
        return true
      },
      sendRequest: (peer, serviceRequest, options) => {
        // Recommendation requests use the selected service peer and a separate ID from inference.
        if (routingService && peer.peerId !== routingService.peerId) throw new Error('Routing request must use the selected routing-service peer')
        const snapshot = structuredClone(serviceRequest)
        if (typeof snapshot.requestId !== 'string' || !snapshot.requestId || snapshot.requestId === request.requestId) {
          throw new Error('Routing purchases require a distinct request ID')
        }
        args.onRoutingRequest?.(snapshot.requestId)
        return node.sendRequest(peer, snapshot, { ...options, signal })
      },
    })])
    signal.throwIfAborted()
    // Check the returned recommendations even if the adapter never called acceptRecommendations.
    const resolved = routes ? resolveRouterRecommendations(routes, candidates) : []
    if (!resolved.length || (acceptedKeys !== null && acceptedKeys !== candidateKeys(resolved))) {
      throw new Error('Selected router returned no eligible recommendation')
    }
    return {
      request: requestForRouterCandidate(request, recommendationCandidates(resolved)[0]!),
      recommendations: resolved,
    }
  } catch (error) {
    // A rejected route may mean the router's catalog changed; fetch it fresh next time.
    if (routingService) catalogs.invalidate(routingService)
    throw error
  } finally {
    // Do not leave a listener attached after this recommendation attempt has finished.
    signal.removeEventListener('abort', onAbort)
  }
}
