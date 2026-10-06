import { randomUUID } from 'node:crypto'

/**
 * Opaque tag a trusted local front end (the API-key gateway) attaches to a
 * request so the signed spend for it can be reported back. The buyer never
 * interprets the tag; it strips it before routing and echoes it on each
 * spend event the request produces.
 */
export const SPEND_ATTRIBUTION_HEADER = 'x-antseed-attribution-tag'

const TAG_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/
const MAX_TRACKED_REQUESTS = 2048
const MAX_BUFFERED_EVENTS = 10_000
const MAX_EVENTS_PER_PAGE = 1000

export interface AttributedSpendEvent {
  seq: number
  tag: string
  requestId: string
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
 * Bounded in-memory feed of spend events for tagged requests. Consumers poll
 * it with a cursor; events are kept for the most recent requests only, which
 * is enough for a co-located gateway that polls every few seconds.
 */
export class SpendAttributionFeed {
  readonly bootId = randomUUID()
  private readonly _tags = new Map<string, string>()
  private readonly _events: AttributedSpendEvent[] = []
  private _nextSeq = 1

  constructor(private readonly _now: () => number = () => Date.now()) {}

  track(requestId: string, tag: string): void {
    this._tags.set(requestId, tag)
    while (this._tags.size > MAX_TRACKED_REQUESTS) {
      const oldest = this._tags.keys().next().value
      if (oldest === undefined) break
      this._tags.delete(oldest)
    }
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
    if (!event.requestId) return
    const tag = this._tags.get(event.requestId)
    if (!tag) return
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
