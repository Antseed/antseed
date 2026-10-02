import type { AntsContext } from './context.js';

/** Long enough for one page's views to share a preview; shorter than the 20s view cache and the 60s client refresh. */
const TTL_MS = 15_000;

interface Entry { at: number; amount: Promise<bigint>; }
const caches = new WeakMap<AntsContext, Map<number, Entry>>();

/**
 * Pending staker rewards for display, shared by every view of one context.
 * Positions and Rewards preview the same ids concurrently; ids already
 * previewed (or in flight) are reused and only the rest are read, in one call.
 * Actions (claims, restakes, withdraw previews) must read live instead.
 */
export function displayStakerRewards(ctx: AntsContext, ids: number[]): Promise<bigint[]> {
  const poolRewards = ctx.poolRewards();
  if (!poolRewards || ids.length === 0) return Promise.resolve(ids.map(() => 0n));
  let cache = caches.get(ctx);
  if (!cache) { cache = new Map(); caches.set(ctx, cache); }
  const now = Date.now();
  const missing = [...new Set(ids)].filter(id => { const hit = cache!.get(id); return !hit || now - hit.at >= TTL_MS; });
  if (missing.length > 0) {
    const batch = poolRewards.previewStakerRewards(missing);
    missing.forEach((id, index) => {
      const entry: Entry = { at: now, amount: batch.then(amounts => amounts[index] ?? 0n) };
      cache!.set(id, entry);
      // A failed read must not be served to the next view; it retries.
      entry.amount.catch(() => { if (cache!.get(id) === entry) cache!.delete(id); });
    });
  }
  return Promise.all(ids.map(id => cache!.get(id)!.amount));
}

/** Called by `AntsContext.invalidate()` after actions and wallet changes. */
export function clearDisplayStakerRewards(ctx: AntsContext): void {
  caches.delete(ctx);
}
