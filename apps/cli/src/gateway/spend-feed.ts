import type { AttributedSpendPage } from '../proxy/spend-attribution.js'

const DEFAULT_POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 3_000

/**
 * - `reporting`: the buyer answers and reports attributed spend.
 * - `unsupported`: a buyer answers but predates spend attribution.
 * - `unreachable`: nothing answered on the buyer port.
 */
export type SpendFeedState = 'reporting' | 'unsupported' | 'unreachable'

export interface SpendFeedTarget {
  identityId: string
  port: number
}

export interface SpendFeedOptions {
  targets: () => SpendFeedTarget[]
  onPage: (identityId: string, page: AttributedSpendPage) => void
  onLog?: (message: string) => void
  intervalMs?: number
  fetchImpl?: typeof fetch
}

type Cursor = { bootId: string | null; after: number; state: SpendFeedState }

/** Polls each identity's buyer for the signed spend of gateway-tagged requests. */
export class SpendFeedPoller {
  private readonly _cursors = new Map<string, Cursor>()
  private _timer: ReturnType<typeof setInterval> | null = null
  private _polling = false

  constructor(private readonly _options: SpendFeedOptions) {}

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

  state(identityId: string): SpendFeedState {
    return this._cursors.get(identityId)?.state ?? 'unreachable'
  }

  async pollOnce(): Promise<void> {
    if (this._polling) return
    this._polling = true
    try {
      await Promise.all(this._options.targets().map((target) => this._poll(target)))
    } finally {
      this._polling = false
    }
  }

  private async _poll(target: SpendFeedTarget): Promise<void> {
    const cursor = this._cursors.get(target.identityId) ?? { bootId: null, after: 0, state: 'unreachable' as SpendFeedState }
    this._cursors.set(target.identityId, cursor)
    const fetchImpl = this._options.fetchImpl ?? fetch
    for (;;) {
      let response: Response
      try {
        response = await fetchImpl(
          `http://127.0.0.1:${target.port}/_antseed/attributed-spend?after=${cursor.after}`,
          { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) },
        )
      } catch {
        this._setState(target.identityId, cursor, 'unreachable')
        return
      }
      if (response.status === 404) {
        this._setState(target.identityId, cursor, 'unsupported')
        return
      }
      if (!response.ok) {
        this._setState(target.identityId, cursor, 'unreachable')
        return
      }
      const page = await response.json().catch(() => null) as AttributedSpendPage | null
      if (!page || typeof page.bootId !== 'string' || !Array.isArray(page.events)) {
        this._setState(target.identityId, cursor, 'unsupported')
        return
      }
      this._setState(target.identityId, cursor, 'reporting')
      if (page.bootId !== cursor.bootId) {
        // A restarted buyer numbers its events from 1 again.
        const restarted = cursor.bootId !== null
        cursor.bootId = page.bootId
        if (restarted || cursor.after > 0) {
          cursor.after = 0
          continue
        }
      }
      if (cursor.after > 0 && page.oldestSeq > cursor.after + 1) {
        this._options.onLog?.(`spend feed for ${target.identityId} dropped events ${cursor.after + 1}-${page.oldestSeq - 1}`)
      }
      this._options.onPage(target.identityId, page)
      const advanced = page.cursor > cursor.after
      cursor.after = page.cursor
      if (!advanced || page.events.length === 0) return
    }
  }

  private _setState(identityId: string, cursor: Cursor, state: SpendFeedState): void {
    if (cursor.state !== state) this._options.onLog?.(`spend feed for ${identityId}: ${state}`)
    cursor.state = state
  }
}
