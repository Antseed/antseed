import { validateRoutingServiceMetadata, type PeerInfo, type ModelRouterAdapter, type RoutingServiceTarget, type RoutingUsageObservation } from '@antseed/node'

export class ModelRouterRegistry {
  private readonly adapters = new Map<string, ModelRouterAdapter>()

  register(protocol: string, adapter: ModelRouterAdapter): void {
    if (!protocol.trim() || protocol !== protocol.trim()) throw new Error('Invalid routing protocol')
    if (this.adapters.has(protocol)) throw new Error(`Routing adapter already registered: ${protocol}`)
    validateRoutingServiceMetadata(adapter.routingMetadata)
    this.adapters.set(protocol, adapter)
  }

  resolve(target: RoutingServiceTarget, peers: PeerInfo[]): ModelRouterAdapter {
    const peer = peers.find(candidate => candidate.peerId === target.peerId)
    if (peer && !Array.isArray(peer.metadata?.providers)) {
      throw new Error('Selected router metadata is not available yet. Wait for discovery or restart the router.')
    }
    const providers = peer?.metadata?.providers.filter(provider => provider.provider === target.provider && provider.services.includes(target.serviceId)) ?? []
    if (providers.length !== 1) throw new Error('Selected routing service is not advertised by the selected peer')
    const protocols = [...new Set(providers[0]!.serviceApiProtocols?.[target.serviceId] ?? [])]
    const supported = protocols.filter(protocol => this.adapters.has(protocol))
    if (supported.length === 0) throw new Error('No registered adapter supports the selected routing service')
    if (supported.length !== 1) throw new Error('Selected routing service advertises multiple registered routing protocols')
    return this.adapters.get(supported[0]!)!
  }

  recordUsage(observation: RoutingUsageObservation): void {
    for (const adapter of this.adapters.values()) adapter.recordUsage?.(structuredClone(observation))
  }
}
