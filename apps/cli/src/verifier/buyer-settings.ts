import type { TokenPricingUsdPerMillion } from '@antseed/node'

/** The limits a running buyer enforces, as it records them in buyer.state.json (`settings`). */
export interface RunningBuyerSettings {
  minPeerReputation: number | null
  maxPricing: TokenPricingUsdPerMillion | null
  /** USDC base units each new payment channel reserves. */
  maxReserveAmountUsdc: bigint | null
}

/** Reads `settings` from a parsed buyer.state.json; null when the buyer did not record them (an older build). */
export function parseRunningBuyerSettings(value: unknown): RunningBuyerSettings | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const pricing = record.maxPricing && typeof record.maxPricing === 'object'
    ? record.maxPricing as Record<string, unknown>
    : null
  const finite = (entry: unknown): entry is number => typeof entry === 'number' && Number.isFinite(entry)
  return {
    minPeerReputation: finite(record.minPeerReputation) ? record.minPeerReputation : null,
    maxPricing: pricing && finite(pricing.inputUsdPerMillion) && finite(pricing.outputUsdPerMillion)
      ? {
          inputUsdPerMillion: pricing.inputUsdPerMillion,
          outputUsdPerMillion: pricing.outputUsdPerMillion,
          ...(finite(pricing.cachedInputUsdPerMillion) ? { cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion } : {}),
        }
      : null,
    maxReserveAmountUsdc: typeof record.maxReserveAmountUsdc === 'string' && /^\d+$/.test(record.maxReserveAmountUsdc)
      ? BigInt(record.maxReserveAmountUsdc)
      : null,
  }
}
