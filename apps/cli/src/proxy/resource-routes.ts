import { isNativeVideoProtocol, type NativeVideoProtocol } from '@antseed/api-adapter'

const ROUTE_TTL_MS = 30 * 24 * 60 * 60_000
const MAX_ROUTES = 10_000

export interface ResourceRoute {
  protocol: NativeVideoProtocol
  resourceId: string
  sellerPeerId: string
  provider: string
  service: string
  createdAt: number
}

export class ResourceRoutes {
  private routes = new Map<string, ResourceRoute>()

  constructor(private readonly now: () => number = Date.now) {}

  hydrate(value: unknown): void {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (entry && typeof entry.resourceId === 'string' && typeof entry.sellerPeerId === 'string'
        && typeof entry.provider === 'string' && typeof entry.service === 'string'
        && isNativeVideoProtocol(entry.protocol) && Number.isFinite(entry.createdAt)) {
        this.routes.set(routeKey(entry.protocol, entry.resourceId), entry)
      }
    }
    this.prune()
  }

  snapshot(): ResourceRoute[] {
    this.prune()
    return [...this.routes.values()]
  }

  record(route: Omit<ResourceRoute, 'createdAt'>): void {
    this.routes.set(routeKey(route.protocol, route.resourceId), { ...route, createdAt: this.now() })
    this.prune()
  }

  resolve(protocol: NativeVideoProtocol, resourceId: string): ResourceRoute | null {
    this.prune()
    return this.routes.get(routeKey(protocol, resourceId)) ?? null
  }

  private prune(): void {
    const cutoff = this.now() - ROUTE_TTL_MS
    for (const [key, route] of this.routes) {
      if (route.createdAt < cutoff) this.routes.delete(key)
    }
    for (const key of [...this.routes.keys()].slice(0, Math.max(0, this.routes.size - MAX_ROUTES))) {
      this.routes.delete(key)
    }
  }
}

function routeKey(protocol: NativeVideoProtocol, resourceId: string): string {
  return `${protocol}\n${resourceId}`
}
