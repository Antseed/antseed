/**
 * TTL cache for chain reads. Concurrent reads of one key share a load; an
 * expired value is served while it refreshes in the background (when asked
 * to); a failed refresh serves the last good value marked `stale` and does
 * not retry the load until `errorRetryMs` passes, so an RPC outage or rate
 * limit never turns into a retry loop.
 */

export interface CachedRead<T> {
  value: T
  /** True when the value could not be refreshed (the chain is unreachable or rate limited). */
  stale: boolean
  fetchedAt: number
}

export interface ReadOptions {
  ttlMs: number
  /** Serve a value up to this much past its TTL immediately, refreshing it in the background. */
  staleWhileRevalidateMs?: number
  /** Ignore a cached value younger than the TTL (still shares an in-flight load). */
  force?: boolean
  /** False: a failed refresh is an error, never the last value (for reads that must not be stale). */
  serveStaleOnError?: boolean
  /** Overrides the cache's `errorRetryMs` for this read. */
  errorRetryMs?: number
}

interface Entry {
  value?: unknown
  fetchedAt: number
  hasValue: boolean
  loading: Promise<unknown> | null
  failedAt: number | null
  error: unknown
}

export class ChainReadCache {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number
  private readonly errorRetryMs: number
  private readonly maxEntries: number

  constructor(options: { now?: () => number; errorRetryMs?: number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now
    this.errorRetryMs = options.errorRetryMs ?? 10_000
    this.maxEntries = options.maxEntries ?? 5_000
  }

  async read<T>(key: string, options: ReadOptions, load: () => Promise<T>): Promise<CachedRead<T>> {
    const entry = this.entry(key)
    const now = this.now()
    const fresh = entry.hasValue && now - entry.fetchedAt < options.ttlMs
    if (fresh && !options.force) return { value: entry.value as T, stale: false, fetchedAt: entry.fetchedAt }
    const staleOnError = options.serveStaleOnError !== false
    const recentlyFailed = entry.failedAt !== null && now - entry.failedAt < (options.errorRetryMs ?? this.errorRetryMs)
    if (recentlyFailed && !entry.loading) {
      if (entry.hasValue && staleOnError) return { value: entry.value as T, stale: true, fetchedAt: entry.fetchedAt }
      throw entry.error
    }
    const loading = this.start(key, entry, load)
    if (entry.hasValue && !options.force && now - entry.fetchedAt < options.ttlMs + (options.staleWhileRevalidateMs ?? 0)) {
      loading.catch(() => {})
      return { value: entry.value as T, stale: false, fetchedAt: entry.fetchedAt }
    }
    try {
      const value = await loading as T
      return { value, stale: false, fetchedAt: entry.fetchedAt }
    } catch (error) {
      if (entry.hasValue && staleOnError) return { value: entry.value as T, stale: true, fetchedAt: entry.fetchedAt }
      throw error
    }
  }

  /** The cached value regardless of age, when there is one. */
  peek<T>(key: string): CachedRead<T> | null {
    const entry = this.entries.get(key)
    return entry?.hasValue ? { value: entry.value as T, stale: false, fetchedAt: entry.fetchedAt } : null
  }

  /** Milliseconds since the cached value was read, by the cache's clock; null when none. */
  age(key: string): number | null {
    const entry = this.entries.get(key)
    return entry?.hasValue ? this.now() - entry.fetchedAt : null
  }

  /** Records a value read elsewhere (e.g. one tick of the deposit watcher). */
  set<T>(key: string, value: T): void {
    const entry = this.entry(key)
    entry.value = value
    entry.hasValue = true
    entry.fetchedAt = this.now()
    entry.failedAt = null
    entry.error = undefined
  }

  /** Drops keys equal to `key` or starting with `key` followed by `:`. */
  invalidate(key: string): void {
    for (const existing of this.entries.keys()) {
      if (existing === key || existing.startsWith(`${key}:`)) this.entries.delete(existing)
    }
  }

  private entry(key: string): Entry {
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.entries.delete(oldest)
      }
      entry = { fetchedAt: 0, hasValue: false, loading: null, failedAt: null, error: undefined }
      this.entries.set(key, entry)
    }
    return entry
  }

  private start(key: string, entry: Entry, load: () => Promise<unknown>): Promise<unknown> {
    if (entry.loading) return entry.loading
    const loading = (async () => load())()
    entry.loading = loading
    loading.then((value) => {
      if (this.entries.get(key) !== entry) return
      entry.value = value
      entry.hasValue = true
      entry.fetchedAt = this.now()
      entry.failedAt = null
      entry.error = undefined
    }, (error: unknown) => {
      if (this.entries.get(key) !== entry) return
      entry.failedAt = this.now()
      entry.error = error
    }).finally(() => {
      if (entry.loading === loading) entry.loading = null
    })
    return loading
  }
}
