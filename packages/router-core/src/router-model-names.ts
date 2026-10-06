import { canonicalModelKey } from '@antseed/node/model-identity'

/**
 * Translate seller service IDs into the model names a router lists in `GET /v1/routing/models`.
 * An exact name match wins; otherwise names are compared by canonical model key (the same
 * matching the savings baselines use), and the first listed router model wins a tie.
 * Returns `undefined` when the router lists no matching model.
 */
export function routerModelResolver(routerModelIds: readonly string[]): (serviceId: string) => string | undefined {
  const exact = new Set(routerModelIds)
  const byKey = new Map<string, string>()
  for (const id of routerModelIds) {
    const key = canonicalModelKey(id)
    if (key && !byKey.has(key)) byKey.set(key, id)
  }
  return serviceId => {
    if (exact.has(serviceId)) return serviceId
    const key = canonicalModelKey(serviceId)
    return key ? byKey.get(key) : undefined
  }
}
