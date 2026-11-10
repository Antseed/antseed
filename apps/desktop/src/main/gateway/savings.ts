/**
 * What the buyer saved: the same tokens at retail reference prices vs what
 * was actually paid, for Home's usage card.
 *
 * Usage comes per service from the buyer daemon (`/_antseed/buyer-usage`),
 * keyed by keccak256(serviceName); names are recovered from the services the
 * buyer has seen advertised. Retail prices come from an OpenRouter-compatible
 * models endpoint (ANTSEED_COMPARABLE_PRICES_URL, or the release build's baked
 * default). Models with no retail match are left out of both sides, so the
 * comparison is like for like. Mirrors the CLI's `buyer activity` savings.
 */
import { canonicalModelKey } from '@antseed/node/model-identity';
import { parseRetailPrices, type RetailPriceMap } from '@antseed/node/retail-prices';
import type { GatewaySavings } from '../../shared/gateway-types.js';

export type { GatewaySavings };

export { parseRetailPrices };
export type { RetailPrice, RetailPriceMap } from '@antseed/node/retail-prices';

export type ServiceUsage = {
  serviceIdHash: string;
  amountUsdc: string;
  inputTokens: string;
  cachedInputTokens: string;
  outputTokens: string;
  requestCount: number;
};

const USDC_BASE_UNITS_PER_USD = 1_000_000;
const PRICES_TTL_MS = 10 * 60_000;
/** A failed price fetch is retried sooner than a good one is refreshed. */
const PRICES_RETRY_MS = 60_000;

function amount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

/** Per-service usage from the daemon's `{ ok, totals: { services } }` reply. */
export function parseServiceUsage(body: unknown): ServiceUsage[] {
  const totals = body && typeof body === 'object' ? (body as Record<string, unknown>).totals : null;
  const services = totals && typeof totals === 'object' ? (totals as Record<string, unknown>).services : null;
  if (!Array.isArray(services)) return [];
  return services.flatMap((entry): ServiceUsage[] => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Record<string, unknown>;
    const serviceIdHash = typeof raw.serviceIdHash === 'string' ? raw.serviceIdHash : '';
    if (!serviceIdHash) return [];
    const text = (key: string) => (typeof raw[key] === 'string' || typeof raw[key] === 'number' ? String(raw[key]) : '0');
    return [{
      serviceIdHash,
      amountUsdc: text('amountUsdc'),
      inputTokens: text('inputTokens'),
      cachedInputTokens: text('cachedInputTokens'),
      outputTokens: text('outputTokens'),
      requestCount: amount(raw.requestCount),
    }];
  });
}

/**
 * Retail vs paid over the services with a retail match. Free usage counts:
 * those tokens cost $0 and widen the gap. Null until something matched.
 */
export function computeSavings(
  services: ServiceUsage[],
  names: Map<string, string>,
  prices: RetailPriceMap,
): GatewaySavings | null {
  let retailUsd = 0;
  let paidUsd = 0;
  let matchedRequests = 0;
  let matched = false;
  for (const service of services) {
    const name = names.get(service.serviceIdHash.toLowerCase());
    const price = name ? prices.get(canonicalModelKey(name)) : undefined;
    if (!price) continue;
    // The buyer's input tokens are fresh plus cached; cached ones are priced apart.
    const totalInput = amount(service.inputTokens);
    const cached = Math.min(amount(service.cachedInputTokens), totalInput);
    const output = amount(service.outputTokens);
    const inputPrice = price.input ?? 0;
    const retail = ((totalInput - cached) * inputPrice
      + cached * (price.cachedInput ?? inputPrice)
      + output * (price.output ?? 0)) / 1_000_000;
    if (retail <= 0) continue;
    matched = true;
    retailUsd += retail;
    paidUsd += amount(service.amountUsdc) / USDC_BASE_UNITS_PER_USD;
    matchedRequests += service.requestCount;
  }
  if (!matched) return null;
  return { retailUsd, paidUsd, savedUsd: Math.max(0, retailUsd - paidUsd), matchedRequests };
}

export type SavingsReaderDeps = {
  /** The comparable-prices URL, or null when the baseline is off. */
  pricesUrl: () => string | null;
  fetchJson: (url: string) => Promise<unknown>;
  /** The daemon's buyer-usage reply, or null when it is unreachable. */
  readUsage: () => Promise<unknown>;
  /** service-id hash (lowercase) → service name, for the hashes asked for. */
  resolveNames: (hashes: string[]) => Promise<Map<string, string>>;
  now?: () => number;
};

/** Reads savings, keeping retail prices between reads so opening Home doesn't refetch them. */
export function createSavingsReader(deps: SavingsReaderDeps): () => Promise<GatewaySavings | null> {
  const now = deps.now ?? Date.now;
  let cache: { url: string; at: number; prices: RetailPriceMap | null } | null = null;

  async function prices(url: string): Promise<RetailPriceMap | null> {
    const age = cache && cache.url === url ? now() - cache.at : Infinity;
    if (cache && age < (cache.prices ? PRICES_TTL_MS : PRICES_RETRY_MS)) return cache.prices;
    const parsed = await deps.fetchJson(url).then(parseRetailPrices, () => null);
    // A refresh that fails keeps the last good prices until the next refresh.
    const kept = parsed ?? (cache?.url === url ? cache.prices : null);
    cache = { url, at: now(), prices: kept };
    return kept;
  }

  return async () => {
    const url = deps.pricesUrl();
    if (!url) return null;
    const usage = await deps.readUsage();
    if (!usage) return null;
    const services = parseServiceUsage(usage);
    if (services.length === 0) return null;
    const priceMap = await prices(url);
    if (!priceMap) return null;
    const names = await deps.resolveNames(services.map((service) => service.serviceIdHash.toLowerCase()));
    return computeSavings(services, names, priceMap);
  };
}
