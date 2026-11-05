/**
 * Provider boost for Antseed Points: a buyer's recognized usage is weighted by
 * the provider pool's power, so points = $ spent × boost. Boost is pool power
 * (`AntseedSellerPools.poolWeightAtEpoch`, wei ANTS·epochs; Antscan serves the
 * current value as `IndexedPool.weight`) ÷ the reference power, where 1.0× =
 * 10,000 ANTS locked for the full 104 epochs. Display only: routing ignores it.
 */

import { createIndexer, type IndexedPool } from './indexer.js';

const MAX_LOCK_EPOCHS = 104n;
const WEI = 10n ** 18n;
const SCALE = 1_000_000_000n;
const LOOKUP_TTL_MS = 90_000;
const LOOKUP_STALE_MS = 10 * 60_000;

/** 10,000 ANTS × 104 epochs, in wei ANTS·epochs. */
export const BOOST_REFERENCE_POWER = 10_000n * MAX_LOCK_EPOCHS * WEI;

/** Below this a pool earns its buyers effectively nothing ("0× earns nothing"). */
export const BOOST_EARNING_MIN = 0.01;

export interface SellerBoost {
  boost: number;
  agentId: number;
}

/** Lowercase seller address → boost of the pool bound to it. */
export type BoostBySeller = Map<string, SellerBoost>;

/** Pool power (wei ANTS·epochs) → boost, e.g. 16.5M ANTS·epochs → 15.87. */
export function boostFromWeight(weight: bigint): number {
  if (weight <= 0n) return 0;
  return Number((weight * SCALE) / BOOST_REFERENCE_POWER) / Number(SCALE);
}

function parseWeight(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

/** Index Antscan pools by seller. A seller bound to several pools keeps the strongest. */
export function boostBySeller(pools: readonly Pick<IndexedPool, 'agentId' | 'seller' | 'weight'>[]): BoostBySeller {
  const bySeller: BoostBySeller = new Map();
  for (const pool of pools) {
    if (!pool.seller) continue;
    const key = pool.seller.toLowerCase();
    const boost = boostFromWeight(parseWeight(pool.weight));
    const existing = bySeller.get(key);
    if (!existing || boost > existing.boost) bySeller.set(key, { boost, agentId: pool.agentId });
  }
  return bySeller;
}

/** Same display rule as the Antseed Points site: "15.9×", "16×", "<0.1×", "0×", "—". */
export function formatBoost(boost: number | null | undefined): string {
  if (boost === null || boost === undefined || Number.isNaN(boost)) return '—';
  if (boost === 0) return '0×';
  if (boost < 0.1) return '<0.1×';
  return `${boost.toFixed(boost < 10 ? 1 : 0)}×`;
}

export interface BoostLookupOptions {
  fetchImpl?: typeof fetch;
  /** How long a fetched map is reused before Antscan is read again. */
  ttlMs?: number;
  /** How long the last good map still answers while Antscan is unreachable. */
  staleMs?: number;
  now?: () => number;
}

/**
 * Cached, never-throwing boost source for app surfaces. Resolves null when no
 * explorer is configured or Antscan is unreachable (and no recent map exists),
 * so callers show "—" rather than a false 0×.
 */
export function createBoostLookup(explorerApiUrl: string | undefined, options: BoostLookupOptions = {}): () => Promise<BoostBySeller | null> {
  const indexer = createIndexer(explorerApiUrl, options.fetchImpl);
  const ttlMs = options.ttlMs ?? LOOKUP_TTL_MS;
  const staleMs = options.staleMs ?? LOOKUP_STALE_MS;
  const now = options.now ?? Date.now;
  let last: { at: number; map: BoostBySeller } | null = null;
  let running: Promise<BoostBySeller | null> | null = null;

  // This lookup owns the cache window; drop the indexer's shorter one so a refresh really reads.
  const refresh = () => {
    indexer!.invalidate?.();
    return indexer!.pools();
  };

  return () => {
    if (!indexer) return Promise.resolve(null);
    if (last && now() - last.at < ttlMs) return Promise.resolve(last.map);
    running ??= refresh().then(
      ({ pools }) => {
        last = { at: now(), map: boostBySeller(pools) };
        return last.map;
      },
      () => (last && now() - last.at < staleMs ? last.map : null),
    ).finally(() => { running = null; });
    return running;
  };
}
