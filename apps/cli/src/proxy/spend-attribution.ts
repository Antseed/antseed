import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

/**
 * Opaque tag a trusted local front end (the API-key gateway) attaches to a
 * request so the signed spend for it can be reported back. The buyer never
 * interprets the tag; it strips it before routing and echoes it on each
 * spend event the request produces.
 */
export const SPEND_ATTRIBUTION_HEADER = 'x-antseed-attribution-tag'

/** The feed's database file in the buyer's data dir. */
export const SPEND_ATTRIBUTION_DB_FILE = 'attributed-spend.db'

const TAG_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/
/** Most events kept, acknowledged or not; the oldest go first. */
const MAX_STORED_EVENTS = 100_000
const MAX_EVENTS_PER_PAGE = 1000
/** How long a request's tag is kept for spend signed after the response. */
const TAG_RETENTION_MS = 60 * 60 * 1000
/** Spend without a request id goes to the seller's recent tag only if no other tag used it this recently. */
const UNTAGGED_SPEND_WINDOW_MS = 5 * 60 * 1000
/** Acknowledged events are kept this long (a second reader may still want them). */
const ACKED_RETENTION_MS = 60 * 60 * 1000
/** Unacknowledged events are kept this long, for a gateway that is down. */
const UNACKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 1000

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
  /**
   * Identifies the event sequence. A feed backed by a file keeps it (and its
   * sequence numbers) across buyer restarts; an in-memory feed gets a new
   * one per boot, and its sequence numbers restart with it.
   */
  bootId: string
  /** Lowest sequence number still buffered. A cursor below it lost events. */
  oldestSeq: number
  /** Pass back as `after` on the next poll. */
  cursor: number
  events: AttributedSpendEvent[]
}

export interface SpendAttributionFeedOptions {
  /**
   * SQLite file that keeps events (and request tags) across restarts until
   * a poll acknowledges them. Without one, the feed lives in a temporary
   * database and is lost with the process.
   */
  path?: string
  onLog?: (message: string) => void
}

export function parseSpendAttributionTag(value: string | undefined): string | null {
  const tag = value?.trim() ?? ''
  return TAG_PATTERN.test(tag) ? tag : null
}

/**
 * Event feed of signed spend for gateway-tagged requests. Events are stored
 * in SQLite (a file in the buyer's data dir, so a buyer restart before the
 * gateway polls loses nothing) until an authenticated poll acknowledges
 * them (see `page`). Acknowledged events are pruned after
 * an hour, unacknowledged ones after 7 days. Request tags are retained for an
 * hour so late spend keeps its attribution.
 */
export class SpendAttributionFeed {
  readonly bootId: string
  private readonly _db: Database.Database
  private readonly _track: Database.Statement
  private readonly _lookup: Database.Statement
  private readonly _pruneTags: Database.Statement
  private readonly _insert: Database.Statement
  private readonly _select: Database.Statement
  private readonly _oldest: Database.Statement
  private readonly _ack: Database.Statement
  private readonly _pruneEvents: Database.Statement
  /** When each tag last had spend, per identity and seller, for spend signed without a request id. */
  private readonly _recentTagsBySeller = new Map<string, Map<string, number>>()
  private _lastPruneAt: number | null = null

  constructor(private readonly _now: () => number = () => Date.now(), options: SpendAttributionFeedOptions = {}) {
    this._db = openFeedDatabase(options)
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS request_tags (request_id TEXT PRIMARY KEY, tag TEXT NOT NULL, tracked_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS request_tags_time ON request_tags(tracked_at);
      CREATE TABLE IF NOT EXISTS feed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spend_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tag TEXT NOT NULL,
        request_id TEXT,
        buyer_identity TEXT NOT NULL,
        seller_peer_id TEXT NOT NULL,
        amount_usdc TEXT NOT NULL,
        input_tokens TEXT NOT NULL,
        cached_input_tokens TEXT NOT NULL,
        output_tokens TEXT NOT NULL,
        output_images TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spend_events_time ON spend_events(at);
    `)
    this._db.prepare("INSERT OR IGNORE INTO feed_meta VALUES ('feed_id', ?), ('acked_seq', '0')").run(randomUUID())
    this.bootId = (this._db.prepare("SELECT value FROM feed_meta WHERE key = 'feed_id'").get() as { value: string }).value
    this._track = this._db.prepare('INSERT OR REPLACE INTO request_tags VALUES (?, ?, ?)')
    this._pruneTags = this._db.prepare('DELETE FROM request_tags WHERE tracked_at < ?')
    this._lookup = this._db.prepare('SELECT tag FROM request_tags WHERE request_id = ? AND tracked_at >= ?')
    this._insert = this._db.prepare(`
      INSERT INTO spend_events (tag, request_id, buyer_identity, seller_peer_id, amount_usdc, input_tokens, cached_input_tokens, output_tokens, output_images, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._select = this._db.prepare('SELECT * FROM spend_events WHERE seq > ? ORDER BY seq LIMIT ?')
    // The next seq when the table is empty: sqlite_sequence remembers the last one handed out.
    this._oldest = this._db.prepare(`
      SELECT COALESCE((SELECT MIN(seq) FROM spend_events), (SELECT seq FROM sqlite_sequence WHERE name = 'spend_events') + 1, 1) AS seq
    `)
    this._ack = this._db.prepare(`
      UPDATE feed_meta SET value = CAST(MAX(CAST(value AS INTEGER), ?) AS TEXT) WHERE key = 'acked_seq'
        AND ? <= COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'spend_events'), 0)
    `)
    this._pruneEvents = this._db.prepare(`
      DELETE FROM spend_events WHERE (seq <= (SELECT CAST(value AS INTEGER) FROM feed_meta WHERE key = 'acked_seq') AND at < ?)
        OR at < ? OR seq <= COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'spend_events'), 0) - ?
    `)
    this._prune(this._now())
  }

  track(requestId: string, tag: string): void {
    if (!this._db.open) return
    const now = this._now()
    this._pruneTags.run(now - TAG_RETENTION_MS)
    this._prune(now)
    this._track.run(requestId, tag, now)
  }

  close(): void {
    if (this._db.open) this._db.close()
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
    if (!this._db.open) return
    const now = this._now()
    const sellerKey = `${event.buyerIdentity ?? 'default'}:${event.sellerPeerId}`
    const recentTags = this._recentTagsBySeller.get(sellerKey) ?? new Map<string, number>()
    for (const [recentTag, at] of recentTags) if (at < now - UNTAGGED_SPEND_WINDOW_MS) recentTags.delete(recentTag)
    // Without a request id the spend can only be attributed when exactly one
    // tag (one gateway key's request) is using this identity on this seller.
    const tag = event.requestId
      ? (this._lookup.get(event.requestId, now - TAG_RETENTION_MS) as { tag: string } | undefined)?.tag
      : recentTags.size === 1 ? [...recentTags.keys()][0] : undefined
    if (!tag) return
    recentTags.set(tag, now)
    this._recentTagsBySeller.set(sellerKey, recentTags)
    this._prune(now)
    this._insert.run(
      tag, event.requestId, event.buyerIdentity ?? 'default', event.sellerPeerId, event.amountUsdc,
      event.inputTokens, event.cachedInputTokens, event.outputTokens, event.outputImages, now,
    )
  }

  /**
   * Events after `after`. With `ack` (an authenticated gateway poll), `after`
   * also acknowledges every event up to it: the gateway only advances its
   * cursor past events it has recorded.
   */
  page(after: number, options: { ack?: boolean } = {}): AttributedSpendPage {
    const cursorIn = Number.isSafeInteger(after) ? Math.max(after, 0) : 0
    if (!this._db.open) return { bootId: this.bootId, oldestSeq: cursorIn + 1, cursor: cursorIn, events: [] }
    if (options.ack && cursorIn > 0) this._ack.run(cursorIn, cursorIn)
    const rows = this._select.all(cursorIn, MAX_EVENTS_PER_PAGE) as SpendEventRow[]
    const events = rows.map(toEvent)
    const last = events[events.length - 1]
    return {
      bootId: this.bootId,
      oldestSeq: (this._oldest.get() as { seq: number }).seq,
      cursor: last ? last.seq : cursorIn,
      events,
    }
  }

  private _prune(now: number): void {
    if (this._lastPruneAt !== null && now - this._lastPruneAt < PRUNE_INTERVAL_MS) return
    this._lastPruneAt = now
    this._pruneTags.run(now - TAG_RETENTION_MS)
    this._pruneEvents.run(now - ACKED_RETENTION_MS, now - UNACKED_RETENTION_MS, MAX_STORED_EVENTS)
  }
}

interface SpendEventRow {
  seq: number
  tag: string
  request_id: string | null
  buyer_identity: string
  seller_peer_id: string
  amount_usdc: string
  input_tokens: string
  cached_input_tokens: string
  output_tokens: string
  output_images: string
  at: number
}

function toEvent(row: SpendEventRow): AttributedSpendEvent {
  return {
    seq: row.seq,
    tag: row.tag,
    requestId: row.request_id,
    buyerIdentity: row.buyer_identity,
    sellerPeerId: row.seller_peer_id,
    amountUsdc: row.amount_usdc,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    outputImages: row.output_images,
    at: row.at,
  }
}

/** The feed's database file, or a temporary one when it has none or the file cannot be opened. */
function openFeedDatabase(options: SpendAttributionFeedOptions): Database.Database {
  if (options.path) {
    try {
      mkdirSync(dirname(options.path), { recursive: true })
      const db = new Database(options.path)
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('busy_timeout = 2000')
      return db
    } catch (error) {
      options.onLog?.(`spend attribution: cannot open ${options.path} (${error instanceof Error ? error.message : String(error)}); spend events will not survive a restart`)
    }
  }
  return new Database('')
}
