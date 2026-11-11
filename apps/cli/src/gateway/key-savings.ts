/**
 * What a key's requests would have cost at retail reference prices, against
 * what they paid. Usage comes from the gateway's own records per model (the
 * ledger's metered spend, plus the tokens a response reported where no spend
 * was metered, as free requests are), so a key sees only its own requests.
 * Models without a retail price count on neither side.
 */
import { totalRetailUsage, type RetailPriceMap } from '@antseed/node/retail-prices'
import type { KeySavings } from './server.js'
import type { GatewayStore } from './store.js'
import { usdcToDecimalString } from './money.js'

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
  const totals = totalRetailUsage(rows.map((row) => ({ ...row, serviceName: row.model, requestCount: row.requests })), prices)
  return totals ? { retailUsd: totals.retailUsd, paidUsd: totals.paidUsd, matchedRequests: totals.matchedRequests } : null
}

/** `GET /v1/key/savings`'s `data`: savings rounded, or null when there are none. */
export function savingsJson(savings: KeySavings | null) {
  if (!savings) return null
  return {
    retail_usd: roundUsd(savings.retailUsd),
    paid_usd: roundUsd(savings.paidUsd),
    saved_usd: roundUsd(Math.max(0, savings.retailUsd - savings.paidUsd)),
    matched_requests: savings.matchedRequests,
  }
}

/**
 * Requests, spend and savings summed over `ids`, revoked keys included: the
 * owner's view of keys an app has retired, which their own secrets can no
 * longer read. Unknown ids are skipped.
 */
export function keysUsage(store: GatewayStore, ids: readonly string[], prices: RetailPriceMap | null) {
  const keys = [...new Set(ids.map((id) => id.trim()))].filter((id) => store.getKey(id))
  const spent = keys.reduce((sum, id) => sum + store.spendByPeriod({ keyId: id }).total, 0)
  // Lifetime request counts for every key in one batched read.
  const summaries = store.keyUsageSummaries(keys, 0)
  return {
    requests: keys.reduce((sum, id) => sum + (summaries.get(id)?.requests ?? 0), 0),
    spent_usd: usdcToDecimalString(spent),
    savings: prices ? savingsJson(keySavings(keys.flatMap((id) => store.usageByModel(id)), prices)) : null,
  }
}

/** USD to the cent's hundredth, so the answer doesn't carry float noise. */
export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
