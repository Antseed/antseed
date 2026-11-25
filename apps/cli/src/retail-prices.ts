import { parseRetailPrices, type RetailPriceMap } from '@antseed/node/retail-prices'
import { BAKED_COMPARABLE_PRICES_URL } from './generated/baked-defaults.js'

/**
 * Endpoint serving comparable retail prices for savings comparisons, in the
 * OpenRouter-compatible models schema:
 * `{ data: [{ id, name, pricing: { prompt, completion, input_cache_read } }] }`
 * with prices in USD per token (e.g. set it to OpenRouter's models endpoint).
 * Release builds bake a default via scripts/bake-comparable-prices-url.mjs;
 * with neither env nor baked value, the savings baseline is off. Setting the
 * env to an empty string disables a baked default.
 */
export const COMPARABLE_PRICES_URL_ENV = 'ANTSEED_COMPARABLE_PRICES_URL'
const COMPARABLE_PRICES_TIMEOUT_MS = 8_000

export function comparablePricesUrl(): string | null {
  const raw = process.env[COMPARABLE_PRICES_URL_ENV]
  if (raw !== undefined) {
    // A set-but-empty env explicitly disables a baked release default.
    return raw.trim() || null
  }
  return BAKED_COMPARABLE_PRICES_URL
}

/** Retail reference prices for the savings comparison; null when off or unreadable. */
export async function fetchComparableRetailPrices(): Promise<RetailPriceMap | null> {
  const url = comparablePricesUrl()
  if (!url) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(COMPARABLE_PRICES_TIMEOUT_MS) })
    if (!res.ok) return null
    return parseRetailPrices(await res.json())
  } catch {
    return null
  }
}
