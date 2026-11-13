import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from './format';
import { IndexerSyncingError } from '../../src/read-state';

/**
 * Per-key in-memory cache with request de-duplication. Pages fetch lazily
 * when opened; navigating back shows the last result instantly and
 * revalidates in the background when it is older than `staleMs`. Finished
 * jobs call `invalidateAll()` so every mounted consumer refetches.
 */

interface Entry {
  data: unknown;
  at: number;
  reconciling?: boolean;
  partial?: boolean;
}

/** How often a view waiting for Antscan to catch up re-reads while the tab is visible. */
export const SYNC_POLL_MS = 3_000;

let generation = 0;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<(clear: boolean, confirmed: boolean) => void>();

/** Clear visible account data only across identity changes; otherwise revalidate in place. */
export function invalidateAll({ clear = false, confirmed = false }: { clear?: boolean; confirmed?: boolean } = {}): void {
  generation++;
  inflight.clear();
  if (clear) cache.clear();
  else for (const entry of cache.values()) {
    entry.at = 0;
    entry.reconciling ||= confirmed;
  }
  for (const listener of listeners) listener(clear, confirmed);
}

export function invalidatePrefix(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const listener of listeners) listener(false, false);
}

/** Re-read once after `SYNC_POLL_MS` while the tab is visible, or as soon as a hidden tab becomes visible. */
export function scheduleSyncCheck(reload: () => void, doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document, timers: Pick<Window, 'setTimeout' | 'clearTimeout'> = window): () => void {
  let done = false;
  const check = () => {
    if (done || doc.visibilityState !== 'visible') return;
    done = true;
    reload();
  };
  const timer = timers.setTimeout(check, SYNC_POLL_MS);
  doc.addEventListener('visibilitychange', check);
  return () => {
    done = true;
    timers.clearTimeout(timer);
    doc.removeEventListener('visibilitychange', check);
  };
}

export interface PageData<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reconciling: boolean;
  partial: boolean;
  updatedAt: number | null;
  refresh: () => void;
}

interface State<T> {
  key: string | null;
  data: T | null;
  error: string | null;
  loading: boolean;
  reconciling: boolean;
  partial: boolean;
  updatedAt: number | null;
}

function readCache<T>(key: string | null): State<T> {
  const hit = key !== null ? cache.get(key) : undefined;
  if (hit) return { key, data: hit.data as T, error: null, loading: false, reconciling: hit.reconciling ?? false, partial: hit.partial ?? false, updatedAt: hit.at };
  return { key, data: null, error: null, loading: key !== null, reconciling: false, partial: false, updatedAt: null };
}

interface PageDataOptions<T> {
  isPartial?: (data: T) => boolean;
  /** The read succeeded but some of it is still waiting for the indexer; keep revalidating and mark it updating. */
  isSyncing?: (data: T) => boolean;
  retryOnError?: boolean;
}

export function usePageData<T>(key: string | null, fetcher: () => Promise<T>, staleMs = 60_000, options: PageDataOptions<T> = {}): PageData<T> {
  const [state, setState] = useState<State<T>>(() => readCache<T>(key));
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const keyRef = useRef(key);
  keyRef.current = key;
  const mountedRef = useRef(true);
  const retryCount = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback((k: string, confirmed = false) => {
    const startedGeneration = generation;
    setState((prev) => {
      const current = prev.key === k ? prev : readCache<T>(k);
      return { ...current, loading: true, error: null, reconciling: confirmed || current.reconciling };
    });
    let promise = inflight.get(k) as Promise<T> | undefined;
    if (!promise) {
      const started = fetcherRef.current();
      promise = started;
      inflight.set(k, started);
      started
        .then((data) => {
          if (startedGeneration !== generation) return;
          const partial = optionsRef.current.isPartial?.(data) ?? false;
          const previous = cache.get(k);
          if (optionsRef.current.isSyncing?.(data)) {
            const keep = previous && !optionsRef.current.isSyncing(previous.data as T);
            cache.set(k, { data: keep ? previous.data : data, at: 0, partial: keep ? previous.partial : partial, reconciling: true });
            return;
          }
          const retain = partial && previous && !optionsRef.current.isPartial?.(previous.data as T);
          cache.set(k, { data: retain ? previous.data : data, at: retain ? previous.at : Date.now(), partial });
        })
        .catch(() => undefined)
        .finally(() => {
          if (inflight.get(k) === started) inflight.delete(k);
        });
    }
    promise.then(
      () => {
        if (!mountedRef.current || keyRef.current !== k || startedGeneration !== generation) return;
        setState(readCache<T>(k));
      },
      (error: unknown) => {
        if (!mountedRef.current || keyRef.current !== k || startedGeneration !== generation) return;
        const syncing = error instanceof IndexerSyncingError;
        const hit = cache.get(k);
        if (syncing && hit) {
          hit.at = 0;
          hit.reconciling = true;
        }
        setState((prev) => {
          const current = prev.key === k ? prev : readCache<T>(k);
          return { ...current, key: k, loading: false, reconciling: syncing || current.reconciling, error: syncing ? null : describeError(error) };
        });
      },
    );
  }, []);

  useEffect(() => {
    if (key === null) {
      setState(readCache<T>(null));
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setState(readCache<T>(key));
      if (!hit.partial && Date.now() - hit.at < staleMs) return;
    }
    load(key);
  }, [key, load, staleMs]);

  useEffect(() => {
    const listener = (clear: boolean, confirmed: boolean) => {
      if (keyRef.current !== null) {
        // Keep the shell mounted, but do not display the previous wallet's balances.
        if (clear && keyRef.current !== 'config') setState(readCache<T>(keyRef.current));
        load(keyRef.current, confirmed && !clear);
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [load]);

  const refresh = useCallback(() => {
    if (keyRef.current !== null) load(keyRef.current);
  }, [load]);

  useEffect(() => {
    retryCount.current = 0;
  }, [key]);

  useEffect(() => {
    if (!state.error) {
      if (!state.loading) retryCount.current = 0;
      return;
    }
    if (optionsRef.current.retryOnError === false || key === null || retryCount.current >= 2 || !/rate limit|network error|HTTP 5\d\d|timeout/i.test(state.error)) return;
    const timer = window.setTimeout(() => {
      retryCount.current += 1;
      load(key);
    }, 25_000 * (retryCount.current + 1));
    return () => window.clearTimeout(timer);
  }, [key, state.error, state.loading, load]);

  const waiting = state.key === key && state.reconciling && !state.error;
  useEffect(() => {
    if (!waiting || state.loading || key === null) return;
    return scheduleSyncCheck(() => load(key));
  }, [key, waiting, state.loading, load]);

  const view = state.key === key ? state : readCache<T>(key);
  return { data: view.data, error: view.error, loading: view.loading, reconciling: view.reconciling, partial: view.partial, updatedAt: view.updatedAt, refresh };
}
