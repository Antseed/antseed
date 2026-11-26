import type { AlertDestinationInput, AlertDestinationKind, AlertEventGroup, AlertSettings, AlertSettingsInput } from '../api/types'

export const ALERT_GROUPS: Array<{ id: AlertEventGroup; label: string; description: string }> = [
  { id: 'balance', label: 'Credits', description: 'Credits below the threshold, requests refused for lack of credits, and topped up again.' },
  { id: 'limits', label: 'Spend limits', description: 'A key, member or workspace spend limit near its warning percent or reached.' },
  { id: 'gateway', label: 'Spend tracking', description: 'The gateway cannot read spend from its buyer, so capped keys are refused.' },
]

export const KIND_LABELS: Record<AlertDestinationKind, string> = { webhook: 'Webhook', telegram: 'Telegram', email: 'Email' }

export const REPEAT_OPTIONS = [
  { value: '', label: 'Never: once per incident' },
  { value: '60', label: 'Every hour' },
  { value: '360', label: 'Every 6 hours' },
  { value: '1440', label: 'Every day' },
]

/** The settings form, as typed: USD amounts and numbers as strings, '' for off. */
export interface AlertSettingsDraft {
  lowBalanceUsd: string
  topupTargetUsd: string
  limitWarnPercent: string
  repeatMinutes: string
}

/** "10.000000" → "10", "12.500000" → "12.5". */
function trimUsd(value: string | null): string {
  if (value === null) return ''
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

export function alertSettingsDraft(settings: AlertSettings): AlertSettingsDraft {
  return {
    lowBalanceUsd: trimUsd(settings.lowBalance),
    topupTargetUsd: trimUsd(settings.topupTarget),
    limitWarnPercent: settings.limitWarnPercent === null ? '' : String(settings.limitWarnPercent),
    repeatMinutes: settings.repeatMinutes === null ? '' : String(settings.repeatMinutes),
  }
}

const USD = /^\$?\d+(\.\d{1,6})?$/

/** Field errors of a draft; empty when it can be saved. */
export function alertSettingsErrors(draft: AlertSettingsDraft): Partial<Record<keyof AlertSettingsDraft, string>> {
  const errors: Partial<Record<keyof AlertSettingsDraft, string>> = {}
  const low = draft.lowBalanceUsd.trim()
  const target = draft.topupTargetUsd.trim()
  if (low && (!USD.test(low) || Number(low.replace('$', '')) <= 0)) errors.lowBalanceUsd = 'A dollar amount above 0, e.g. 10'
  if (target && !USD.test(target)) errors.topupTargetUsd = 'A dollar amount, e.g. 50'
  else if (target && low && !errors.lowBalanceUsd && Number(target.replace('$', '')) <= Number(low.replace('$', ''))) errors.topupTargetUsd = 'More than the low-credits threshold'
  const percent = draft.limitWarnPercent.trim()
  if (percent && (!/^\d+$/.test(percent) || Number(percent) < 1 || Number(percent) > 99)) errors.limitWarnPercent = 'A whole percent from 1 to 99'
  return errors
}

export function alertSettingsInput(draft: AlertSettingsDraft): AlertSettingsInput {
  const usd = (value: string) => (value.trim() ? value.trim().replace(/^\$/, '') : null)
  return {
    lowBalanceUsd: usd(draft.lowBalanceUsd),
    topupTargetUsd: usd(draft.topupTargetUsd),
    limitWarnPercent: draft.limitWarnPercent.trim() ? Number(draft.limitWarnPercent) : null,
    repeatMinutes: draft.repeatMinutes ? Number(draft.repeatMinutes) : null,
  }
}

/** The destination form. Editing leaves `target` empty for a webhook (its saved URL is masked) and the bot token empty to keep them. */
export interface DestinationDraft {
  kind: AlertDestinationKind
  label: string
  target: string
  botToken: string
  events: AlertEventGroup[]
}

export const EMPTY_DESTINATION: DestinationDraft = { kind: 'webhook', label: '', target: '', botToken: '', events: ['balance', 'limits'] }

/** What a new destination sends; the bot token only for Telegram. */
export function newDestinationInput(draft: DestinationDraft): AlertDestinationInput {
  return {
    kind: draft.kind,
    label: draft.label.trim(),
    target: draft.target.trim(),
    events: draft.events,
    ...(draft.kind === 'telegram' ? { botToken: draft.botToken.trim() } : {}),
  }
}

/** What an edit changed; a blank URL or bot token keeps the saved one. */
export function destinationChanges(draft: DestinationDraft, editing: { target: string; label: string; events: AlertEventGroup[] }): Partial<AlertDestinationInput> {
  const changes: Partial<AlertDestinationInput> = {}
  if (draft.label.trim() !== editing.label) changes.label = draft.label.trim()
  const target = draft.target.trim()
  if (target && target !== editing.target) changes.target = target
  if (draft.botToken.trim()) changes.botToken = draft.botToken.trim()
  if ([...draft.events].sort().join() !== [...editing.events].sort().join()) changes.events = draft.events
  return changes
}

export function destinationReady(draft: DestinationDraft, editing: boolean): boolean {
  if (!draft.label.trim() || draft.events.length === 0) return false
  if (editing) return true
  if (!draft.target.trim()) return false
  return draft.kind !== 'telegram' || draft.botToken.trim() !== ''
}

export const TARGET_FIELD: Record<AlertDestinationKind, { label: string; placeholder: string; hint: string }> = {
  webhook: {
    label: 'URL',
    placeholder: 'https://example.com/hooks/antseed',
    hint: 'Gets a signed JSON POST for each alert. Point it at a script that tops up the workspace wallet to automate deposits.',
  },
  telegram: {
    label: 'Chat id',
    placeholder: '-1001234567890',
    hint: 'The chat, group or @channel the bot posts to. Add the bot to the chat first.',
  },
  email: {
    label: 'Email addresses',
    placeholder: 'ops@example.com, finance@example.com',
    hint: 'Up to 10, separated by commas.',
  },
}

/** How a receiver checks a webhook's signature, shown with the signing secret. */
export const WEBHOOK_VERIFY_SNIPPET = `// x-antseed-signature: t=<unix seconds>,v1=<hex>
const [t, v1] = header.split(',').map((part) => part.split('=')[1])
const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(\`\${t}.\${rawBody}\`).digest('hex')
const valid = crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300`
