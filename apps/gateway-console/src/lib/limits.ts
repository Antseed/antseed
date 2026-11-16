import type { LimitPeriod, SpendLimits } from '../api/types'
import { LIMIT_PERIODS, parseUsdInput, usdcForInput } from './format'

export type LimitsDraft = Record<LimitPeriod, string>

export function limitsToDraft(limits: SpendLimits | null | undefined): LimitsDraft {
  return {
    daily: usdcForInput(limits?.daily),
    weekly: usdcForInput(limits?.weekly),
    monthly: usdcForInput(limits?.monthly),
    total: usdcForInput(limits?.total),
  }
}

/** Blank fields are "no limit"; throws with the period name when a value is invalid. */
export function draftToLimits(draft: LimitsDraft): SpendLimits {
  const limits = {} as SpendLimits
  for (const period of LIMIT_PERIODS) {
    try {
      limits[period] = parseUsdInput(draft[period])
    } catch (error) {
      throw new Error(`${period[0]!.toUpperCase()}${period.slice(1)} limit: ${(error as Error).message}`)
    }
  }
  return limits
}
