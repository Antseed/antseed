/**
 * Slow reads (DHT discovery, chain RPC) never block a request and never run
 * on their own: `read` returns the last value and starts one background load
 * (single-flight) when it is stale, so nothing is read while nobody looks.
 * Failed loads keep the previous value and retry with exponential back-off;
 * a forced refresh is ignored inside `minRefreshMs` of the last load.
 */
export interface BackgroundValueOptions<T> {
  /** How long a loaded value stays fresh, in ms; a function for values that expire at a known time (e.g. epoch end). */
  ttlMs: number | ((value: T, loadedAt: number) => number)
  /** First retry delay after a failure; doubles per failure up to `maxBackoffMs`. */
  backoffMs?: number
  maxBackoffMs?: number
  /** Floor between loads even when forced (the dashboard's Refresh button). */
  minRefreshMs?: number
  now?: () => number
}

export class BackgroundValue<T> {
  private _value: T | null = null
  private _at: number | null = null
  private _expiresAt = 0
  private _error: string | null = null
  private _failures = 0
  private _running: Promise<void> | null = null
  private _attempt: number | null = null
  private readonly _now: () => number
  /** Loads started, for tests and diagnostics. */
  loads = 0

  constructor(private readonly _load: () => Promise<T>, private readonly _options: BackgroundValueOptions<T>) {
    this._now = _options.now ?? Date.now
  }

  read(force = false): { value: T | null; at: number | null; error: string | null; refreshing: boolean } {
    const now = this._now()
    const stale = this._at === null || now >= this._expiresAt
    const backoff = Math.min((this._options.backoffMs ?? 60_000) * 2 ** Math.max(0, this._failures - 1), this._options.maxBackoffMs ?? 15 * 60_000)
    const retryDue = this._attempt === null || this._failures === 0 || now - this._attempt >= backoff
    const forceAllowed = force && (this._attempt === null || now - this._attempt >= (this._options.minRefreshMs ?? 30_000))
    if (!this._running && ((stale && retryDue) || forceAllowed)) void this.refresh()
    return { value: this._value, at: this._at, error: this._error, refreshing: this._running !== null }
  }

  /** The current load, or a new one (single-flight). */
  refresh(): Promise<void> {
    if (this._running) return this._running
    this._attempt = this._now()
    this.loads += 1
    this._running = this._load().then(
      (value) => {
        const at = this._now()
        const ttl = typeof this._options.ttlMs === 'function' ? this._options.ttlMs(value, at) : this._options.ttlMs
        this._value = value
        this._at = at
        this._expiresAt = at + ttl
        this._error = null
        this._failures = 0
      },
      (error: unknown) => {
        this._error = error instanceof Error ? error.message : String(error)
        this._failures += 1
      },
    ).finally(() => { this._running = null })
    return this._running
  }

  /** The value, loading it first when there is none yet (one-shot CLI commands). */
  async get(force = false): Promise<{ value: T | null; at: number | null; error: string | null }> {
    if (this._value === null || force) await this.refresh()
    const { value, at, error } = this.read()
    return { value, at, error }
  }
}
