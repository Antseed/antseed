import { recordAudit } from '../../services/context.js'
import { createGatewayUpdates, type GatewayUpdates } from '../../updates.js'
import { requestActor, requireOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, respond, type ConsoleRouter } from '../router.js'

/**
 * Antseed updates (org admins and admin tokens). The gateway asks npm for
 * the latest @antseed/cli now and then; on a server set up by the gateway
 * installer `POST /update` hands the install to its root update service,
 * which restarts the buyer and the gateway, so the console reconnects to
 * the new version. Elsewhere the console shows the command to run.
 */
export function registerUpdateRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps
  const updates: GatewayUpdates = deps.updates ?? createGatewayUpdates({ dataDir: deps.dataDir, current: deps.version, log: deps.log })

  router.add('GET', '/update', async ({ principal }) => {
    requireOrgAdmin(principal, store)
    return updates.info()
  })

  router.add('POST', '/update/check', async ({ principal }) => {
    requireOrgAdmin(principal, store)
    return updates.check()
  })

  router.add('POST', '/update', async (request) => {
    requireOrgAdmin(request.principal, store)
    const before = updates.info()
    if (before.apply !== 'console') {
      throw new ConsoleError(409, 'update_unsupported', before.command
        ? `This gateway cannot update itself from the console. On its host, run: ${before.command}`
        : before.note)
    }
    if (!before.available && !inFlight(before)) throw new ConsoleError(409, 'up_to_date', `Antseed ${before.current} is already the latest version`)
    const actor = requestActor(deps, request)
    const after = updates.apply(actor.actor.label ?? actor.actor.kind)
    if (!inFlight(before)) {
      recordAudit(deps, actor, 'gateway.update', { kind: 'settings', id: 'update', label: 'Antseed version' }, { from: before.current, to: before.latest })
    }
    return respond(202, after)
  })
}

function inFlight(update: { progress: { state: string } | null }): boolean {
  return update.progress?.state === 'requested' || update.progress?.state === 'running'
}
