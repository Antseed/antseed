import type { LimitPeriod, SpendLimits } from '../api/types'
import { PERIOD_LABELS, usdcToNumber } from './format'

const BUDGET_WARN_AT = 0.8

export interface BudgetWarning {
  period: LimitPeriod
  label: string
  spent: number
  limit: number
  fraction: number
  reached: boolean
}

/** Periods whose spend is at or above 80% of the budget. */
export function budgetWarnings(limits: SpendLimits | null | undefined, spent: Array<[LimitPeriod, number | null]>): BudgetWarning[] {
  if (!limits) return []
  const out: BudgetWarning[] = []
  for (const [period, amount] of spent) {
    const raw = limits[period]
    if (raw === null || amount === null) continue
    const limit = usdcToNumber(raw)
    const fraction = limit === 0 ? 1 : amount / limit
    if (fraction >= BUDGET_WARN_AT) out.push({ period, label: PERIOD_LABELS[period], spent: amount, limit, fraction, reached: fraction >= 1 })
  }
  return out
}

/**
 * Days the balance lasts at the recent average daily spend; low when under a week (or nearly empty with no spend).
 * USDC waiting in the workspace wallet counts: it moves into the credits automatically as they are spent.
 */
export function runway(available: number, spentInWindow: number, windowDays: number, inWallet = 0): { available: number; inWallet: number; total: number; dailySpend: number; days: number | null; low: boolean } {
  const total = available + Math.max(0, inWallet)
  const dailySpend = windowDays > 0 ? spentInWindow / windowDays : 0
  const days = dailySpend > 0 ? total / dailySpend : null
  const low = days === null ? total < 1 : days < 7
  return { available, inWallet: total - available, total, dailySpend, days, low }
}
