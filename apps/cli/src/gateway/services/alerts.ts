/**
 * A workspace's alert setup: its thresholds and where alerts go. Validates
 * and audits; the console handler checks who may call (workspace admins).
 * Secrets (a webhook's signing secret, a Telegram bot token) are stored for
 * sending and never returned in full; a signing secret is shown once.
 */
import { randomBytes } from 'node:crypto'
import { redact } from '../../proxy/chain-rpc.js'
import { emailRecipients } from '../alerts/channels.js'
import { badRequest, notFound } from '../console-api/serialize.js'
import type {
  AlertDelivery, AlertDestination, AlertDestinationCreated, AlertDestinationInput, AlertSettings, AlertSettingsInput,
} from '../console-api/types.js'
import { optionalUsdcToDecimalString, parseUsdToUsdc } from '../money.js'
import type { AlertDestinationKind, AlertDestinationRecord, AlertEventGroup, AlertSettingsRecord, WorkspaceRecord } from '../store.js'
import { recordAudit, requiredText, type Actor, type ServiceContext } from './context.js'

export const MAX_ALERT_DESTINATIONS = 20
const KINDS: readonly AlertDestinationKind[] = ['webhook', 'telegram', 'email']
const GROUPS: readonly AlertEventGroup[] = ['balance', 'limits', 'gateway']
const MAX_EMAILS = 10
const SIGNING_SECRET_PREFIX = 'whsec_'

export function alertSettingsView(record: AlertSettingsRecord): AlertSettings {
  return {
    lowBalance: optionalUsdcToDecimalString(record.lowBalanceUsdc),
    topupTarget: optionalUsdcToDecimalString(record.topupTargetUsdc),
    limitWarnPercent: record.limitWarnPercent,
    repeatMinutes: record.repeatMinutes,
  }
}

export function alertDestinationView(record: AlertDestinationRecord): AlertDestination {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    target: record.kind === 'webhook' ? redact(record.target) : record.target,
    secretHint: record.secret ? `…${record.secret.slice(-4)}` : null,
    events: record.events,
    enabled: record.enabled,
    createdAt: record.createdAt,
    lastSentAt: record.lastSentAt,
    lastError: record.lastError,
  }
}

export function alertDeliveryView(record: { id: number; destinationId: string; eventType: string; summary: string; ok: boolean; error: string | null; at: number }): AlertDelivery {
  return { id: record.id, destinationId: record.destinationId, eventType: record.eventType, summary: record.summary, ok: record.ok, error: record.error, at: record.at }
}

function usdOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${field} must be a USD amount`)
  try {
    return parseUsdToUsdc(String(value))
  } catch (error) {
    throw badRequest(`${field}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function intOrNull(value: unknown, field: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be a whole number from ${min} to ${max}`)
  }
  return value
}

export function updateAlertSettings(ctx: ServiceContext, actor: Actor, workspace: WorkspaceRecord, input: Partial<AlertSettingsInput>): AlertSettings {
  const lowBalanceUsdc = usdOrNull(input.lowBalanceUsd, 'lowBalanceUsd')
  const topupTargetUsdc = usdOrNull(input.topupTargetUsd, 'topupTargetUsd')
  if (lowBalanceUsdc === 0) throw badRequest('lowBalanceUsd must be more than 0, or empty to turn it off')
  if (topupTargetUsdc !== null && lowBalanceUsdc !== null && topupTargetUsdc <= lowBalanceUsdc) {
    throw badRequest('topupTargetUsd must be more than lowBalanceUsd')
  }
  const saved = ctx.store.setAlertSettings(workspace.id, {
    lowBalanceUsdc,
    topupTargetUsdc,
    limitWarnPercent: intOrNull(input.limitWarnPercent, 'limitWarnPercent', 1, 99),
    repeatMinutes: intOrNull(input.repeatMinutes, 'repeatMinutes', 5, 10_080),
  })
  const view = alertSettingsView(saved)
  recordAudit(ctx, actor, 'alerts.settings.update', { kind: 'workspace', id: workspace.id, label: workspace.name }, { ...view })
  return view
}

function cleanEvents(value: unknown): AlertEventGroup[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && (GROUPS as readonly string[]).includes(item))) {
    throw badRequest(`events must be a list of ${GROUPS.join(', ')}`)
  }
  const events = [...new Set(value as AlertEventGroup[])]
  if (events.length === 0) throw badRequest('Choose at least one kind of alert')
  return events
}

function cleanTarget(kind: AlertDestinationKind, value: unknown): string {
  if (typeof value !== 'string') throw badRequest('target is required')
  const target = requiredText(value, 'target', 2_000)
  if (kind === 'webhook') {
    let url: URL
    try {
      url = new URL(target)
    } catch {
      throw badRequest('The webhook URL is not valid')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('The webhook URL must start with https:// or http://')
    return url.toString()
  }
  if (kind === 'telegram') {
    // A numeric chat id (groups are negative) or a public @channel name.
    if (!/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,63})$/.test(target)) throw badRequest('The Telegram chat id is a number (e.g. -1001234567890) or an @channel name')
    return target
  }
  const emails = emailRecipients(target)
  if (emails.length === 0) throw badRequest('Enter at least one email address')
  if (emails.length > MAX_EMAILS) throw badRequest(`At most ${MAX_EMAILS} email addresses`)
  for (const email of emails) {
    if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email)) throw badRequest(`"${email}" is not an email address`)
  }
  return emails.join(', ')
}

function cleanBotToken(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/.test(value.trim())) {
    throw badRequest('The Telegram bot token looks like 123456789:AA… (from @BotFather)')
  }
  return value.trim()
}

function newSigningSecret(): string {
  return `${SIGNING_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`
}

function auditTarget(destination: AlertDestinationRecord) {
  return { kind: 'alert_destination', id: destination.id, label: destination.label }
}

export function findAlertDestination(ctx: ServiceContext, workspace: WorkspaceRecord, id: string): AlertDestinationRecord {
  const found = ctx.store.getAlertDestination(id)
  if (!found || found.workspaceId !== workspace.id) throw notFound('Alert destination')
  return found
}

export function createAlertDestination(ctx: ServiceContext, actor: Actor, workspace: WorkspaceRecord, input: Partial<AlertDestinationInput>): AlertDestinationCreated {
  const kind = input.kind
  if (!kind || !KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`)
  if (ctx.store.countAlertDestinations(workspace.id) >= MAX_ALERT_DESTINATIONS) {
    throw badRequest(`A workspace has at most ${MAX_ALERT_DESTINATIONS} alert destinations`)
  }
  const label = requiredText(typeof input.label === 'string' ? input.label : '', 'label', 100)
  const target = cleanTarget(kind, input.target)
  const signingSecret = kind === 'webhook' ? newSigningSecret() : null
  const secret = kind === 'telegram' ? cleanBotToken(input.botToken) : signingSecret
  const created = ctx.store.createAlertDestination({
    workspaceId: workspace.id, kind, label, target, secret, events: cleanEvents(input.events), enabled: input.enabled !== false,
  })
  recordAudit(ctx, actor, 'alerts.destination.create', auditTarget(created), { workspaceId: workspace.id, kind, events: created.events })
  return { destination: alertDestinationView(created), signingSecret }
}

export function updateAlertDestination(ctx: ServiceContext, actor: Actor, workspace: WorkspaceRecord, id: string, input: Partial<AlertDestinationInput>): AlertDestination {
  const current = findAlertDestination(ctx, workspace, id)
  if (input.kind !== undefined && input.kind !== current.kind) throw badRequest('The kind of a destination cannot change; add a new one')
  const patch: Parameters<typeof ctx.store.updateAlertDestination>[1] = {}
  if (input.label !== undefined) patch.label = requiredText(typeof input.label === 'string' ? input.label : '', 'label', 100)
  if (input.target !== undefined) patch.target = cleanTarget(current.kind, input.target)
  if (input.events !== undefined) patch.events = cleanEvents(input.events)
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false')
    patch.enabled = input.enabled
  }
  if (input.botToken !== undefined && input.botToken !== '') {
    if (current.kind !== 'telegram') throw badRequest('Only Telegram destinations take a bot token')
    patch.secret = cleanBotToken(input.botToken)
  }
  const updated = ctx.store.updateAlertDestination(id, patch)
  recordAudit(ctx, actor, 'alerts.destination.update', auditTarget(updated), {
    workspaceId: workspace.id,
    changed: Object.keys(patch).map((field) => (field === 'secret' ? 'botToken' : field)),
  })
  return alertDestinationView(updated)
}

export function rotateAlertSigningSecret(ctx: ServiceContext, actor: Actor, workspace: WorkspaceRecord, id: string): AlertDestinationCreated {
  const current = findAlertDestination(ctx, workspace, id)
  if (current.kind !== 'webhook') throw badRequest('Only webhooks have a signing secret')
  const signingSecret = newSigningSecret()
  const updated = ctx.store.updateAlertDestination(id, { secret: signingSecret })
  recordAudit(ctx, actor, 'alerts.destination.rotate_secret', auditTarget(updated), { workspaceId: workspace.id })
  return { destination: alertDestinationView(updated), signingSecret }
}

export function deleteAlertDestination(ctx: ServiceContext, actor: Actor, workspace: WorkspaceRecord, id: string): void {
  const current = findAlertDestination(ctx, workspace, id)
  ctx.store.deleteAlertDestination(id)
  recordAudit(ctx, actor, 'alerts.destination.delete', auditTarget(current), { workspaceId: workspace.id, kind: current.kind })
}
