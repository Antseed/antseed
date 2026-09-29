import { buildNetworkServiceOffers, isModelRouteEligible, type AntseedNode, type ModelRoutingPreferences, type PeerInfo, type RouteCandidate, type RouteRecommendation, type SerializedHttpRequest } from '@antseed/node'
import { detectRequestServiceApiProtocol } from './service-api-adapter.js'
import { findMissingRequiredParameters, getExplicitProviderOverride, resolvePeerRoutePlan } from './routing.js'
import { overrideRoutedModelInBody } from './request-utils.js'
import { createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingCatalog, validateRoutingServiceMetadata, type RoutingCatalogV1, type RoutingSelection, type RoutingServiceTarget, type ModelRouterAdapter } from '@antseed/node'

const CATALOG_TIMEOUT_MS = 5_000

/** Router-supplied model catalogs, reused for a short time so each chat turn does not refetch them. */
export class RoutingCatalogCache {
  private readonly entries = new Map<string, { catalog: RoutingCatalogV1 | undefined; fetchedAt: number }>()

  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  async get(adapter: Pick<ModelRouterAdapter, 'getCatalog'>, target: RoutingServiceTarget | undefined, peers: PeerInfo[]): Promise<RoutingCatalogV1 | undefined> {
    if (!target || !adapter.getCatalog) return undefined
    const key = catalogKey(target)
    const cached = this.entries.get(key)
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.catalog
    const catalog = await adapter.getCatalog(target, peers, AbortSignal.timeout(CATALOG_TIMEOUT_MS))
    if (catalog !== undefined) validateRoutingCatalog(catalog)
    this.entries.set(key, { catalog, fetchedAt: this.now() })
    return catalog
  }

  invalidate(target: RoutingServiceTarget): void {
    this.entries.delete(catalogKey(target))
  }
}

function catalogKey(target: RoutingServiceTarget): string {
  return JSON.stringify([target.peerId, target.provider, target.serviceId])
}

export type ExecutionCandidate = RouteCandidate & { peer: PeerInfo }

export function routingMetadataForService(adapter: Pick<ModelRouterAdapter, 'routingMetadata'>, catalog?: RoutingCatalogV1) {
  return catalog ? createRoutingServiceMetadata(catalog.preferencesSchema) : adapter.routingMetadata
}

/** Build the text-model destinations this buyer's policies allow. The router chooses among them. */
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
    }
    if (!preferences || (isModelRouteEligible(candidate, preferences) && candidate.inputUsdPerMillion <= preferences.maxInputUsdPerMillion)) candidates.push(candidate)
  }
  return candidates
}

/**
 * Keep recommendations that match allowed destinations, in the router's order.
 * Each result names its provider, so a model-only entry becomes one entry per allowed
 * provider and the normal dispatch path can never pick a provider the buyer did not allow.
 * Invalid entries, reasoning overrides and duplicates are discarded.
 */
export function resolveRouterRecommendations(routes: readonly RouteRecommendation[], candidates: readonly RouteCandidate[]): RouteRecommendation[] {
  if (!Array.isArray(routes) || routes.length > 512) return []
  const resolved: RouteRecommendation[] = []
  const seen = new Set<string>()
  for (const route of routes) {
    if (!route || typeof route.serviceId !== 'string' || !route.serviceId || route.inference !== undefined
      || (route.provider !== undefined && (typeof route.provider !== 'string' || !route.provider.trim()))
      || (route.peerId !== undefined && (typeof route.peerId !== 'string' || !/^[0-9a-f]{40}$/.test(route.peerId)))) continue
    for (const candidate of candidates) {
      if (candidate.serviceId !== route.serviceId || (route.peerId !== undefined && candidate.peerId !== route.peerId)
        || (route.provider !== undefined && candidate.provider !== route.provider)) continue
      const entry = { serviceId: route.serviceId, provider: candidate.provider, ...(route.peerId ? { peerId: route.peerId } : {}) }
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
  adapter: ModelRouterAdapter;
  request: SerializedHttpRequest;
  peers: PeerInfo[];
  candidates: ExecutionCandidate[];
  conversationKey: string | null;
  selection?: Extract<RoutingSelection, { kind: 'router' }>;
  signal: AbortSignal;
  catalogs?: RoutingCatalogCache;
  onRoutingRequest?: (requestId: string) => void;
}): Promise<RouteRecommendation[]> {
  const { node, adapter, request, peers, conversationKey, signal } = args
  const routingService = args.selection?.service
  const allowedModels = args.selection?.allowedModels
  const catalogs = args.catalogs ?? new RoutingCatalogCache(0)
  const catalog = await catalogs.get(adapter, routingService, peers)
  const candidates: RouteCandidate[] = args.candidates
    .filter(candidate => allowedModels === undefined || allowedModels.some(model =>
      model.provider === candidate.provider && model.serviceId === candidate.serviceId))
    .filter(candidate => !catalog || catalog.models.some(model =>
      model.provider === candidate.provider && model.serviceId === candidate.serviceId))
    .map(({ peer: _peer, ...candidate }) => candidate)
  if (!candidates.length && allowedModels !== undefined) throw new Error('No eligible models match this router’s model allowlist. Update Router settings or select a model.')
  if (!candidates.length && catalog) throw new Error('No eligible allowed models are supported by this router')
  // Adapters are plugins: check the user's preferences against the service's schema before paying.
  const metadata = routingMetadataForService(adapter, catalog)
  if (metadata) validateRoutingServiceMetadata(metadata)
  const preferences = resolveRoutingPreferences(metadata?.preferencesSchema ?? { type: 'object', properties: {}, additionalProperties: false }, args.selection?.preferences ?? {})
  try {
    const routes = await untilAborted(signal, adapter.selectRoute(request, peers, {
      signal, conversationKey, candidates, preferences,
      preferencesSchemaHash: metadata?.preferencesSchemaHash,
      routingService,
      ...(catalog ? { catalog } : {}),
      // Pay for the recommendation only if it names at least one allowed destination.
      acceptRecommendations: recommendations => resolveRouterRecommendations(recommendations, candidates).length > 0,
      sendRequest: (peer, serviceRequest, options) => {
        if (routingService && peer.peerId !== routingService.peerId) throw new Error('Routing request must use the selected routing-service peer')
        // Routing and inference are separate purchases, so they need separate billing IDs.
        if (!serviceRequest.requestId || serviceRequest.requestId === request.requestId) throw new Error('Routing purchases require a distinct request ID')
        args.onRoutingRequest?.(serviceRequest.requestId)
        return node.sendRequest(peer, serviceRequest, { ...options, signal })
      },
    }))
    signal.throwIfAborted()
    const resolved = routes ? resolveRouterRecommendations(routes, candidates) : []
    if (!resolved.length) throw new Error('Selected router returned no eligible recommendation')
    return resolved
  } catch (error) {
    // A rejected route may mean the router's catalog changed; fetch it fresh next time.
    if (routingService) catalogs.invalidate(routingService)
    throw error
  }
}

/** Stop waiting when `signal` aborts, even if the adapter ignores it (so timeouts always apply). */
function untilAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let onAbort = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}
