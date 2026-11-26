/**
 * The alerts a workspace can receive, and the words and data each one carries.
 * `data` is part of the webhook contract (snake_case, USD as exact decimal
 * strings), so a receiver can act on it: top up the wallet, page someone.
 */
import { randomUUID } from 'node:crypto'
import { formatUsdc, usdcToDecimalString } from '../money.js'
import type { BudgetLevel, BudgetPeriod } from '../limits.js'
import type { AlertEventGroup } from '../store.js'

export type AlertEventType =
  | 'balance.low'
  | 'balance.empty'
  | 'balance.ok'
  | 'limit.near'
  | 'limit.reached'
  | 'spend_tracking.down'
  | 'spend_tracking.ok'
  | 'test'

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface AlertEvent {
  /** Unique per alert (resends keep it), so a receiver can drop duplicates. */
  id: string
  type: AlertEventType
  /** Which subscription it goes to; null for a test, which goes only to the destination tested. */
  group: AlertEventGroup | null
  severity: AlertSeverity
  createdAt: number
  workspace: { id: string; name: string }
  title: string
  message: string
  data: Record<string, unknown>
}

export const ALERT_EVENT_GROUPS: Record<AlertEventGroup, AlertEventType[]> = {
  balance: ['balance.low', 'balance.empty', 'balance.ok'],
  limits: ['limit.near', 'limit.reached'],
  gateway: ['spend_tracking.down', 'spend_tracking.ok'],
}

type Workspace = { id: string; name: string }

function base(type: AlertEventType, group: AlertEventGroup | null, severity: AlertSeverity, workspace: Workspace, now: number): Omit<AlertEvent, 'title' | 'message' | 'data'> {
  return { id: `evt_${randomUUID()}`, type, group, severity, createdAt: now, workspace: { id: workspace.id, name: workspace.name } }
}

const usd = (amount: number | null): string | null => (amount === null ? null : usdcToDecimalString(amount))

export interface BalanceFacts {
  walletAddress: string | null
  availableUsdc: number
  /** USDC in the wallet itself, not yet moved into the credits; null when unread. */
  walletUsdc: number | null
  thresholdUsdc: number | null
  topupTargetUsdc: number | null
  consoleUrl: string | null
}

/** What a top-up should add: up to the target when one is set, else back over the threshold. */
export function suggestedTopup(facts: Pick<BalanceFacts, 'availableUsdc' | 'thresholdUsdc' | 'topupTargetUsdc'>): number | null {
  const goal = facts.topupTargetUsdc ?? facts.thresholdUsdc
  if (goal === null) return null
  return Math.max(0, goal - Math.max(0, facts.availableUsdc))
}

function balanceData(facts: BalanceFacts): Record<string, unknown> {
  return {
    wallet_address: facts.walletAddress,
    available_usd: usd(facts.availableUsdc),
    wallet_usd: usd(facts.walletUsdc),
    threshold_usd: usd(facts.thresholdUsdc),
    topup_target_usd: usd(facts.topupTargetUsdc),
    suggested_topup_usd: usd(suggestedTopup(facts)),
    ...(facts.consoleUrl ? { console_url: facts.consoleUrl } : {}),
  }
}

/** What to do about low credits: how much to add, where to send it, and USDC already on its way in. */
function topupSentence(facts: BalanceFacts): string {
  const parts: string[] = []
  const topup = suggestedTopup(facts)
  if (topup) {
    const reach = facts.topupTargetUsdc === null ? '' : ` to reach ${formatUsdc(facts.topupTargetUsdc)}`
    parts.push(`Top up ${formatUsdc(topup)}${reach}.`)
  }
  parts.push(facts.walletAddress ? `Send USDC on Base to ${facts.walletAddress}, or add funds in the console.` : 'Add funds in the console.')
  if (facts.walletUsdc) parts.push(`${formatUsdc(facts.walletUsdc)} is in the wallet and not yet in the credits.`)
  return parts.map((part) => ` ${part}`).join('')
}

export function balanceLowEvent(workspace: Workspace, facts: BalanceFacts & { thresholdUsdc: number }, now: number): AlertEvent {
  return {
    ...base('balance.low', 'balance', 'warning', workspace, now),
    title: `${workspace.name}: credits are low`,
    message: `${formatUsdc(facts.availableUsdc)} of credits left, below the alert threshold of ${formatUsdc(facts.thresholdUsdc)}.${topupSentence(facts)}`,
    data: balanceData(facts),
  }
}

export function balanceEmptyEvent(workspace: Workspace, facts: BalanceFacts, now: number): AlertEvent {
  return {
    ...base('balance.empty', 'balance', 'critical', workspace, now),
    title: `${workspace.name}: out of credits`,
    message: `Requests are being refused: the workspace wallet has too few credits to pay sellers.${topupSentence(facts)}`,
    data: balanceData(facts),
  }
}

export function balanceOkEvent(workspace: Workspace, facts: BalanceFacts, now: number): AlertEvent {
  return {
    ...base('balance.ok', 'balance', 'info', workspace, now),
    title: `${workspace.name}: credits topped up`,
    message: `${formatUsdc(facts.availableUsdc)} of credits available again.`,
    data: balanceData(facts),
  }
}

export interface LimitFacts {
  level: BudgetLevel
  /** The key, member or workspace id. */
  scopeId: string
  scopeLabel: string
  period: BudgetPeriod
  limitUsdc: number
  spentUsdc: number
  resetsAt: number | null
  consoleUrl: string | null
}

const PERIOD_LABEL: Record<BudgetPeriod, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', total: 'lifetime' }
const LEVEL_LABEL: Record<BudgetLevel, string> = { key: 'API key', member: 'Member', workspace: 'Workspace' }

function limitData(facts: LimitFacts): Record<string, unknown> {
  return {
    level: facts.level,
    scope_id: facts.scopeId,
    scope_label: facts.scopeLabel,
    period: facts.period,
    limit_usd: usd(facts.limitUsdc),
    spent_usd: usd(facts.spentUsdc),
    remaining_usd: usd(Math.max(0, facts.limitUsdc - facts.spentUsdc)),
    resets_at: facts.resetsAt === null ? null : new Date(facts.resetsAt).toISOString(),
    ...(facts.consoleUrl ? { console_url: facts.consoleUrl } : {}),
  }
}

function resets(facts: LimitFacts): string {
  return facts.resetsAt === null ? '' : ` It resets ${new Date(facts.resetsAt).toISOString().replace('T', ' ').slice(0, 16)} UTC.`
}

export function limitNearEvent(workspace: Workspace, facts: LimitFacts, percent: number, now: number): AlertEvent {
  const holder = `${LEVEL_LABEL[facts.level]} “${facts.scopeLabel}”`
  return {
    ...base('limit.near', 'limits', 'warning', workspace, now),
    title: `${workspace.name}: ${holder} is near its ${PERIOD_LABEL[facts.period]} spend limit`,
    message: `${holder} has spent ${formatUsdc(facts.spentUsdc)} of its ${PERIOD_LABEL[facts.period]} limit of ${formatUsdc(facts.limitUsdc)} (${percent}% alert).${resets(facts)}`,
    data: { ...limitData(facts), warn_percent: percent },
  }
}

export function limitReachedEvent(workspace: Workspace, facts: LimitFacts, now: number): AlertEvent {
  const holder = `${LEVEL_LABEL[facts.level]} “${facts.scopeLabel}”`
  return {
    ...base('limit.reached', 'limits', 'critical', workspace, now),
    title: `${workspace.name}: ${holder} reached its ${PERIOD_LABEL[facts.period]} spend limit`,
    message: `${holder} has spent ${formatUsdc(facts.spentUsdc)} of its ${PERIOD_LABEL[facts.period]} limit of ${formatUsdc(facts.limitUsdc)}; its requests are refused until the limit is raised or resets.${resets(facts)}`,
    data: limitData(facts),
  }
}

export function spendTrackingDownEvent(workspace: Workspace, state: string, sinceMs: number, now: number): AlertEvent {
  return {
    ...base('spend_tracking.down', 'gateway', 'critical', workspace, now),
    title: `${workspace.name}: spend tracking is down`,
    message: `The gateway cannot read spend from its buyer (${state}), so API keys under a spend limit are refused until it recovers.`,
    data: { state, since: new Date(sinceMs).toISOString() },
  }
}

export function spendTrackingOkEvent(workspace: Workspace, now: number): AlertEvent {
  return {
    ...base('spend_tracking.ok', 'gateway', 'info', workspace, now),
    title: `${workspace.name}: spend tracking recovered`,
    message: 'The gateway reads spend from its buyer again; API keys under a spend limit are served.',
    data: {},
  }
}

export function testEvent(workspace: Workspace, now: number): AlertEvent {
  return {
    ...base('test', null, 'info', workspace, now),
    title: `${workspace.name}: test alert`,
    message: 'Alerts from this Antseed gateway reach this destination.',
    data: {},
  }
}
