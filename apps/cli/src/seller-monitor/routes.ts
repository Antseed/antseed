import { requestActor, requireOrgAdmin } from '../gateway/console-api/access.js'
import type { ConsoleDeps } from '../gateway/console-api/deps.js'
import type { ConsoleRegistrar } from '../gateway/console-api/server.js'
import { ConsoleError, respond, type ConsoleRequest, type Principal } from '../gateway/console-api/router.js'
import { recordAudit } from '../gateway/services/context.js'
import { SellerMonitor, type SellerMonitorOptions } from './service.js'

function boundedInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

export interface SellerRouteOptions extends Omit<SellerMonitorOptions, 'version' | 'network'> {
  /** Where the market and trust views get the network (the gateway passes its own buyer). */
  network?: (deps: ConsoleDeps) => SellerMonitorOptions['network']
}

/**
 * `/seller/*`: the SellerMonitor service behind access control. Org admins
 * (and management tokens) only, since it shows the host's seller wallet and
 * revenue and edits its config. Writes are audited when the gateway store is
 * there (the gateway console; the seller dashboard has no audit log). All
 * logic lives in SellerMonitor, shared with the `antseed seller` commands.
 */
export function sellerRouteRegistrar(options: SellerRouteOptions): ConsoleRegistrar {
  return (router, deps) => {
    const { network, ...rest } = options
    const monitor = new SellerMonitor({ ...rest, version: deps.version, ...(network ? { network: network(deps) } : {}) })
    const admin = (principal: Principal | null) => requireOrgAdmin(principal, deps.store)
    const audit = (request: ConsoleRequest, action: string, details: Record<string, unknown>) => {
      if (!deps.store) return
      recordAudit(deps as ConsoleDeps, requestActor(deps, request), action, { kind: 'settings', id: 'seller', label: 'Seller settings' }, details)
    }
    const refresh = (query: URLSearchParams) => query.get('refresh') === '1'

    router.add('GET', '/seller/status', async ({ principal }) => {
      admin(principal)
      const status = await monitor.status()
      return status.available ? { ...status, rpc: await monitor.rpcDiagnostics() } : status
    })
    router.add('GET', '/seller/events', async ({ principal, query }) => { admin(principal); return { events: await monitor.events(boundedInt(query.get('limit'), 100, 500)) } })
    router.add('GET', '/seller/usage', async ({ principal, query }) => { admin(principal); return monitor.usage(boundedInt(query.get('days'), 14, 30)) })
    router.add('GET', '/seller/logs', async ({ principal, query }) => {
      admin(principal)
      const from = Number(query.get('from'))
      return monitor.logs({
        cursor: query.get('cursor'),
        limit: boundedInt(query.get('limit'), 50, 200),
        service: query.get('service'),
        buyer: query.get('buyer'),
        from: Number.isFinite(from) && from > 0 ? from : null,
        errorsOnly: query.get('errors') === '1',
      })
    })

    router.add('GET', '/seller/logs/:id', async ({ principal, params }) => {
      admin(principal)
      const entry = monitor.logDetail(params.id!)
      if (!entry) throw new ConsoleError(404, 'not_found', 'No request with this id.')
      return entry
    })

    router.add('GET', '/seller/settings', async ({ principal }) => { admin(principal); return monitor.settings() })
    router.add('PATCH', '/seller/settings', async (request) => {
      admin(request.principal)
      const result = await monitor.updateSettings(request.body)
      if (result.changed.length > 0) audit(request, 'seller.settings.update', { fields: result.changed })
      return result
    })
    router.add('PATCH', '/seller/alerts', async (request) => {
      admin(request.principal)
      const result = await monitor.updateAlerts(request.body)
      if (Object.keys(result.changed).length > 0) audit(request, 'seller.alerts.update', result.changed)
      return { ...result, changed: Object.keys(result.changed) }
    })
    router.add('POST', '/seller/alerts/test', async (request) => {
      admin(request.principal)
      const channel = (request.body as { channel?: unknown } | undefined)?.channel
      if (channel !== 'telegram' && channel !== 'webhook') throw new ConsoleError(400, 'invalid_request', 'channel must be telegram or webhook')
      const result = await monitor.testAlert(channel)
      audit(request, 'seller.alerts.test', { channel, sent: result.sent.length > 0 })
      return result
    })
    router.add('POST', '/seller/alerts/telegram/chats', async (request) => {
      admin(request.principal)
      const token = (request.body as { botToken?: unknown } | undefined)?.botToken
      return { chats: await monitor.telegramChats(typeof token === 'string' ? token : null) }
    })

    router.add('GET', '/seller/market', async ({ principal, query }) => { admin(principal); return monitor.market({ refresh: refresh(query) }) })
    router.add('GET', '/seller/reputation', async ({ principal, query }) => { admin(principal); return monitor.reputation({ refresh: refresh(query) }) })
    router.add('GET', '/seller/promote', async ({ principal }) => { admin(principal); return monitor.promote() })
    router.add('GET', '/seller/promote/card', async ({ principal }) => { admin(principal); return respond(200, await monitor.card(), { contentType: 'image/svg+xml; charset=utf-8' }) })
    router.add('POST', '/seller/promote/check', async ({ principal }) => { admin(principal); return monitor.checkVerifications() })
    router.add('PUT', '/seller/promote/verifications', async (request) => {
      admin(request.principal)
      const result = await monitor.saveVerifications(request.body)
      audit(request, 'seller.verifications.update', { domains: result.domains.length, github: result.github.length })
      return result
    })
  }
}
