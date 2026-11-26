import type { AlertDelivery, AlertDestination, AlertDestinationCreated, AlertsConfig, AlertSettings } from '../api/types'

const HOUR = 3_600_000
const settings = new Map<string, AlertSettings>()
const destinations = new Map<string, AlertDestination[]>()
const deliveries = new Map<string, AlertDelivery[]>()
let counter = 0

function seed(workspaceId: string): void {
  if (destinations.has(workspaceId)) return
  const now = Date.now()
  settings.set(workspaceId, workspaceId === 'ws_default'
    ? { lowBalance: '10.000000', topupTarget: '50.000000', limitWarnPercent: 80, repeatMinutes: null }
    : { lowBalance: null, topupTarget: null, limitWarnPercent: null, repeatMinutes: null })
  if (workspaceId !== 'ws_default') {
    destinations.set(workspaceId, [])
    deliveries.set(workspaceId, [])
    return
  }
  destinations.set(workspaceId, [
    { id: 'ad_topup', kind: 'webhook', label: 'Auto top-up', target: 'https://hooks.example.com/…', secretHint: '…f3Qa', events: ['balance'], enabled: true, createdAt: now - 30 * 24 * HOUR, lastSentAt: now - 5 * HOUR, lastError: null },
    { id: 'ad_ops', kind: 'telegram', label: 'Ops chat', target: '-1001234567890', secretHint: '…kkll', events: ['balance', 'limits', 'gateway'], enabled: true, createdAt: now - 20 * 24 * HOUR, lastSentAt: now - 5 * HOUR, lastError: null },
    { id: 'ad_finance', kind: 'email', label: 'Finance', target: 'finance@example.com', secretHint: null, events: ['balance'], enabled: false, createdAt: now - 10 * 24 * HOUR, lastSentAt: null, lastError: 'The email could not be sent: connection refused' },
  ])
  deliveries.set(workspaceId, [
    { id: 4, destinationId: 'ad_ops', eventType: 'limit.near', summary: 'Default: API key “CI” is near its daily spend limit', ok: true, error: null, at: now - 5 * HOUR },
    { id: 3, destinationId: 'ad_topup', eventType: 'balance.low', summary: 'Default: credits are low', ok: true, error: null, at: now - 26 * HOUR },
    { id: 2, destinationId: 'ad_topup', eventType: 'balance.low', summary: 'Default: credits are low', ok: false, error: 'The webhook answered HTTP 502.', at: now - 26 * HOUR - 30_000 },
    { id: 1, destinationId: 'ad_ops', eventType: 'balance.low', summary: 'Default: credits are low', ok: true, error: null, at: now - 26 * HOUR - 30_000 },
  ])
}

export function mockAlerts(workspaceId: string): AlertsConfig {
  seed(workspaceId)
  return { settings: settings.get(workspaceId)!, destinations: destinations.get(workspaceId)!, emailAvailable: true }
}

export function mockSaveAlertSettings(workspaceId: string, body: Record<string, unknown>): AlertSettings {
  seed(workspaceId)
  const usd = (value: unknown) => (typeof value === 'string' && value ? Number(value).toFixed(6) : null)
  const next: AlertSettings = {
    lowBalance: usd(body['lowBalanceUsd']),
    topupTarget: usd(body['topupTargetUsd']),
    limitWarnPercent: typeof body['limitWarnPercent'] === 'number' ? body['limitWarnPercent'] : null,
    repeatMinutes: typeof body['repeatMinutes'] === 'number' ? body['repeatMinutes'] : null,
  }
  settings.set(workspaceId, next)
  return next
}

export function mockCreateAlertDestination(workspaceId: string, body: Record<string, unknown>): AlertDestinationCreated {
  seed(workspaceId)
  const kind = body['kind'] as AlertDestination['kind']
  const target = String(body['target'] ?? '')
  const signingSecret = kind === 'webhook' ? `whsec_mock${Math.random().toString(36).slice(2, 14)}` : null
  const destination: AlertDestination = {
    id: `ad_${++counter}`, kind, label: String(body['label'] ?? ''),
    target: kind === 'webhook' ? `${new URL(target).origin}/…` : target,
    secretHint: kind === 'webhook' ? `…${signingSecret!.slice(-4)}` : kind === 'telegram' ? `…${String(body['botToken'] ?? '').slice(-4)}` : null,
    events: body['events'] as AlertDestination['events'], enabled: true, createdAt: Date.now(), lastSentAt: null, lastError: null,
  }
  destinations.get(workspaceId)!.push(destination)
  return { destination, signingSecret }
}

function findDestination(workspaceId: string, id: string): AlertDestination {
  const destination = mockAlerts(workspaceId).destinations.find((entry) => entry.id === id)
  if (!destination) throw new Error('not found')
  return destination
}

export function mockUpdateAlertDestination(workspaceId: string, id: string, body: Record<string, unknown>): AlertDestination {
  const destination = findDestination(workspaceId, id)
  if (typeof body['label'] === 'string') destination.label = body['label']
  if (Array.isArray(body['events'])) destination.events = body['events'] as AlertDestination['events']
  if (typeof body['enabled'] === 'boolean') destination.enabled = body['enabled']
  if (typeof body['target'] === 'string') destination.target = destination.kind === 'webhook' ? `${new URL(body['target']).origin}/…` : body['target']
  return destination
}

export function mockRotateAlertSecret(workspaceId: string, id: string): AlertDestinationCreated {
  const destination = findDestination(workspaceId, id)
  const signingSecret = `whsec_mock${Math.random().toString(36).slice(2, 14)}`
  destination.secretHint = `…${signingSecret.slice(-4)}`
  return { destination, signingSecret }
}

export function mockTestAlertDestination(workspaceId: string, id: string): { ok: boolean; error: string | null } {
  const destination = findDestination(workspaceId, id)
  const ok = destination.kind !== 'email'
  const error = ok ? null : 'The email could not be sent: connection refused'
  destination.lastError = error
  if (ok) destination.lastSentAt = Date.now()
  deliveries.get(workspaceId)!.unshift({ id: 100 + ++counter, destinationId: id, eventType: 'test', summary: 'Test alert', ok, error, at: Date.now() })
  return { ok, error }
}

export function mockDeleteAlertDestination(workspaceId: string, id: string): { ok: true } {
  seed(workspaceId)
  destinations.set(workspaceId, destinations.get(workspaceId)!.filter((entry) => entry.id !== id))
  return { ok: true }
}

export function mockAlertDeliveries(workspaceId: string): AlertDelivery[] {
  seed(workspaceId)
  return deliveries.get(workspaceId)!
}
