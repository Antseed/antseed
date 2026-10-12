export type LimitPeriod = 'daily' | 'monthly' | 'total'

export const LIMIT_PERIODS: readonly LimitPeriod[] = ['daily', 'monthly', 'total']

/** Spend caps in USDC base units; null means no cap for that period. */
export type SpendLimits = Record<LimitPeriod, number | null>

export type PeriodSpend = Record<LimitPeriod, number>

export interface LimitBreach {
  period: LimitPeriod
  limitUsdc: number
  spentUsdc: number
  heldUsdc: number
  /** Epoch ms when the period rolls over; null for the lifetime cap. */
  resetsAt: number | null
}

export function hasSpendLimits(limits: SpendLimits): boolean {
  return LIMIT_PERIODS.some((period) => limits[period] !== null)
}

/** Periods are calendar-aligned in UTC so every operator and key holder sees the same boundary. */
export function periodStart(period: LimitPeriod, now: number): number {
  if (period === 'total') return 0
  const date = new Date(now)
  return period === 'daily'
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

export function periodResetsAt(period: LimitPeriod, now: number): number | null {
  if (period === 'total') return null
  const date = new Date(now)
  return period === 'daily'
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
    : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

/**
 * A request is admitted while settled spend plus the holds of requests still
 * in flight stays below every cap. Actual cost is only known after the seller
 * is paid, so a key can overshoot a cap by at most the requests already
 * admitted when it was reached.
 */
export function findLimitBreach(
  limits: SpendLimits,
  spent: PeriodSpend,
  heldUsdc: number,
  now: number,
): LimitBreach | null {
  for (const period of LIMIT_PERIODS) {
    const limit = limits[period]
    if (limit === null) continue
    if (spent[period] + heldUsdc >= limit) {
      return {
        period,
        limitUsdc: limit,
        spentUsdc: spent[period],
        heldUsdc,
        resetsAt: periodResetsAt(period, now),
      }
    }
  }
  return null
}
