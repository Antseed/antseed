import { ModelRouterRegistry } from '@antseed/router-core'
import { LevantoRoutingAdapter } from '@antseed/router-levanto'

export type BuyerModelRouterRegistry = Pick<ModelRouterRegistry, 'resolve' | 'recordUsage'>

export function createBuyerModelRouterRegistry(): ModelRouterRegistry {
  const registry = new ModelRouterRegistry()
  registry.register('levanto-routing', new LevantoRoutingAdapter())
  return registry
}
