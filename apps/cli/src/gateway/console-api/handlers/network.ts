/** Sellers the buyer knows about, and which of them a request would route to. */
import { resolvePolicy } from '../../policy-resolver.js'
import { buyerLimits, listNetworkPeers, previewRoute, type PreviewTarget } from '../../services/network.js'
import { canSeeWorkspace, requireOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import type { BuyerLimits, Peer, RoutePreview } from '../types.js'
import { defaultBuyerClient, type BuyerClient } from './network-buyer.js'

/** Seams for tests; production uses the defaults. */
export interface NetworkRouteOverrides {
  buyer?: BuyerClient
  canSeeWorkspace?: typeof canSeeWorkspace
  requireOrgAdmin?: typeof requireOrgAdmin
  resolvePolicy?: typeof resolvePolicy
}

function param(request: ConsoleRequest, name: string): string | undefined {
  const value = request.query.get(name)?.trim()
  return value ? value : undefined
}

export function registerNetworkRoutes(router: ConsoleRouter, deps: ConsoleDeps, overrides: NetworkRouteOverrides = {}): void {
  const buyer = overrides.buyer ?? defaultBuyerClient(deps)
  const canSee = overrides.canSeeWorkspace ?? canSeeWorkspace
  const orgAdmin = overrides.requireOrgAdmin ?? requireOrgAdmin
  const resolve = overrides.resolvePolicy ?? resolvePolicy

  router.add('GET', '/peers', async (): Promise<Peer[]> => listNetworkPeers(deps.store, buyer, deps.now()))

  /** Checks the caller may see the policy of every level it names. */
  const previewTarget = (request: ConsoleRequest): PreviewTarget => {
    const principal = request.principal
    const target: PreviewTarget = {
      keyId: param(request, 'key'),
      workspaceId: param(request, 'workspace'),
      memberId: param(request, 'member'),
      presetSlug: param(request, 'preset'),
    }
    if (principal?.kind === 'key') {
      if (target.keyId && target.keyId !== principal.keyId) throw new ConsoleError(403, 'forbidden', 'A key session can preview only its own key.')
      return { keyId: principal.keyId, ...(target.presetSlug ? { presetSlug: target.presetSlug } : {}) }
    }
    if (target.keyId) {
      const keyWorkspace = deps.store.workspaceForKey(target.keyId)?.id
      if (!keyWorkspace || !canSee(deps.store, principal, keyWorkspace)) throw new ConsoleError(404, 'not_found', 'Key not found.')
      if (target.workspaceId && target.workspaceId !== keyWorkspace) throw new ConsoleError(400, 'bad_request', 'That key belongs to another workspace.')
      target.workspaceId = keyWorkspace
    }
    if (target.workspaceId && !canSee(deps.store, principal, target.workspaceId)) {
      throw new ConsoleError(403, 'forbidden', 'You do not have access to this workspace.')
    }
    if (target.memberId && !(principal?.kind === 'member' && principal.memberId === target.memberId)) orgAdmin(principal)
    return Object.fromEntries(Object.entries(target).filter(([, value]) => value !== undefined)) as PreviewTarget
  }

  router.add('GET', '/route-preview', async (request): Promise<RoutePreview> => {
    const requested = param(request, 'model')
    if (!requested) throw new ConsoleError(400, 'bad_request', 'model is required.')
    return previewRoute(deps.store, buyer, requested, previewTarget(request), resolve, deps.configPath)
  }, { allow: ['member', 'token', 'key'] })

  /** The buyer's hard limits, which apply to every key whatever its policy. */
  router.add('GET', '/routing/buyer-limits', async (): Promise<BuyerLimits> => buyerLimits(deps.configPath, buyer),
    { allow: ['member', 'token', 'key'] })
}
