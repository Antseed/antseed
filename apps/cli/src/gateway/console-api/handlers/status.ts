import { buyerFetch } from '../../buyer-control.js'
import { readConsoleLocation } from '../../console-location.js'
import { detectExposure, detectHostFacts, type HostFacts } from '../../exposure.js'
import { isOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import type { ConsoleRouter, Principal } from '../router.js'
import type { GatewayExposure, GatewayStatus } from '../types.js'

/** The gateway's exposure, as the given caller may see it. */
export function gatewayExposure(deps: ConsoleDeps, principal: Principal | null, host: HostFacts): GatewayExposure {
  const saved = readConsoleLocation(deps.store)
  // A quick tunnel's URL is only known once it is up; `tunnel start` saves it then.
  const publicUrl = deps.publicUrl ?? saved?.publicUrl ?? null
  const listenHost = deps.listenHost ?? saved?.host ?? null
  const exposure = detectExposure({ publicUrl, listenHost, host })
  if (isOrgAdmin(deps.store, principal)) return exposure
  return { ...exposure, listenHost: null, reasons: [] }
}

/** `GET /status`: anyone signed in, API-key sessions included. */
export function registerStatusRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const host = deps.hostFacts ?? detectHostFacts()
  router.add('GET', '/status', async ({ principal }) => {
    let buyer: GatewayStatus['buyer'] = { reachable: false, peers: 0, dhtNodes: 0, uptimeMs: null }
    try {
      const response = await buyerFetch({ buyerPort: deps.buyerPort, secret: deps.controlSecret, timeoutMs: 2_000 }, '/_antseed/status')
      if (response.ok) {
        const status = await response.json() as { peerCount?: number; dhtNodeCount?: number; uptimeMs?: number }
        buyer = {
          reachable: true,
          peers: status.peerCount ?? 0,
          dhtNodes: status.dhtNodeCount ?? 0,
          uptimeMs: typeof status.uptimeMs === 'number' ? status.uptimeMs : null,
        }
      }
    } catch {
      // unreachable
    }
    const result: GatewayStatus = {
      version: deps.version,
      publicUrl: deps.publicUrl,
      buyer,
      spendFeed: deps.spendFeedState?.() ?? 'unknown',
      x402: deps.x402Enabled ?? false,
      exposure: gatewayExposure(deps, principal, host),
    }
    return result
  }, { allow: ['member', 'token', 'key'] })
}
