import { completedRequestPrice, resolveServiceBillingOffer, type ModelRouterAdapter, type PeerInfo, type Router } from '@antseed/node'
import { RoutingCatalogCache } from './routing-catalog-cache.js'

export async function buildRoutingServices(peers: PeerInfo[], router?: Router | null, catalogs = new RoutingCatalogCache(0)) {
  const services = peers.flatMap(peer => (peer.metadata?.providers ?? []).flatMap(provider => (
    provider.services.flatMap(serviceId => {
      try {
        const target = { peerId: peer.peerId, provider: provider.provider, serviceId }
        let adapter: ModelRouterAdapter | undefined
        if (router?.getModelRouterAdapter) adapter = router.getModelRouterAdapter(target, peers)
        else if (!provider.serviceApiProtocols?.[serviceId]?.includes('levanto-routing')) return []
        const offer = resolveServiceBillingOffer(peer.metadata!.providers, provider.provider, serviceId)
        return [{ peer, target, adapter, priceMicroUsdc: completedRequestPrice(offer.unitModel).toString() }]
      } catch {
        return []
      }
    })
  )))
  return Promise.all(services.map(async ({ peer, target, adapter, priceMicroUsdc }) => {
    let catalogResult
    let catalogError: string | undefined
    if (adapter) {
      try { catalogResult = await catalogs.get(adapter, target, peers) }
      catch (error) { catalogError = error instanceof Error ? error.message : 'Router catalog unavailable' }
    }
    const catalog = catalogResult?.catalog
    return {
      ...target,
      label: catalog?.title || peer.displayName || target.provider,
      sellerName: peer.displayName || target.provider,
      priceMicroUsdc,
      ...(catalog ? { catalog, catalogExpiresAt: catalogResult!.expiresAt } : {}),
      ...(catalogError ? { catalogError } : {}),
    }
  }))
}
