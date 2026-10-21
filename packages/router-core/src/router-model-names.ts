import { ROUTER_ANY_MODEL, withinRouterPricing, type RouterModelEntry, type RouterPricing } from '@antseed/node'
import { canonicalModelKey } from '@antseed/node/model-identity'

/**
 * Translate seller service IDs into the model names a router lists in its model catalog.
 * An exact name match wins; otherwise names are compared by canonical model key (the same
 * matching the savings baselines use), and the first listed router model wins a tie.
 * When the router lists `*`, unmatched service IDs pass through unchanged.
 * With `pricing`, a candidate priced above the matched entry's `maxPricing` is dropped.
 * Returns `undefined` when the router lists no matching model and no `*`, or the price is over the limit.
 */
export function routerModelResolver(entries: readonly RouterModelEntry[]): (serviceId: string, pricing?: RouterPricing) => string | undefined {
  const exact = new Map<string, RouterModelEntry>()
  const byKey = new Map<string, RouterModelEntry>()
  let anyModel: RouterModelEntry | undefined
  for (const entry of entries) {
    if (entry.id === ROUTER_ANY_MODEL) {
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
    if (!entry || (pricing && !withinRouterPricing(pricing, entry.maxPricing))) return undefined
    return named ? named.id : serviceId
  }
}
