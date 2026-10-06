import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

/**
 * Opaque tag a trusted local front end (the API-key gateway) attaches to a
 * request so the signed spend for it can be reported back. The buyer never
 * interprets the tag; it strips it before routing and echoes it on each
 * spend event the request produces.
 */
export const SPEND_ATTRIBUTION_HEADER = 'x-antseed-attribution-tag'

const TAG_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/
const MAX_BUFFERED_EVENTS = 10_000
const MAX_EVENTS_PER_PAGE = 1000
/** How long a request's tag is kept for spend signed after the response. */
const TAG_RETENTION_MS = 60 * 60 * 1000

export interface AttributedSpendEvent {
  seq: number
  tag: string
  requestId: string | null
  /** Buyer identity whose wallet signed the spend. */
  buyerIdentity: string
  sellerPeerId: string
  /** USDC base units newly authorized by this signature. */
  amountUsdc: string
  inputTokens: string
  cachedInputTokens: string
  outputTokens: string
  outputImages: string
  at: number
}

export interface AttributedSpendPage {
  /** Changes whenever the buyer restarts; sequence numbers restart with it. */
  bootId: string
  /** Lowest sequence number still buffered. A cursor below it lost events. */
  oldestSeq: number
  /** Pass back as `after` on the next poll. */
  cursor: number
  events: AttributedSpendEvent[]
}

export function parseSpendAttributionTag(value: string | undefined): string | null {
  const tag = value?.trim() ?? ''
  return TAG_PATTERN.test(tag) ? tag : null
}

/**
 * Bounded in-memory event feed, with request tags retained for an hour in a
 * temporary SQLite database so late spend keeps its attribution.
 */
export class SpendAttributionFeed {
  readonly bootId = randomUUID()
  private readonly _tags = new Database('')
  private readonly _track: Database.Statement
  private readonly _lookup: Database.Statement
  private readonly _prune: Database.Statement
  private readonly _events: AttributedSpendEvent[] = []
  /** Tag of the latest tagged spend per identity and seller, for spend signed without a request id. */
  private readonly _lastTagBySeller = new Map<string, string>()
  private _nextSeq = 1

  constructor(private readonly _now: () => number = () => Date.now()) {
    this._tags.exec('CREATE TABLE request_tags (request_id TEXT PRIMARY KEY, tag TEXT NOT NULL, tracked_at INTEGER NOT NULL)')
    this._track = this._tags.prepare('INSERT OR REPLACE INTO request_tags VALUES (?, ?, ?)')
    this._prune = this._tags.prepare('DELETE FROM request_tags WHERE tracked_at < ?')
    this._lookup = this._tags.prepare('SELECT tag FROM request_tags WHERE request_id = ?')
  }

  track(requestId: string, tag: string): void {
    const now = this._now()
    this._prune.run(now - TAG_RETENTION_MS)
    this._track.run(requestId, tag, now)
  }

  close(): void {
    this._tags.close()
  }

  record(event: {
    requestId: string | null
    buyerIdentity?: string
    sellerPeerId: string
    amountUsdc: string
    inputTokens: string
    cachedInputTokens: string
    outputTokens: string
    outputImages: string
  }): void {
    if (!this._tags.open) return
    const sellerKey = `${event.buyerIdentity ?? 'default'}:${event.sellerPeerId}`
    const tag = event.requestId
      ? (this._lookup.get(event.requestId) as { tag: string } | undefined)?.tag
      : this._lastTagBySeller.get(sellerKey)
    if (!tag) return
    this._lastTagBySeller.set(sellerKey, tag)
    this._events.push({
      seq: this._nextSeq++,
      tag,
      requestId: event.requestId,
      buyerIdentity: event.buyerIdentity ?? 'default',
      sellerPeerId: event.sellerPeerId,
      amountUsdc: event.amountUsdc,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      outputImages: event.outputImages,
      at: this._now(),
    })
    if (this._events.length > MAX_BUFFERED_EVENTS) {
      this._events.splice(0, this._events.length - MAX_BUFFERED_EVENTS)
    }
  }

  page(after: number): AttributedSpendPage {
    const events = this._events.filter((event) => event.seq > after).slice(0, MAX_EVENTS_PER_PAGE)
    const last = events[events.length - 1]
    return {
      bootId: this.bootId,
      oldestSeq: this._events[0]?.seq ?? this._nextSeq,
      cursor: last ? last.seq : Math.max(after, 0),
      events,
    }
  }
}
