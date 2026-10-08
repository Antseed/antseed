/** The periods `antseed gateway key` commands expose. */
export type LimitPeriod = 'daily' | 'monthly' | 'total'

/** Every budget period; weeks start Monday 00:00 UTC. */
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'total'

export const LIMIT_PERIODS: readonly LimitPeriod[] = ['daily', 'monthly', 'total']

export const BUDGET_PERIODS: readonly BudgetPeriod[] = ['daily', 'weekly', 'monthly', 'total']

/**
 * Spend caps in USDC base units; null means no cap for that period. `weekly`
 * is optional for callers that only set the CLI's periods; records read from
 * the store always carry it.
 */
export type SpendLimits = Record<LimitPeriod, number | null> & { weekly?: number | null }

/** Caps with every period present, as stored for workspaces and members. */
export type BudgetLimits = Record<BudgetPeriod, number | null>

type PeriodSpend = Record<LimitPeriod, number> & { weekly?: number }

export type BudgetSpend = Record<BudgetPeriod, number>

/** Which level of the org hierarchy a cap belongs to. */
export type BudgetLevel = 'key' | 'member' | 'workspace'

export interface LimitBreach {
  period: BudgetPeriod
  limitUsdc: number
  spentUsdc: number
  heldUsdc: number
  /** Epoch ms when the period rolls over; null for the lifetime cap. */
  resetsAt: number | null
  /** Set by multi-level admission; absent means the key's own cap. */
  level?: BudgetLevel
}

export const NO_BUDGET_LIMITS: BudgetLimits = Object.freeze({ daily: null, weekly: null, monthly: null, total: null }) as BudgetLimits

export function fullLimits(limits: SpendLimits | BudgetLimits): BudgetLimits {
  return { daily: limits.daily, weekly: limits.weekly ?? null, monthly: limits.monthly, total: limits.total }
}

export function hasSpendLimits(limits: SpendLimits | BudgetLimits): boolean {
  return BUDGET_PERIODS.some((period) => (limits[period] ?? null) !== null)
}

/** Periods are calendar-aligned in UTC so every operator and key holder sees the same boundary. */
export function periodStart(period: BudgetPeriod, now: number): number {
  if (period === 'total') return 0
  const date = new Date(now)
  if (period === 'daily') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  if (period === 'weekly') {
    const sinceMonday = (date.getUTCDay() + 6) % 7
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - sinceMonday)
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

export function periodResetsAt(period: BudgetPeriod, now: number): number | null {
  if (period === 'total') return null
  const date = new Date(now)
  if (period === 'daily') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  if (period === 'weekly') return periodStart('weekly', now) + 7 * 24 * 60 * 60 * 1000
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

/**
 * A request is admitted while settled spend plus the holds of requests still
 * in flight stays below every cap. Actual cost is only known after the seller
 * is paid, so a key can overshoot a cap by at most the requests already
 * admitted when it was reached.
 */
export function findLimitBreach(
  limits: SpendLimits | BudgetLimits,
  spent: PeriodSpend | BudgetSpend,
  heldUsdc: number,
  now: number,
): LimitBreach | null {
  for (const period of BUDGET_PERIODS) {
    const limit = limits[period] ?? null
    if (limit === null) continue
    const periodSpent = spent[period] ?? 0
    if (periodSpent + heldUsdc >= limit) {
      return {
        period,
        limitUsdc: limit,
        spentUsdc: periodSpent,
        heldUsdc,
        resetsAt: periodResetsAt(period, now),
      }
    }
  }
  return null
}
