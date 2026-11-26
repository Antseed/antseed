/**
 * A workspace's alerts (rules in `services/alerts.ts`, sending in `alerts/`).
 * Workspace admins only: destinations carry webhook URLs and bot tokens.
 */
import { emailConfigured } from '../../alerts/channels.js'
import {
  alertDeliveryView, alertDestinationView, alertSettingsView, createAlertDestination, deleteAlertDestination,
  findAlertDestination, rotateAlertSigningSecret, updateAlertDestination, updateAlertSettings,
} from '../../services/alerts.js'
import { requestActor, requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, respond, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import { asObject } from '../serialize.js'
import type { AlertDelivery, AlertDestination, AlertDestinationCreated, AlertDestinationInput, AlertsConfig, AlertSettings, AlertSettingsInput, AlertTestResult } from '../types.js'

export function registerAlertRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  const workspace = (request: ConsoleRequest) => {
    const id = request.params['id'] ?? ''
    requireWorkspaceAccess(store, request.principal, id, 'admin')
    const found = store.getWorkspace(id)
    if (!found) throw new ConsoleError(404, 'not_found', 'Workspace not found.')
    return found
  }

  router.add('GET', '/workspaces/:id/alerts', async (request): Promise<AlertsConfig> => {
    const ws = workspace(request)
    return {
      settings: alertSettingsView(store.getAlertSettings(ws.id)),
      destinations: store.listAlertDestinations(ws.id).map(alertDestinationView),
      emailAvailable: deps.alerts ? deps.alerts.emailConfigured() : emailConfigured(process.env),
    }
  })

  router.add('PUT', '/workspaces/:id/alerts/settings', async (request): Promise<AlertSettings> => {
    const ws = workspace(request)
    return updateAlertSettings(deps, requestActor(deps, request), ws, asObject(request.body) as Partial<AlertSettingsInput>)
  })

  router.add('POST', '/workspaces/:id/alerts/destinations', async (request) => {
    const ws = workspace(request)
    const created: AlertDestinationCreated = createAlertDestination(deps, requestActor(deps, request), ws, asObject(request.body) as Partial<AlertDestinationInput>)
    return respond(201, created)
  })

  router.add('PATCH', '/workspaces/:id/alerts/destinations/:dest', async (request): Promise<AlertDestination> => {
    const ws = workspace(request)
    return updateAlertDestination(deps, requestActor(deps, request), ws, request.params['dest'] ?? '', asObject(request.body) as Partial<AlertDestinationInput>)
  })

  router.add('POST', '/workspaces/:id/alerts/destinations/:dest/rotate-secret', async (request): Promise<AlertDestinationCreated> => {
    const ws = workspace(request)
    return rotateAlertSigningSecret(deps, requestActor(deps, request), ws, request.params['dest'] ?? '')
  })

  router.add('POST', '/workspaces/:id/alerts/destinations/:dest/test', async (request): Promise<AlertTestResult> => {
    const ws = workspace(request)
    const destination = findAlertDestination(deps, ws, request.params['dest'] ?? '')
    if (!deps.alerts) throw new ConsoleError(503, 'alerts_unavailable', 'Alerts are not running in this gateway.')
    return deps.alerts.sendTest(destination)
  })

  router.add('DELETE', '/workspaces/:id/alerts/destinations/:dest', async (request): Promise<{ ok: true }> => {
    const ws = workspace(request)
    deleteAlertDestination(deps, requestActor(deps, request), ws, request.params['dest'] ?? '')
    return { ok: true }
  })

  router.add('GET', '/workspaces/:id/alerts/deliveries', async (request): Promise<AlertDelivery[]> => {
    const ws = workspace(request)
    return store.listAlertDeliveries(ws.id).map(alertDeliveryView)
  })
}
