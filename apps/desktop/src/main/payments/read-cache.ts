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

/*
 * Invalidation is versioned rather than flag-based. TanStack's
 * `invalidateQueries` only flags a query, and a fetch already in flight still
 * lands and clears that flag, so a balance read that started before a deposit
 * was credited would be cached (and handed to a `refreshFresh` caller) as
 * fresh. Instead every invalidation bumps a generation counter that is part of
 * the query key: reads started earlier finish under the old key, which no
 * caller asks for again and the cache garbage-collects.
 */
const generations = new Map<string, number>();

function scopeId(scope: QueryKey): string {
  return JSON.stringify(scope);
}

/** Sum of the counters of every prefix of `key`, so global and scoped bumps both apply. */
function generationOf(key: QueryKey): number {
  let total = 0;
  for (let length = 0; length <= key.length; length++) {
    total += generations.get(scopeId(key.slice(0, length))) ?? 0;
  }
  return total;
}

function bump(scope: QueryKey): void {
  const id = scopeId(scope);
  generations.set(id, (generations.get(id) ?? 0) + 1);
}

function versioned(key: QueryKey): QueryKey {
  return [...key, { generation: generationOf(key) }];
}

/** `read()` unless a result for `key` younger than `freshMs` exists or is in flight. */
export function cachedRead<T>(key: QueryKey, freshMs: number | ((data: T | undefined) => number), read: () => Promise<T>): Promise<T> {
  return client.fetchQuery({
    queryKey: versioned(key),
    queryFn: read,
    staleTime: typeof freshMs === 'number' ? freshMs : (query) => freshMs(query.state.data as T | undefined),
  });
}

/**
 * Always start a new chain read, never joining one that began earlier, and
 * make its result what display callers see next. Display callers arriving
 * while it runs share it.
 */
export function refreshFresh<T>(key: QueryKey, read: () => Promise<T>): Promise<T> {
  bump(key);
  return client.fetchQuery({ queryKey: versioned(key), queryFn: read, staleTime: 0 });
}

/** Make the next read of every key (or of `scope`, e.g. `['channels']`) go to the chain. */
export function invalidateChainReads(scope: QueryKey = []): void {
  bump(scope);
}

/** Drop everything, e.g. when the wallet or chain changes. */
export function clearChainReads(): void {
  bump([]);
  client.clear();
}
