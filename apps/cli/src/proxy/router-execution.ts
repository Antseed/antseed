import { buildNetworkServiceOffers, isModelRouteEligible, type AntseedNode, type ModelRoutingPreferences, type PeerInfo, type RouteCandidate, type RouteRecommendation, type SerializedHttpRequest } from '@antseed/node'
import { detectRequestServiceApiProtocol } from './service-api-adapter.js'
import { findMissingRequiredParameters, getExplicitProviderOverride, resolvePeerRoutePlan } from './routing.js'
import { overrideRoutedModelInBody } from './request-utils.js'
import { RoutingDescriptionChangedError, resolveRoutingPreferences, type RoutingDescribeResponseV1, type RoutingSelection, type RoutingServiceTarget, type ModelRouterAdapter } from '@antseed/node'

const DESCRIBE_TIMEOUT_MS = 5_000

/** Router descriptions, reused until they expire or the router reports that its description changed. */
export class RoutingDescriptionCache {
  private readonly entries = new Map<string, { description: RoutingDescribeResponseV1; fetchedAt: number }>()

  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  async get(adapter: Pick<ModelRouterAdapter, 'describe'>, target: RoutingServiceTarget, peers: PeerInfo[], node: Pick<AntseedNode, 'sendRequest'>): Promise<RoutingDescribeResponseV1> {
    const key = descriptionKey(target)
    const cached = this.entries.get(key)
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return structuredClone(cached.description)
    const signal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)
    const description = await adapter.describe(target, peers, {
      signal,
      sendRequest: (peer, request) => {
        if (peer.peerId !== target.peerId) throw new Error('Router description must come from the selected routing-service peer')
        return node.sendRequest(peer, request, { signal, controlPlane: true })
      },
    })
    this.entries.set(key, { description: structuredClone(description), fetchedAt: this.now() })
    return description
  }

  invalidate(target: RoutingServiceTarget): void {
    this.entries.delete(descriptionKey(target))
  }
}

function descriptionKey(target: RoutingServiceTarget): string {
  return JSON.stringify([target.peerId, target.provider, target.serviceId])
}

export type ExecutionCandidate = RouteCandidate & { peer: PeerInfo }

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
      ...(offer.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion } : {}),
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
    if (!route || typeof route.serviceId !== 'string' || !route.serviceId
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
  selection: Extract<RoutingSelection, { kind: 'router' }>;
  signal: AbortSignal;
  descriptions?: RoutingDescriptionCache;
  onRoutingRequest?: (requestId: string) => void;
}): Promise<RouteRecommendation[]> {
  const { node, adapter, request, peers, conversationKey, signal } = args
  const routingService = args.selection.service
  if (!routingService) throw new Error('Select an exact routing-service target')
  const allowedModels = args.selection.allowedModels
  const descriptions = args.descriptions ?? new RoutingDescriptionCache(0)
  const attempt = async (): Promise<RouteRecommendation[]> => {
    const description = await untilAborted(signal, descriptions.get(adapter, routingService, peers, node))
    const supported = new Set(description.supportedServiceIds)
    const allowed = args.candidates
      .filter(candidate => allowedModels === undefined || allowedModels.some(model =>
        model.provider === candidate.provider && model.serviceId === candidate.serviceId))
    if (!allowed.length && allowedModels !== undefined) throw new Error('No eligible models match this router’s model allowlist. Update Router settings or select a model.')
    // Send only models the router understands.
    const candidates: RouteCandidate[] = allowed
      .filter(candidate => supported.has(candidate.serviceId))
      .map(({ peer: _peer, ...candidate }) => candidate)
    if (!candidates.length) throw new Error('No eligible allowed models are supported by this router')
    // Check the user's choices against the router's own schema before paying.
    const preferences = resolveRoutingPreferences(description.preferencesSchema, args.selection.preferences ?? {})
    const routes = await untilAborted(signal, adapter.selectRoute(request, peers, {
      signal, conversationKey, candidates, preferences, routingService, description,
      // Pay for the recommendation only if it names at least one allowed destination.
      acceptRecommendations: recommendations => resolveRouterRecommendations(recommendations, candidates).length > 0,
      sendRequest: (peer, serviceRequest, options) => {
        if (peer.peerId !== routingService.peerId) throw new Error('Routing request must use the selected routing-service peer')
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
  }
  try {
    return await attempt()
  } catch (error) {
    descriptions.invalidate(routingService)
    // The router's models or settings changed after we described it: refresh once and retry.
    if (error instanceof RoutingDescriptionChangedError) {
      try {
        return await attempt()
      } catch (retryError) {
        descriptions.invalidate(routingService)
        throw retryError
      }
    }
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
