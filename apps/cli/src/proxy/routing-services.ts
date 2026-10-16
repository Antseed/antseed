import { buildNetworkServiceOffers, evaluateUnitBilling, routingProtocolOf, routingWireProtocol, validateUnitBillingModelForProtocolV1, type AntseedNode, type PeerInfo, type RoutingProtocol, type RoutingServiceTarget } from '@antseed/node'
import { candidatePricing, routerModelResolver, routingClientAdapter, type ModelRoutingClientApi } from '@antseed/router-core'
import { RoutingModelsCache } from './router-execution.js'

type PeerProvider = NonNullable<PeerInfo['metadata']>['providers'][number]

/**
 * The routing services a peer advertises, of any routing protocol. A protocol whose requests
 * name no service is skipped when the peer advertises more than one service of it (buyers
 * cannot address them).
 */
export function routingServicesOf(peer: PeerInfo): Array<{ provider: PeerProvider; serviceId: string; protocol: RoutingProtocol }> {
  const all = (peer.metadata?.providers ?? []).flatMap(provider => provider.services.flatMap(serviceId => {
    const protocol = routingProtocolOf(provider.serviceApiProtocols?.[serviceId])
    return protocol ? [{ provider, serviceId, protocol }] : []
  }))
  return all.filter(entry => !routingWireProtocol(entry.protocol).oneServicePerSeller
    || all.filter(other => other.protocol === entry.protocol).length === 1)
}

/** The routing service a `<peerId>@<serviceId>` pin names, when that peer advertises it as a routing service. */
export function findPinnedRoutingService(peers: PeerInfo[], peerId: string, serviceId: string): RoutingServiceTarget | null {
  const peer = peers.find(candidate => candidate.peerId.toLowerCase() === peerId.toLowerCase())
  const wanted = serviceId.trim().toLowerCase()
  const routing = peer ? routingServicesOf(peer).find(entry => entry.serviceId.trim().toLowerCase() === wanted) : undefined
  if (!peer || !routing) return null
  return { peerId: peer.peerId, provider: routing.provider.provider, serviceId: routing.serviceId }
}

export async function buildRoutingServices(peers: PeerInfo[], client: ModelRoutingClientApi, node: Pick<AntseedNode, 'sendRequest'>, modelsCache = new RoutingModelsCache()) {
  const offers = buildNetworkServiceOffers(peers)
  const services = peers.flatMap(peer => routingServicesOf(peer).flatMap(({ provider, serviceId, protocol }) => {
    try {
      const target = { peerId: peer.peerId, provider: provider.provider, serviceId }
      const model = provider.serviceUnitBillingModels?.[serviceId]?.[protocol]
      if (!model || validateUnitBillingModelForProtocolV1(protocol, model).length) return []
      const price = evaluateUnitBilling(model, { sellerPeerId: peer.peerId, provider: provider.provider, service: serviceId, serviceApiProtocol: protocol }, { units: { completed_requests: 1 } })
      return [{ peer, target, protocol, priceMicroUsdc: price.toString() }]
    } catch {
      return []
    }
  }))
  return Promise.all(services.map(async ({ peer, target, protocol, priceMicroUsdc }) => {
    const service = {
      ...target, protocol,
      // The settings this router's protocol accepts with each ranking, for hosts to render.
      options: routingClientAdapter(protocol).options,
      label: peer.displayName || target.provider, sellerName: peer.displayName || target.provider, priceMicroUsdc,
    }
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
