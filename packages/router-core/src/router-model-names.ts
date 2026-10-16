import { MODEL_ROUTING_ANY_MODEL, withinRoutingPricing, type RoutingModelEntryV1, type RoutingPricingV1 } from '@antseed/node'
import { canonicalModelKey } from '@antseed/node/model-identity'

/**
 * Translate seller service IDs into the model names a router lists in `GET /v1/routing/models`.
 * An exact name match wins; otherwise names are compared by canonical model key (the same
 * matching the savings baselines use), and the first listed router model wins a tie.
 * When the router lists `*`, unmatched service IDs pass through unchanged.
 * With `pricing`, a candidate priced above the matched entry's `max_pricing` is dropped.
 * Returns `undefined` when the router lists no matching model and no `*`, or the price is over the limit.
 */
export function routerModelResolver(entries: readonly RoutingModelEntryV1[]): (serviceId: string, pricing?: RoutingPricingV1) => string | undefined {
  const exact = new Map<string, RoutingModelEntryV1>()
  const byKey = new Map<string, RoutingModelEntryV1>()
  let anyModel: RoutingModelEntryV1 | undefined
  for (const entry of entries) {
    if (entry.id === MODEL_ROUTING_ANY_MODEL) {
      anyModel = entry
      continue
    }
    exact.set(entry.id, entry)
    const key = canonicalModelKey(entry.id)
    if (key && !byKey.has(key)) byKey.set(key, entry)
  }
  return (serviceId, pricing) => {
    const key = canonicalModelKey(serviceId)
    const named = exact.get(serviceId) ?? (key ? byKey.get(key) : undefined)
    const entry = named ?? anyModel
    if (!entry || (pricing && !withinRoutingPricing(pricing, entry.max_pricing))) return undefined
    return named ? named.id : serviceId
  }
}
