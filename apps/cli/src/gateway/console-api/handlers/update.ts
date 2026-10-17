import type { RootUpdateAction } from '../../../update/root-updater.js'
import type { GatewayUpdate } from '../types.js'
import { recordAudit } from '../../services/context.js'
import { createGatewayUpdates, type GatewayUpdates } from '../../updates.js'
import { requestActor, requireOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, respond, type ConsoleRouter } from '../router.js'

/**
 * Antseed updates (org admins and admin tokens). The gateway asks npm for
 * the latest @antseed/cli every 30 minutes. On a server set up by the
 * gateway installer, or in the desktop app, updating takes two clicks like
 * the desktop app's banner: `POST /update {"action":"download"}` fetches the
 * new version without touching the running one, then `POST /update`
 * (`install`) switches to it and restarts, so the console reconnects to the
 * new version. Elsewhere the console shows the command to run.
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
    const action = readAction(request.body)
    const before = updates.info()
    if (before.apply !== 'console') {
      throw new ConsoleError(409, 'update_unsupported', before.command
        ? `This gateway cannot update itself from the console. On its host, run: ${before.command}`
        : before.note)
    }
    if (!before.available && !inFlight(before)) throw new ConsoleError(409, 'up_to_date', `Antseed ${before.current} is already the latest version`)
    // Asking again for the step that is running is harmless; the other step waits for it.
    if (inFlight(before) && before.progress?.action !== action) {
      throw new ConsoleError(409, 'update_in_progress', before.progress?.action === 'download'
        ? 'The download is still running; restart once it is ready'
        : 'An update is installing; try again when it is done')
    }
    // Downloaded already: nothing to fetch until the next version is out.
    if (action === 'download' && before.progress?.state === 'ready' && before.progress.to === before.latest) return respond(202, before)
    const actor = requestActor(deps, request)
    const after = updates.apply(actor.actor.label ?? actor.actor.kind, action)
    // Only the step that restarts the gateway is audited.
    if (action === 'install' && !inFlight(before)) {
      recordAudit(deps, actor, 'gateway.update', { kind: 'settings', id: 'update', label: 'Antseed version' }, { from: before.current, to: before.progress?.state === 'ready' ? before.progress.to : before.latest })
    }
    return respond(202, after)
  })
}

function readAction(body: unknown): RootUpdateAction {
  const action = body && typeof body === 'object' ? (body as Record<string, unknown>)['action'] : undefined
  if (action === undefined || action === 'install') return 'install'
  if (action === 'download') return 'download'
  throw new ConsoleError(400, 'invalid_action', 'action must be "download" or "install"')
}

function inFlight(update: GatewayUpdate): boolean {
  return update.progress?.state === 'requested' || update.progress?.state === 'running'
}
