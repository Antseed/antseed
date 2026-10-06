import { buildNetworkServiceOffers, evaluateUnitBilling, MODEL_ROUTING_PROTOCOL, validateUnitBillingModelForProtocolV1, type AntseedNode, type PeerInfo } from '@antseed/node'
import { routerModelResolver, type ModelRoutingClientApi } from '@antseed/router-core'
import { RoutingModelsCache } from './router-execution.js'

export async function buildRoutingServices(peers: PeerInfo[], client: ModelRoutingClientApi, node: Pick<AntseedNode, 'sendRequest'>, modelsCache = new RoutingModelsCache()) {
  const offers = buildNetworkServiceOffers(peers)
  const services = peers.flatMap(peer => (peer.metadata?.providers ?? []).flatMap(provider => (
    provider.services.flatMap(serviceId => {
      if (!provider.serviceApiProtocols?.[serviceId]?.includes(MODEL_ROUTING_PROTOCOL)) return []
      try {
        const target = { peerId: peer.peerId, provider: provider.provider, serviceId }
        if (peer.metadata!.providers.filter(entry => entry.provider === provider.provider && entry.services.includes(serviceId)).length !== 1) return []
        const model = provider.serviceUnitBillingModels?.[serviceId]?.[MODEL_ROUTING_PROTOCOL]
        if (!model || validateUnitBillingModelForProtocolV1(MODEL_ROUTING_PROTOCOL, model).length) return []
        const price = evaluateUnitBilling(model, { sellerPeerId: peer.peerId, provider: provider.provider, service: serviceId, serviceApiProtocol: MODEL_ROUTING_PROTOCOL }, { units: { completed_requests: 1 } })
        return [{ peer, target, priceMicroUsdc: price.toString() }]
      } catch {
        return []
      }
    })
  )))
  return Promise.all(services.map(async ({ peer, target, priceMicroUsdc }) => {
    const service = { ...target, label: peer.displayName || target.provider, sellerName: peer.displayName || target.provider, priceMicroUsdc }
    try {
      const resolveModel = routerModelResolver(await modelsCache.get(client, target, peers, node))
      const models = [...new Map(offers.filter(offer => offer.type === 'text' && resolveModel(offer.serviceId))
        .map(({ provider, serviceId }) => [JSON.stringify([provider, serviceId]), { provider, serviceId }])).values()]
      return { ...service, catalog: { models }, catalogExpiresAt: modelsCache.expiresAt(target), catalogError: undefined }
    } catch (error) {
      return { ...service, catalog: undefined, catalogExpiresAt: undefined, catalogError: error instanceof Error ? error.message : 'Router models unavailable' }
    }
  }))
}
