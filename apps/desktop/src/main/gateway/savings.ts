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
import type { BuyerUsageServicePoint } from '@antseed/node';
import { parseRetailPrices, totalRetailUsage, type RetailPriceMap } from '@antseed/node/retail-prices';
import type { GatewaySavings } from '../../shared/gateway-types.js';

export type { GatewaySavings };

export { parseRetailPrices };
export type { RetailPrice, RetailPriceMap } from '@antseed/node/retail-prices';

/** The buyer's per-service usage, as much of it as the savings need. */
export type ServiceUsage = Pick<
  BuyerUsageServicePoint,
  'serviceIdHash' | 'amountUsdc' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'requestCount'
>;

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
  const totals = totalRetailUsage(services, names, prices);
  if (!totals) return null;
  const { retailUsd, paidUsd, matchedRequests } = totals;
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
