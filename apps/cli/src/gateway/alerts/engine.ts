/**
 * The gateway's alerts. Each condition is an incident, kept in the store:
 * alerted once when it opens (and again every `repeatMinutes` while it stays
 * open, when set), with a recovery alert when it closes after one was sent.
 * Conditions are found by a poll (credits, spend limits, spend tracking) and
 * by the request path (a cap refusing a request, the buyer out of credits).
 * A failed delivery is retried a few times; every attempt is logged.
 */
import { effectiveKeyLimits } from '../accounting.js'
import { cappedPeriods, periodResetsAt, periodStart, type BudgetLevel, type BudgetLimits, type BudgetPeriod, type LimitBreach } from '../limits.js'
import type { SpendFeedState } from '../spend-feed.js'
import type { AlertDestinationRecord, AlertEventGroup, AlertSettingsRecord, ApiKeyRecord, BudgetScope, GatewayStore, WorkspaceRecord } from '../store.js'
import type { AlertTransport } from './channels.js'
import {
  balanceEmptyEvent, balanceLowEvent, balanceOkEvent, limitNearEvent, limitReachedEvent,
  spendTrackingDownEvent, spendTrackingOkEvent, testEvent,
  type AlertEvent, type BalanceFacts, type LimitFacts,
} from './events.js'

/** What the engine reads about a workspace wallet; USD amounts as the buyer's decimal strings. */
export interface AlertWalletBalance {
  available: string
  wallet: string | null
  stale: boolean
}

export interface GatewayAlertsOptions {
  store: GatewayStore
  transport: AlertTransport
  balance: (buyerIdentity: string) => Promise<AlertWalletBalance | null>
  walletAddress: (buyerIdentity: string) => Promise<string | null>
  spendFeedState: () => SpendFeedState
  /** Whether any key, member or workspace is capped (spend tracking only matters then). */
  anyBudgets?: () => boolean
  /** The console's public origin, for links in alerts; null leaves them out. */
  consoleUrl?: () => string | null
  /** Credits that close an out-of-credits incident in a workspace without a low-balance threshold (one request's hold). */
  emptyRecoveryUsdc: number
  now?: () => number
  log?: (line: string) => void
  /** How often limits and spend tracking are checked. */
  intervalMs?: number
  /** How often each alerting workspace's credits are read. */
  balanceIntervalMs?: number
  /** How long spend tracking may be down before it is alerted (a buyer restart takes a moment). */
  spendTrackingGraceMs?: number
  /** Waits before each resend of a failed delivery. */
  retryDelaysMs?: number[]
}

export const DEFAULT_ALERT_INTERVAL_MS = 60_000
export const DEFAULT_BALANCE_INTERVAL_MS = 2 * 60_000
export const DEFAULT_SPEND_TRACKING_GRACE_MS = 3 * 60_000
export const DEFAULT_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000]

const BALANCE_LOW = 'balance.low'
const BALANCE_EMPTY = 'balance.empty'
const SPEND_TRACKING = 'spend_tracking.down'

/** `limit.<near|reached>:<level>:<id>:<period>:<period start>`: a new period is a new incident. */
export function limitIncident(kind: 'near' | 'reached', level: BudgetLevel, id: string, period: BudgetPeriod, now: number): string {
  return `limit.${kind}:${level}:${id}:${period}:${periodStart(period, now)}`
}

/** Parses a decimal USD string ("12.500000", "-0.100000") into base units; null when it is not one. */
export function decimalToUsdc(value: string | null): number | null {
  if (value === null) return null
  const match = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim())
  if (!match) return null
  const amount = Number(match[2]) * 1_000_000 + Number((match[3] ?? '').padEnd(6, '0'))
  if (!Number.isSafeInteger(amount)) return null
  return match[1] ? -amount : amount
}

export class GatewayAlerts {
  private readonly _store: GatewayStore
  private readonly _now: () => number
  private readonly _log: (line: string) => void
  private readonly _retryDelays: number[]
  private _timer: ReturnType<typeof setInterval> | null = null
  private readonly _retries = new Set<ReturnType<typeof setTimeout>>()
  private _ticking: Promise<void> | null = null
  private _stopped = false
  private readonly _lastBalanceRead = new Map<string, number>()
  private _spendTrackingDownSince: number | null = null

  constructor(private readonly _options: GatewayAlertsOptions) {
    this._store = _options.store
    this._now = _options.now ?? Date.now
    this._log = _options.log ?? (() => undefined)
    this._retryDelays = _options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  }

  start(): void {
    if (this._timer) return
    this._stopped = false
    this._timer = setInterval(() => void this.tick(), this._options.intervalMs ?? DEFAULT_ALERT_INTERVAL_MS)
    this._timer.unref?.()
    void this.tick()
  }

  async stop(): Promise<void> {
    this._stopped = true
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    for (const timer of this._retries) clearTimeout(timer)
    this._retries.clear()
    await this._ticking?.catch(() => undefined)
  }

  /** One pass over every workspace; a pass still running is joined rather than doubled. */
  tick(): Promise<void> {
    if (!this._ticking) {
      this._ticking = this._tick().catch((error) => {
        this._log(`gateway alerts: check failed: ${error instanceof Error ? error.message : String(error)}`)
      }).finally(() => { this._ticking = null })
    }
    return this._ticking
  }

  /** A cap refused a request (from the request path): the same incident the poll opens once spend reaches it. */
  limitRefused(key: ApiKeyRecord, breach: LimitBreach): void {
    void this._safely(async () => {
      const workspace = this._store.getWorkspace(key.workspaceId)
      if (!workspace) return
      const level = breach.level ?? 'key'
      const scope = this._scope(level, key, workspace)
      if (!scope) return
      // A cap refused while spend is under it is full of requests in flight, not reached: the poll alerts it when spend gets there.
      if (breach.spentUsdc < breach.limitUsdc) return
      const facts: LimitFacts = {
        level, scopeId: scope.id, scopeLabel: scope.label, period: breach.period,
        limitUsdc: breach.limitUsdc, spentUsdc: breach.spentUsdc, resetsAt: breach.resetsAt, consoleUrl: this._link('/keys'),
      }
      const now = this._now()
      await this._raise(workspace, limitIncident('reached', level, scope.id, breach.period, now), () => limitReachedEvent(workspace, facts, now))
    })
  }

  /** The buyer refused a request of this key for lack of credits (from the request path). */
  outOfCredits(key: ApiKeyRecord): void {
    void this._safely(async () => {
      const workspace = this._store.getWorkspace(key.workspaceId)
      if (!workspace || key.buyerIdentity !== workspace.buyerIdentity) return
      // Open already: only a reminder can be due, and the balance is read only then.
      const open = this._store.getAlertIncident(workspace.id, BALANCE_EMPTY)
      if (open && !this._reminderDue(workspace.id, open.lastSentAt)) return
      const settings = this._store.getAlertSettings(workspace.id)
      // Unread, the alert still goes out: requests are failing either way.
      const facts = await this._balanceFacts(workspace, settings) ?? { ...this._settingsFacts(settings), walletAddress: null, availableUsdc: 0, walletUsdc: null }
      await this._raise(workspace, BALANCE_EMPTY, () => balanceEmptyEvent(workspace, facts, this._now()))
    })
  }

  /** Sends a test alert to one destination now (no retries); the delivery is logged like any other. */
  async sendTest(destination: AlertDestinationRecord): Promise<{ ok: boolean; error: string | null }> {
    const workspace = this._store.getWorkspace(destination.workspaceId)
    if (!workspace) return { ok: false, error: 'Workspace not found.' }
    return this._deliver(destination, testEvent(workspace, this._now()))
  }

  private async _tick(): Promise<void> {
    const workspaces = this._store.listWorkspaces()
    await this._checkSpendTracking(workspaces)
    for (const workspace of workspaces) {
      if (this._stopped) return
      const destinations = this._destinations(workspace.id)
      if (destinations.length === 0) continue
      const settings = this._store.getAlertSettings(workspace.id)
      const groups = new Set(destinations.flatMap((destination) => destination.events))
      if (groups.has('limits')) await this._safely(() => this._checkLimits(workspace, settings))
      if (groups.has('balance')) await this._safely(() => this._checkBalance(workspace, settings))
    }
  }

  private async _checkSpendTracking(workspaces: WorkspaceRecord[]): Promise<void> {
    const state = this._options.spendFeedState()
    const now = this._now()
    if (state === 'reporting') {
      this._spendTrackingDownSince = null
      for (const workspace of workspaces) {
        await this._safely(() => this._resolve(workspace, [SPEND_TRACKING], () => spendTrackingOkEvent(workspace, this._now())))
      }
      return
    }
    this._spendTrackingDownSince ??= now
    if (now - this._spendTrackingDownSince < (this._options.spendTrackingGraceMs ?? DEFAULT_SPEND_TRACKING_GRACE_MS)) return
    if (this._options.anyBudgets && !this._options.anyBudgets()) return
    const since = this._spendTrackingDownSince
    for (const workspace of workspaces) {
      await this._safely(() => this._raise(workspace, SPEND_TRACKING, () => spendTrackingDownEvent(workspace, state, since, this._now())))
    }
  }

  private async _checkLimits(workspace: WorkspaceRecord, settings: AlertSettingsRecord): Promise<void> {
    const now = this._now()
    const open = new Set<string>()
    const check = (level: BudgetLevel, id: string, label: string, limits: BudgetLimits, scope: BudgetScope) => {
      const periods = cappedPeriods(limits)
      if (periods.length === 0) return []
      const spent = this._store.spendByPeriod(scope, now, periods)
      return periods.map((period) => ({ level, id, label, period, limit: limits[period] ?? 0, spent: spent[period] ?? 0 }))
    }
    const rows = [
      ...check('workspace', workspace.id, workspace.name, workspace.limits, { workspaceId: workspace.id }),
      ...this._store.workspaceMembers(workspace.id).flatMap(({ member }) => check('member', member.id, member.label, member.limits, { memberId: member.id })),
      ...this._store.listKeys({ workspaceId: workspace.id }).filter((key) => key.status === 'active')
        .flatMap((key) => check('key', key.id, key.label, effectiveKeyLimits(key), { keyId: key.id })),
    ]
    for (const row of rows) {
      const facts: LimitFacts = {
        level: row.level, scopeId: row.id, scopeLabel: row.label, period: row.period,
        limitUsdc: row.limit, spentUsdc: row.spent, resetsAt: periodResetsAt(row.period, now), consoleUrl: this._link('/keys'),
      }
      if (row.spent >= row.limit) {
        const incident = limitIncident('reached', row.level, row.id, row.period, now)
        // Reached says everything near would: a near incident of the same period is left out of `open`, so it closes quietly.
        open.add(incident)
        await this._raise(workspace, incident, () => limitReachedEvent(workspace, facts, this._now()))
      } else if (settings.limitWarnPercent !== null && row.spent * 100 >= row.limit * settings.limitWarnPercent) {
        const incident = limitIncident('near', row.level, row.id, row.period, now)
        open.add(incident)
        const percent = settings.limitWarnPercent
        await this._raise(workspace, incident, () => limitNearEvent(workspace, facts, percent, this._now()))
      }
    }
    // A limit incident of a past period, a raised cap or a removed key is over; limits have no recovery alert.
    for (const incident of this._store.listAlertIncidents(workspace.id)) {
      if (incident.incident.startsWith('limit.') && !open.has(incident.incident)) this._store.closeAlertIncident(workspace.id, incident.incident)
    }
  }

  private async _checkBalance(workspace: WorkspaceRecord, settings: AlertSettingsRecord): Promise<void> {
    const emptyOpen = this._store.getAlertIncident(workspace.id, BALANCE_EMPTY) !== null
    const lowOpen = this._store.getAlertIncident(workspace.id, BALANCE_LOW) !== null
    if (settings.lowBalanceUsdc === null && !emptyOpen && !lowOpen) return
    const now = this._now()
    const last = this._lastBalanceRead.get(workspace.id)
    if (last !== undefined && now - last < (this._options.balanceIntervalMs ?? DEFAULT_BALANCE_INTERVAL_MS)) return
    this._lastBalanceRead.set(workspace.id, now)
    const facts = await this._balanceFacts(workspace, settings)
    // An unread or stale balance changes nothing: an alert says only what the buyer reports now.
    if (!facts) return
    const threshold = settings.lowBalanceUsdc
    // Out of credits is over once the credits are above the threshold or, without one, one request's hold.
    const emptyOver = facts.availableUsdc >= (threshold ?? this._options.emptyRecoveryUsdc)
    if (emptyOpen && !emptyOver) {
      // Still out: its reminder is due on schedule even with no request refused since; it says all low would.
      await this._raise(workspace, BALANCE_EMPTY, () => balanceEmptyEvent(workspace, facts, this._now()))
      return
    }
    if (threshold !== null && facts.availableUsdc < threshold) {
      await this._raise(workspace, BALANCE_LOW, () => balanceLowEvent(workspace, { ...facts, thresholdUsdc: threshold }, this._now()))
      return
    }
    await this._resolve(workspace, emptyOver ? [BALANCE_LOW, BALANCE_EMPTY] : [BALANCE_LOW], () => balanceOkEvent(workspace, facts, this._now()))
  }

  /** The wallet as the buyer reports it now; null when it is unread or stale. */
  private async _balanceFacts(workspace: WorkspaceRecord, settings: AlertSettingsRecord): Promise<BalanceFacts | null> {
    const balance = await this._options.balance(workspace.buyerIdentity).catch(() => null)
    if (!balance || balance.stale) return null
    const available = decimalToUsdc(balance.available)
    if (available === null) return null
    const walletAddress = await this._options.walletAddress(workspace.buyerIdentity).catch(() => null)
    return { ...this._settingsFacts(settings), walletAddress, availableUsdc: available, walletUsdc: decimalToUsdc(balance.wallet) }
  }

  private _settingsFacts(settings: AlertSettingsRecord): Pick<BalanceFacts, 'thresholdUsdc' | 'topupTargetUsdc' | 'consoleUrl'> {
    return { thresholdUsdc: settings.lowBalanceUsdc, topupTargetUsdc: settings.topupTargetUsdc, consoleUrl: this._link('/wallet') }
  }

  private _scope(level: BudgetLevel, key: ApiKeyRecord, workspace: WorkspaceRecord): { id: string; label: string } | null {
    if (level === 'key') return { id: key.id, label: key.label }
    if (level === 'workspace') return { id: workspace.id, label: workspace.name }
    const member = key.ownerMemberId ? this._store.getMember(key.ownerMemberId) : null
    return member ? { id: member.id, label: member.label } : null
  }

  private _destinations(workspaceId: string, group?: AlertEventGroup): AlertDestinationRecord[] {
    return this._store.listAlertDestinations(workspaceId)
      .filter((destination) => destination.enabled && (group === undefined ? destination.events.length > 0 : destination.events.includes(group)))
  }

  /**
   * Opens `incident` and alerts it, or, while it stays open, alerts it again
   * once `repeatMinutes` have passed. Nothing opens without a destination for
   * it, so one added later still hears of a condition that is still there.
   */
  private async _raise(workspace: WorkspaceRecord, incident: string, build: () => AlertEvent): Promise<void> {
    const event = build()
    const destinations = this._destinations(workspace.id, event.group ?? undefined)
    if (destinations.length === 0) return
    if (!this._store.openAlertIncident(workspace.id, incident)) {
      const open = this._store.getAlertIncident(workspace.id, incident)
      if (!open || !this._reminderDue(workspace.id, open.lastSentAt)) return
    }
    this._store.touchAlertIncident(workspace.id, incident)
    this._dispatch(destinations, event)
  }

  /** Whether an open incident last alerted at `lastSentAt` is due its `repeatMinutes` reminder. */
  private _reminderDue(workspaceId: string, lastSentAt: number | null): boolean {
    const repeat = this._store.getAlertSettings(workspaceId).repeatMinutes
    return repeat !== null && lastSentAt !== null && this._now() - lastSentAt >= repeat * 60_000
  }

  /** Closes the incidents; one recovery alert when any of them had been alerted. */
  private async _resolve(workspace: WorkspaceRecord, incidents: string[], build: () => AlertEvent): Promise<void> {
    let alerted = false
    for (const incident of incidents) {
      const closed = this._store.closeAlertIncident(workspace.id, incident)
      if (closed && closed.lastSentAt !== null) alerted = true
    }
    if (!alerted) return
    const event = build()
    this._dispatch(this._destinations(workspace.id, event.group ?? undefined), event)
  }

  private _dispatch(destinations: AlertDestinationRecord[], event: AlertEvent): void {
    for (const destination of destinations) void this._deliverWithRetry(destination.id, event, 0)
  }

  private async _deliverWithRetry(destinationId: string, event: AlertEvent, attempt: number): Promise<void> {
    if (this._stopped) return
    // Read again on every attempt: a destination edited, disabled or deleted since gets the change.
    const destination = this._store.getAlertDestination(destinationId)
    if (!destination || !destination.enabled) return
    const result = await this._deliver(destination, event)
    if (result.ok || attempt >= this._retryDelays.length || this._stopped) return
    const timer = setTimeout(() => {
      this._retries.delete(timer)
      void this._deliverWithRetry(destinationId, event, attempt + 1)
    }, this._retryDelays[attempt])
    timer.unref?.()
    this._retries.add(timer)
  }

  private async _deliver(destination: AlertDestinationRecord, event: AlertEvent): Promise<{ ok: boolean; error: string | null }> {
    let error: string | null = null
    try {
      await this._options.transport.send(destination, event)
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
      this._log(`gateway alerts: ${event.type} to ${destination.kind} ${destination.id} failed: ${error}`)
    }
    try {
      this._store.recordAlertDelivery({
        workspaceId: destination.workspaceId, destinationId: destination.id, eventId: event.id,
        eventType: event.type, summary: event.title, ok: error === null, error,
      })
      this._store.markAlertDestination(destination.id, { ok: error === null, error })
    } catch (failure) {
      this._log(`gateway alerts: could not log a delivery: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
    return { ok: error === null, error }
  }

  private _link(path: string): string | null {
    const origin = this._options.consoleUrl?.()
    return origin ? `${origin.replace(/\/+$/, '')}/console${path}` : null
  }

  private async _safely(work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      this._log(`gateway alerts: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
