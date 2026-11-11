/**
 * Spend the buyer has signed for but no seller has settled yet, as the
 * balance subtracts it. Electron-free, so its caching is tested directly.
 */
import { pendingSpendFromChannels, type ChannelSpendRow } from '../billing/credits-balance.js';
import { cachedRead, readKeys } from './read-cache.js';

// Pending spend rides on the credits poll, which runs every 60s normally and
// every 5s while the payment card is up. Cache it so the fast poll reuses one
// buyer-proxy round trip instead of repeating it.
export const PENDING_SPEND_FRESH_MS = 20_000;

/** The last value read for each buyer address: what an unreachable buyer proxy falls back to. */
const lastKnown = new Map<string, bigint>();

/**
 * Signed-but-unsettled spend across the channels of `address` a seller can
 * still settle against. Cached per address in the chain read cache, so a
 * channel close, an identity change or a chain config change makes the next
 * read fresh, and a read that started before one of them never fills the
 * cache afterwards.
 *
 * Falls back to the last value read for this address when the buyer proxy is
 * unreachable: dropping to 0 there would silently inflate the displayed
 * balance, and another identity's value would misstate it.
 *
 * `maxWaitMs` bounds how long a caller waits: the buyer proxy may still be
 * starting (app launch, upgrade), so past the bound the last known value is
 * returned and the read finishes in the background for the next poll.
 */
export async function readPendingSpend(
  address: string,
  loadChannels: () => Promise<readonly ChannelSpendRow[] | null>,
  maxWaitMs?: number,
): Promise<bigint> {
  const owner = address.toLowerCase();
  const fallback = (): bigint => lastKnown.get(owner) ?? 0n;
  const read = cachedRead(readKeys.pendingSpend(address), PENDING_SPEND_FRESH_MS, async () => {
    const channels = await loadChannels();
    if (!channels) throw new Error('buyer proxy unreachable');
    const pending = pendingSpendFromChannels(channels);
    lastKnown.set(owner, pending);
    return pending;
  }).catch(fallback);
  if (maxWaitMs === undefined) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<bigint>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), maxWaitMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
