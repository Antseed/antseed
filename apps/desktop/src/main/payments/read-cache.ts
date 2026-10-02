/**
 * One TanStack Query cache for the chain-backed reads the renderer polls.
 *
 * Every view, the reminder module, chat and the balance timer reach these
 * reads through IPC, each on its own timer and focus handler. Routing the
 * handlers through `fetchQuery` here means concurrent callers share one
 * request and a burst of refreshes inside the freshness window is served from
 * memory instead of the chain. Anything that changes the underlying state
 * (payment, claim, deposit, channel close, identity or config change) calls
 * `invalidateChainReads()` so the next read is fresh.
 */
import { QueryClient, type QueryKey } from '@tanstack/query-core';

/** Credits are polled every 5s while a payment card waits for funds; stay under that. */
export const CREDITS_FRESH_MS = 4_000;
/** On-chain channel status only changes on settle/close, which invalidates. */
export const CHANNELS_FRESH_MS = 20_000;
/** Rewards accrue per epoch; claims and stakes invalidate. */
export const REWARDS_FRESH_MS = 60_000;
/** A failed rewards read is retried after this, not on every 3s home-view tick. */
export const REWARDS_ERROR_FRESH_MS = 15_000;

const client = new QueryClient({
  defaultOptions: {
    // The read functions do their own fallbacks; no hidden retries, and a
    // desktop app has no browser "online" signal to wait for.
    queries: { retry: false, networkMode: 'always', structuralSharing: false, gcTime: 10 * 60_000 },
  },
});

export const readKeys = {
  credits: (address: string) => ['credits', address.toLowerCase()] as const,
  channelStatus: (channelSetHash: string) => ['channels', channelSetHash] as const,
  rewards: (address: string, chain: string) => ['rewards', address.toLowerCase(), chain] as const,
};

/** `read()` unless a result for `key` younger than `freshMs` exists or is in flight. */
export function cachedRead<T>(key: QueryKey, freshMs: number | ((data: T | undefined) => number), read: () => Promise<T>): Promise<T> {
  return client.fetchQuery({
    queryKey: key,
    queryFn: read,
    staleTime: typeof freshMs === 'number' ? freshMs : (query) => freshMs(query.state.data as T | undefined),
  });
}

/** Always read the chain (bypassing any cached value) and store the result for display callers. */
export async function refreshFresh<T>(key: QueryKey, read: () => Promise<T>): Promise<T> {
  await client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
  return client.fetchQuery({ queryKey: key, queryFn: read, staleTime: 0 });
}

/** Mark reads stale so the next caller refetches; `scope` limits it to one kind (e.g. `['channels']`). */
export function invalidateChainReads(scope?: QueryKey): void {
  void client.invalidateQueries(scope ? { queryKey: scope, refetchType: 'none' } : { refetchType: 'none' });
}

/** Drop everything, e.g. when the wallet or chain changes. */
export function clearChainReads(): void {
  client.clear();
}
