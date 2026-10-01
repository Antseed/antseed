import { MODEL_ROUTING_PROTOCOL } from '@antseed/node'
import { ModelRouterRegistry, ModelRoutingAdapter } from '@antseed/router-core'

export type BuyerModelRouterRegistry = Pick<ModelRouterRegistry, 'resolve' | 'recordUsage'>

export function createBuyerModelRouterRegistry(): ModelRouterRegistry {
  const registry = new ModelRouterRegistry()
  registry.register(MODEL_ROUTING_PROTOCOL, new ModelRoutingAdapter())
  return registry
}
