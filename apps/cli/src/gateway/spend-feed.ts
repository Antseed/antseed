import { VIDEO_BUDGET_CAPABILITY, type AttributedSpendPage } from '../proxy/spend-attribution.js'
import { GATEWAY_CONTROL_HEADER } from '../routing-policy/policy.js'

const DEFAULT_POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 3_000

/**
 * - `reporting`: the buyer answers and reports attributed spend.
 * - `unsupported`: a buyer answers but predates spend attribution.
 * - `unauthorized`: the buyer answered but rejected the gateway's control
 *   secret (different data dirs, or ANTSEED_GATEWAY_CONTROL_SECRET set on
 *   one side only), so it will not hand out spend.
 * - `unreachable`: nothing answered on the buyer port.
 */
export type SpendFeedState = 'reporting' | 'unsupported' | 'unauthorized' | 'unreachable'

/** What to do about an `unauthorized` feed, for logs and error answers. */
export const SPEND_FEED_UNAUTHORIZED_HINT = 'the buyer rejected the gateway control secret: run the gateway and the buyer with the same data dir, or set ANTSEED_GATEWAY_CONTROL_SECRET to the same value for both'

export interface SpendFeedOptions {
  buyerPort: number
  /**
   * Gateway control secret. Sent with each poll so the buyer may treat the
   * cursor as an acknowledgement and prune the events before it.
   */
  controlSecret?: string | null
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
  private _videoBudget = false
  private _timer: ReturnType<typeof setInterval> | null = null
  private _polling: Promise<void> | null = null

  constructor(private readonly _options: SpendFeedOptions) {}

  get state(): SpendFeedState {
    return this._state
  }

  /** Whether the buyer, as last read, refuses videos priced above a key's room (see VIDEO_BUDGET_CAPABILITY). */
  get videoBudgetEnforced(): boolean {
    return this._state === 'reporting' && this._videoBudget
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
          {
            signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
            ...(this._options.controlSecret ? { headers: { [GATEWAY_CONTROL_HEADER]: this._options.controlSecret } } : {}),
          },
        )
      } catch {
        this._setState('unreachable')
        return
      }
      if (response.status === 404) {
        this._setState('unsupported')
        return
      }
      if (response.status === 401 || response.status === 403) {
        this._setState('unauthorized')
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
      this._videoBudget = Array.isArray(page.capabilities) && page.capabilities.includes(VIDEO_BUDGET_CAPABILITY)
      this._setState('reporting')
      if (page.bootId !== this._bootId) {
        // A different feed (an in-memory one after a buyer restart, or a
        // deleted feed file) numbers its events from 1 again.
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
    if (this._state === state) return
    this._state = state
    const hint = state === 'unauthorized' ? ` (${SPEND_FEED_UNAUTHORIZED_HINT})` : ''
    this._options.onLog?.(`spend feed: ${state}${hint}`)
  }
}
