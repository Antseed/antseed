// ── Reference prices for the model list ──
// The retail price list behind the savings totals, held for `GET /v1/models`.
// A listing never waits on that list: it reads what is held and a stale read
// refreshes in the background.

import type { RetailPriceMap } from '@antseed/node/retail-prices'
import { fetchComparableRetailPrices } from '../retail-prices.js'

const PRICES_TTL_MS = 10 * 60_000
const PRICES_RETRY_MS = 60_000

export type ReferencePriceSource = {
  /** The prices held now (null before the first read, or with no price list); starts a refresh when they are stale. */
  current: () => RetailPriceMap | null
}

export function createReferencePriceSource(options: {
  fetchPrices?: () => Promise<RetailPriceMap | null>
  now?: () => number
} = {}): ReferencePriceSource {
  const fetchPrices = options.fetchPrices ?? fetchComparableRetailPrices
  const now = options.now ?? Date.now
  let prices: RetailPriceMap | null = null
  let nextReadAt = -Infinity
  let reading = false
  return {
    current() {
      if (!reading && now() >= nextReadAt) {
        reading = true
        void fetchPrices().catch(() => null).then((value) => {
          // A refresh that fails keeps the last good prices and retries sooner.
          if (value) prices = value
          nextReadAt = now() + (value ? PRICES_TTL_MS : PRICES_RETRY_MS)
          reading = false
        })
      }
      return prices
    },
  }
}
