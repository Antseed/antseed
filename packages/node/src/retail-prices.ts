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
  // Only numbers and numeric strings count; anything else (an object, a
  // bad string) leaves that price unset instead of failing the whole list.
  const perMillion = (perToken: unknown): number | null => {
    let numeric: number;
    if (typeof perToken === 'number') numeric = perToken;
    else if (typeof perToken === 'string' && perToken.trim()) numeric = Number(perToken);
    else return null;
    const scaled = numeric * 1_000_000;
    return Number.isFinite(scaled) && scaled >= 0 ? scaled : null;
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

/**
 * One service's usage: its resolved name (null when it couldn't be resolved),
 * base-unit USDC and token counts, as numbers or decimal strings.
 */
export type RetailUsageRow = {
  serviceName: string | null;
  amountUsdc: number | string;
  inputTokens: number | string;
  cachedInputTokens: number | string;
  outputTokens: number | string;
  requestCount?: number;
};

export type RetailUsageTotals = { retailUsd: number; paidUsd: number; matchedServices: number; matchedRequests: number };

/**
 * Retail vs paid over the services whose name has a retail price. Services
 * without a name or a match, or whose tokens cost nothing at retail, count on
 * neither side; free usage that matches counts at $0 paid. Null when nothing matched.
 */
export function totalRetailUsage(
  rows: readonly RetailUsageRow[],
  prices: RetailPriceMap,
): RetailUsageTotals | null {
  const count = (value: number | string): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  };
  const totals: RetailUsageTotals = { retailUsd: 0, paidUsd: 0, matchedServices: 0, matchedRequests: 0 };
  for (const row of rows) {
    const price = row.serviceName ? prices.get(canonicalModelKey(row.serviceName)) : undefined;
    if (!price) continue;
    // The buyer's input tokens are fresh plus cached; cached ones are priced apart.
    const retail = retailTokenCostUsd(count(row.inputTokens), count(row.cachedInputTokens), count(row.outputTokens), price);
    if (!(retail > 0) || !Number.isFinite(retail)) continue;
    totals.retailUsd += retail;
    totals.paidUsd += count(row.amountUsdc) / 1_000_000;
    totals.matchedServices += 1;
    totals.matchedRequests += count(row.requestCount ?? 0);
  }
  return totals.matchedServices > 0 ? totals : null;
}
