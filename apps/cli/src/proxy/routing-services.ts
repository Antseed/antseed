import { buildNetworkServiceOffers, evaluateUnitBilling, MODEL_ROUTING_PROTOCOL, validateUnitBillingModelForProtocolV1, type AntseedNode, type PeerInfo, type RoutingServiceTarget } from '@antseed/node'
import { candidatePricing, routerModelResolver, type ModelRoutingClientApi } from '@antseed/router-core'
import { RoutingModelsCache } from './router-execution.js'

/** The one `model-routing` service a peer advertises, or null when it advertises none or several (buyers skip those). */
export function routingServiceOf(peer: PeerInfo): { provider: NonNullable<PeerInfo['metadata']>['providers'][number]; serviceId: string } | null {
  const routingServices = (peer.metadata?.providers ?? []).flatMap(provider => provider.services
    .filter(serviceId => provider.serviceApiProtocols?.[serviceId]?.includes(MODEL_ROUTING_PROTOCOL))
    .map(serviceId => ({ provider, serviceId })))
  return routingServices.length === 1 ? routingServices[0]! : null
}

/** The routing service a `<peerId>@<serviceId>` pin names, when that peer advertises it as its `model-routing` service. */
export function findPinnedRoutingService(peers: PeerInfo[], peerId: string, serviceId: string): RoutingServiceTarget | null {
  const peer = peers.find(candidate => candidate.peerId.toLowerCase() === peerId.toLowerCase())
  const routing = peer ? routingServiceOf(peer) : null
  if (!peer || !routing || routing.serviceId.trim().toLowerCase() !== serviceId.trim().toLowerCase()) return null
  return { peerId: peer.peerId, provider: routing.provider.provider, serviceId: routing.serviceId }
}

export async function buildRoutingServices(peers: PeerInfo[], client: ModelRoutingClientApi, node: Pick<AntseedNode, 'sendRequest'>, modelsCache = new RoutingModelsCache()) {
  const offers = buildNetworkServiceOffers(peers)
  const services = peers.flatMap(peer => {
    const routing = routingServiceOf(peer)
    if (!routing) return []
    const { provider, serviceId } = routing
    try {
      const target = { peerId: peer.peerId, provider: provider.provider, serviceId }
      const model = provider.serviceUnitBillingModels?.[serviceId]?.[MODEL_ROUTING_PROTOCOL]
      if (!model || validateUnitBillingModelForProtocolV1(MODEL_ROUTING_PROTOCOL, model).length) return []
      const price = evaluateUnitBilling(model, { sellerPeerId: peer.peerId, provider: provider.provider, service: serviceId, serviceApiProtocol: MODEL_ROUTING_PROTOCOL }, { units: { completed_requests: 1 } })
      return [{ peer, target, priceMicroUsdc: price.toString() }]
    } catch {
      return []
    }
  })
  return Promise.all(services.map(async ({ peer, target, priceMicroUsdc }) => {
    const service = { ...target, label: peer.displayName || target.provider, sellerName: peer.displayName || target.provider, priceMicroUsdc }
    try {
      const resolveModel = routerModelResolver(await modelsCache.get(client, target, peers, node))
      const models = [...new Map(offers.filter(offer => offer.type === 'text' && resolveModel(offer.serviceId, offerPricing(offer)))
        .map(({ provider, serviceId }) => [JSON.stringify([provider, serviceId]), { provider, serviceId }])).values()]
      return { ...service, catalog: { models }, catalogExpiresAt: modelsCache.expiresAt(target), catalogError: undefined }
    } catch (error) {
      return { ...service, catalog: undefined, catalogExpiresAt: undefined, catalogError: error instanceof Error ? error.message : 'Router models unavailable' }
    }
  }))
}

/** Candidate pricing for an offer, when it has token prices; the router's price limits only apply to priced offers. */
function offerPricing(offer: { inputUsdPerMillion?: number; outputUsdPerMillion?: number; cachedInputUsdPerMillion?: number }) {
  if (offer.inputUsdPerMillion === undefined || offer.outputUsdPerMillion === undefined) return undefined
  return candidatePricing({ inputUsdPerMillion: offer.inputUsdPerMillion, outputUsdPerMillion: offer.outputUsdPerMillion,
    ...(offer.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion } : {}) })
}
