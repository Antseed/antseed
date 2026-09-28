import { ModelRouterRegistry } from '@antseed/router-core'
import { LevantoRoutingAdapter } from '@antseed/router-levanto'

export type BuyerModelRouters = Pick<ModelRouterRegistry, 'resolve' | 'recordUsage'>

export function resolveBuyerModelRouterOptions(
  environment: Record<string, string | undefined>,
  instanceConfig: Record<string, unknown> = {},
): { levantoRoutingPeerUrl?: string } {
  const instanceUrl = instanceConfig['LEVANTO_ROUTING_PEER_URL']
  return {
    levantoRoutingPeerUrl: environment['LEVANTO_ROUTING_PEER_URL']
      ?? (typeof instanceUrl === 'string' ? instanceUrl : undefined),
  }
}

export function createBuyerModelRouters(options: { levantoRoutingPeerUrl?: string } = {}): ModelRouterRegistry {
  const registry = new ModelRouterRegistry()
  registry.register('levanto-routing', new LevantoRoutingAdapter({
    routingPeerUrl: options.levantoRoutingPeerUrl?.trim() || undefined,
  }))
  return registry
}
