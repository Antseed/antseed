/**
 * What a key's requests would have cost at retail reference prices, against
 * what they paid. Usage comes from the gateway's own records per model (the
 * ledger's metered spend, plus the tokens a response reported where no spend
 * was metered, as free requests are), so a key sees only its own requests.
 * Models without a retail price count on neither side.
 */
import { totalRetailUsage, type RetailPriceMap } from '@antseed/node/retail-prices'
import type { KeySavings } from './server.js'

/** One model's usage under a key: spend in USDC base units, tokens as the buyer metered them. */
export interface ModelUsage {
  model: string
  amountUsdc: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  requests: number
}

export function keySavings(rows: readonly ModelUsage[], prices: RetailPriceMap): KeySavings | null {
  // The retail matcher keys rows by service; a model name is its own key here.
  const names = new Map(rows.map((row) => [row.model.toLowerCase(), row.model]))
  const totals = totalRetailUsage(rows.map((row) => ({
    serviceIdHash: row.model.toLowerCase(),
    amountUsdc: row.amountUsdc,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    requestCount: row.requests,
  })), names, prices)
  return totals ? { retailUsd: totals.retailUsd, paidUsd: totals.paidUsd, matchedRequests: totals.matchedRequests } : null
}

/** USD to the cent's hundredth, so the answer doesn't carry float noise. */
export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
