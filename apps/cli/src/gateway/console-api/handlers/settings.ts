import { readSettings as readSettingsService, setObservabilitySettings, updateBuyerSettings } from '../../services/settings.js'
import { requestActor, requireOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import type { ConsoleRouter, Principal } from '../router.js'
import type { Settings } from '../types.js'
import { defaultBuyerClient } from './network-buyer.js'

/**
 * OTLP header values can be credentials: only org-admin sessions read them;
 * management tokens (read scope included) see them masked.
 */
async function readSettings(deps: ConsoleDeps, principal: Principal | null = null): Promise<Settings> {
  return readSettingsService(deps, { revealSecrets: principal?.kind === 'member' })
}

/**
 * Settings (org admins; `GET /status` lives in status.ts); rules in
 * `services/settings.ts`. Changing the buyer settings rewrites the config
 * file in place and asks the buyer to restart (`POST /_antseed/restart`).
 */
export function registerSettingsRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  router.add('GET', '/settings', async ({ principal }) => {
    requireOrgAdmin(principal, store)
    return readSettings(deps, principal)
  })

  router.add('PATCH', '/settings/buyer', async (request) => {
    const { principal, body } = request
    requireOrgAdmin(principal, store)
    const { restartRequired } = await updateBuyerSettings(deps, requestActor(deps, request), body, defaultBuyerClient(deps))
    const settings = await readSettings(deps, principal)
    return restartRequired ? { ...settings, restartRequired: true } : settings
  })

  router.add('PUT', '/settings/observability', async (request) => {
    const { principal, body } = request
    requireOrgAdmin(principal, store)
    setObservabilitySettings(deps, requestActor(deps, request), body, { mayChangeDestination: principal?.kind === 'member' })
    return readSettings(deps, principal)
  })
}
