import type { AttributedSpendPage } from '../proxy/spend-attribution.js'

const DEFAULT_POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 3_000

/**
 * - `reporting`: the buyer answers and reports attributed spend.
 * - `unsupported`: a buyer answers but predates spend attribution.
 * - `unreachable`: nothing answered on the buyer port.
 */
export type SpendFeedState = 'reporting' | 'unsupported' | 'unreachable'

export interface SpendFeedOptions {
  buyerPort: number
  /** Headers authenticating to a token-protected buyer; read per poll. */
  buyerAuthHeaders?: () => Record<string, string>
  onPage: (page: AttributedSpendPage) => void
  onLog?: (message: string) => void
  intervalMs?: number
  fetchImpl?: typeof fetch
}

/** Polls the buyer for the signed spend of gateway-tagged requests. */
export class SpendFeedPoller {
  private _bootId: string | null = null
  private _after = 0
  private _state: SpendFeedState = 'unreachable'
  private _timer: ReturnType<typeof setInterval> | null = null
  private _polling: Promise<void> | null = null

  constructor(private readonly _options: SpendFeedOptions) {}

  get state(): SpendFeedState {
    return this._state
  }

  start(): void {
    if (this._timer) return
    void this.pollOnce()
    this._timer = setInterval(() => void this.pollOnce(), this._options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this._timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    // Drain spend signed during shutdown so it reaches the ledger.
    await this.pollOnce()
  }

  /** Concurrent callers share the poll already in flight. */
  pollOnce(): Promise<void> {
    this._polling ??= this._drain().finally(() => { this._polling = null })
    return this._polling
  }

  private async _drain(): Promise<void> {
    const fetchImpl = this._options.fetchImpl ?? fetch
    for (;;) {
      let response: Response
      try {
        response = await fetchImpl(
          `http://127.0.0.1:${this._options.buyerPort}/_antseed/attributed-spend?after=${this._after}`,
          { headers: this._options.buyerAuthHeaders?.() ?? {}, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) },
        )
      } catch {
        this._setState('unreachable')
        return
      }
      if (response.status === 404) {
        this._setState('unsupported')
        return
      }
      if (!response.ok) {
        this._setState('unreachable')
        return
      }
      const page = await response.json().catch(() => null) as AttributedSpendPage | null
      if (!page || typeof page.bootId !== 'string' || !Array.isArray(page.events)) {
        this._setState('unsupported')
        return
      }
      this._setState('reporting')
      if (page.bootId !== this._bootId) {
        // A restarted buyer numbers its events from 1 again.
        const restarted = this._bootId !== null
        this._bootId = page.bootId
        if (restarted || this._after > 0) {
          this._after = 0
          continue
        }
      }
      if (this._after > 0 && page.oldestSeq > this._after + 1) {
        this._options.onLog?.(`spend feed dropped events ${this._after + 1}-${page.oldestSeq - 1}`)
      }
      this._options.onPage(page)
      const advanced = page.cursor > this._after
      this._after = page.cursor
      if (!advanced || page.events.length === 0) return
    }
  }

  private _setState(state: SpendFeedState): void {
    if (this._state !== state) this._options.onLog?.(`spend feed: ${state}`)
    this._state = state
  }
}
