import { QueryClient } from '@tanstack/query-core'
import { validateRoutingCatalog, type ModelRouterAdapter, type PeerInfo, type Router, type RoutingCatalogV1, type RoutingServiceTarget } from '@antseed/node'

const CATALOG_TIMEOUT_MS = 5_000

/** Plugin-provided router catalogs, cached per exact routing service. */
export class RoutingCatalogCache {
  private readonly queries = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always', gcTime: Infinity, structuralSharing: false } },
  })

  constructor(private readonly ttlMs = 60_000) {}

  async get(adapter: Pick<ModelRouterAdapter, 'getCatalog'> | Router, target: RoutingServiceTarget | undefined, peers: PeerInfo[]): Promise<{ catalog?: RoutingCatalogV1; expiresAt: number }> {
    const getCatalog = adapter.getCatalog
    if (!target || !getCatalog) return { expiresAt: Number.POSITIVE_INFINITY }
    const queryKey = key(target)
    const catalog = await this.queries.fetchQuery({
      queryKey, staleTime: this.ttlMs,
      queryFn: async () => {
        const result = await getCatalog.call(adapter, structuredClone(target), structuredClone(peers), AbortSignal.timeout(CATALOG_TIMEOUT_MS))
        if (result === undefined) return null
        validateRoutingCatalog(result)
        return structuredClone(result)
      },
    })
    const expiresAt = (this.queries.getQueryState(queryKey)?.dataUpdatedAt ?? Date.now()) + this.ttlMs
    return catalog ? { catalog: structuredClone(catalog), expiresAt } : { expiresAt }
  }

  invalidate(target: RoutingServiceTarget): void {
    this.queries.removeQueries({ queryKey: key(target), exact: true })
  }
}

function key(target: RoutingServiceTarget) {
  return ['routing-catalog', target.peerId, target.provider, target.serviceId] as const
}
