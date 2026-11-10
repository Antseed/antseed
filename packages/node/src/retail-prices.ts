import { canonicalModelKey } from './model-identity.js';

/** A model's retail price in USD per million tokens; null when the list has none. */
export type RetailPrice = { input: number | null; output: number | null; cachedInput: number | null };
export type RetailPriceMap = Map<string, RetailPrice>;

/**
 * Retail prices per million tokens, keyed by canonical model (both a model's
 * id and its name; the first listed wins), from an OpenRouter-style models
 * list. Null when the list is malformed or prices nothing.
 */
export function parseRetailPrices(body: unknown): RetailPriceMap | null {
  const data = body && typeof body === 'object' ? (body as Record<string, unknown>).data : null;
  if (!Array.isArray(data)) return null;
  // Absent stays null; an explicit 0 (free cache reads) is a price.
  const perMillion = (perToken: unknown): number | null => {
    if (perToken === null || perToken === undefined || (typeof perToken === 'string' && !perToken.trim())) return null;
    const numeric = Number(perToken);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric * 1_000_000 : null;
  };
  const prices: RetailPriceMap = new Map();
  for (const model of data) {
    if (!model || typeof model !== 'object') continue;
    const { id, name, pricing } = model as { id?: unknown; name?: unknown; pricing?: Record<string, unknown> | null };
    const price: RetailPrice = {
      input: perMillion(pricing?.prompt),
      output: perMillion(pricing?.completion),
      cachedInput: perMillion(pricing?.input_cache_read),
    };
    // A model free at retail has nothing to compare against.
    if (!(price.input ?? 0) && !(price.output ?? 0)) continue;
    for (const label of [id, name]) {
      if (typeof label !== 'string' || !label.trim()) continue;
      const key = canonicalModelKey(label);
      if (key && !prices.has(key)) prices.set(key, price);
    }
  }
  return prices.size > 0 ? prices : null;
}

/**
 * What the tokens would cost at a retail price, in USD. `totalInput` is all
 * input, fresh plus cached; cached input uses its own price, or the input
 * price when the list has none.
 */
export function retailTokenCostUsd(totalInput: number, cachedInput: number, output: number, price: RetailPrice): number {
  const cached = Math.min(cachedInput, totalInput);
  const inputPrice = price.input ?? 0;
  return ((totalInput - cached) * inputPrice
    + cached * (price.cachedInput ?? inputPrice)
    + output * (price.output ?? 0)) / 1_000_000;
}
