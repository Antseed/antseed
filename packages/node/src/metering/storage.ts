import Database from 'better-sqlite3';
import type {
  MeteringEvent,
  UsageReceipt,
  ReceiptVerification,
  SessionMetrics,
  TokenCount,
} from '../types/metering.js';
import { runMigrations } from '../storage/migrate.js';
import { meteringMigrations } from '../storage/migrations/metering/index.js';

/**
 * `stake` is the shared allowance of a staked owner (the buyer or its operator);
 * `stake_required` refuses a buyer without qualifying stake on a stakers-only program.
 */
export type FreeTierLimitKind = 'address' | 'ip' | 'stake' | 'stake_required';

export interface FreeTierConsumption {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  /** Which limit denied the request, or null when allowed. */
  limitedBy: FreeTierLimitKind | null;
}

export interface FreeTierUsageInput {
  buyerAddress: string;
  remoteIp: string | null;
  maxRequestsPerAddress: number | null;
  maxRequestsPerIp: number | null;
  windowMs: number;
  nowMs?: number;
  /**
   * Program the request is counted under: '' for the seller-wide program, or
   * the service id of a service with its own. Counters never cross scopes.
   */
  scope?: string;
  /**
   * How long usage must be kept for any program; older rows are pruned.
   * Default: `windowMs`. Set it to the longest window when programs differ.
   */
  retentionMs?: number;
  /**
   * Staked allowance. When set, the request is counted on each of these
   * seller-pool positions instead of the per-address and per-IP limits, and
   * is admitted while every position has room. A null limit is unlimited.
   */
  stake?: { positionIds: number[]; limit: number | null } | null;
}

export interface FreeTierLimitCheck {
  kind: FreeTierLimitKind;
  limit: number;
  /** Requests already recorded for this key inside the window. */
  count: number;
  /** Oldest recorded timestamp inside the window, or null when none. */
  oldestTimestamp: number | null;
}

/**
 * Decide whether one more request fits under every given limit.
 * When several limits are exhausted, the longest retry wait is reported.
 */
export function evaluateFreeTierLimits(
  checks: FreeTierLimitCheck[],
  windowMs: number,
  nowMs: number,
): FreeTierConsumption {
  let denied: FreeTierConsumption | null = null;
  let remaining = Number.POSITIVE_INFINITY;
  for (const check of checks) {
    if (check.count >= check.limit) {
      const retryAfterMs = check.oldestTimestamp === null
        ? windowMs
        : Math.max(1, check.oldestTimestamp + windowMs - nowMs);
      if (!denied || retryAfterMs > denied.retryAfterMs) {
        denied = { allowed: false, remaining: 0, retryAfterMs, limitedBy: check.kind };
      }
    }
    remaining = Math.min(remaining, check.limit - check.count - 1);
  }
  if (denied) return denied;
  return {
    allowed: true,
    remaining: Number.isFinite(remaining) ? remaining : 0,
    retryAfterMs: 0,
    limitedBy: null,
  };
}

/**
 * SQLite storage for metering data.
 * All data is stored locally on the user's machine.
 */
const DAY_MS = 86_400_000;

export interface EventDayTotals {
  /** UTC day number (`timestamp / 86_400_000`, floored). */
  day: number;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReceiptDayTotals {
  day: number;
  costCents: number;
}

export interface RowidChunkSummary<T> {
  /** Highest rowid read; the cursor for the next call. */
  lastRowid: number;
  /** Rows read in this chunk. */
  rows: number;
  days: T[];
}

/** Rows a filtered request-log page walks before handing back a continuation. */
const DEFAULT_EVENT_SCAN_LIMIT = 5_000;

export class MeteringStorage {
  private readonly db: Database.Database;
  private lastFreeTierPruneAt: number | null = null;

  /**
   * Open or create the SQLite database at the given path.
   * Creates tables if they don't exist.
   *
   * @param dbPath - Path to the SQLite database file (or ':memory:' for tests)
   * @param options.readonly - Open an existing database for reads only, without
   *   migrations (e.g. a metrics exporter beside a running seller).
   */
  constructor(dbPath: string, options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      return;
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db, meteringMigrations);
  }

  // --- Metering Events ---

  /** Insert a metering event. */
  insertEvent(event: MeteringEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO metering_events (
        event_id, session_id, timestamp, provider,
        seller_peer_id, buyer_peer_id,
        input_tokens, output_tokens, total_tokens,
        token_method, token_confidence,
        latency_ms, status_code, was_streaming, service, error, cached_input_tokens, request_id
      ) VALUES (
        @eventId, @sessionId, @timestamp, @provider,
        @sellerPeerId, @buyerPeerId,
        @inputTokens, @outputTokens, @totalTokens,
        @tokenMethod, @tokenConfidence,
        @latencyMs, @statusCode, @wasStreaming, @service, @error, @cachedInputTokens, @requestId
      )
    `);

    stmt.run({
      eventId: event.eventId,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      provider: event.provider,
      sellerPeerId: event.sellerPeerId,
      buyerPeerId: event.buyerPeerId,
      inputTokens: event.tokens.inputTokens,
      outputTokens: event.tokens.outputTokens,
      totalTokens: event.tokens.totalTokens,
      tokenMethod: event.tokens.method,
      tokenConfidence: event.tokens.confidence,
      latencyMs: event.latencyMs,
      statusCode: event.statusCode,
      wasStreaming: event.wasStreaming ? 1 : 0,
      service: event.service ?? null,
      error: event.error ?? null,
      cachedInputTokens: event.cachedInputTokens ?? null,
      requestId: event.requestId ?? null,
    });
  }

  /** Get events for a session. */
  getEventsBySession(sessionId: string): MeteringEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM metering_events WHERE session_id = ? ORDER BY timestamp'
    );
    const rows = stmt.all(sessionId) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Get events in a time range. */
  getEventsByTimeRange(startMs: number, endMs: number): MeteringEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM metering_events WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp'
    );
    const rows = stmt.all(startMs, endMs) as EventRow[];
    return rows.map(rowToEvent);
  }

  // --- Usage Receipts ---

  /** Insert a usage receipt. */
  insertReceipt(receipt: UsageReceipt): void {
    const stmt = this.db.prepare(`
      INSERT INTO usage_receipts (
        receipt_id, session_id, event_id, timestamp, provider,
        seller_peer_id, buyer_peer_id,
        input_tokens, output_tokens, total_tokens,
        token_method, token_confidence,
        unit_price_cents_per_thousand_tokens, cost_cents, signature
      ) VALUES (
        @receiptId, @sessionId, @eventId, @timestamp, @provider,
        @sellerPeerId, @buyerPeerId,
        @inputTokens, @outputTokens, @totalTokens,
        @tokenMethod, @tokenConfidence,
        @unitPriceCentsPerThousandTokens, @costCents, @signature
      )
    `);

    stmt.run({
      receiptId: receipt.receiptId,
      sessionId: receipt.sessionId,
      eventId: receipt.eventId,
      timestamp: receipt.timestamp,
      provider: receipt.provider,
      sellerPeerId: receipt.sellerPeerId,
      buyerPeerId: receipt.buyerPeerId,
      inputTokens: receipt.tokens.inputTokens,
      outputTokens: receipt.tokens.outputTokens,
      totalTokens: receipt.tokens.totalTokens,
      tokenMethod: receipt.tokens.method,
      tokenConfidence: receipt.tokens.confidence,
      unitPriceCentsPerThousandTokens: receipt.unitPriceCentsPerThousandTokens,
      costCents: receipt.costCents,
      signature: receipt.signature,
    });
  }

  /** Get receipts for a session. */
  getReceiptsBySession(sessionId: string): UsageReceipt[] {
    const stmt = this.db.prepare(
      'SELECT * FROM usage_receipts WHERE session_id = ? ORDER BY timestamp'
    );
    const rows = stmt.all(sessionId) as ReceiptRow[];
    return rows.map(rowToReceipt);
  }

  /** Get all receipts in a time range. */
  getReceiptsByTimeRange(startMs: number, endMs: number): UsageReceipt[] {
    const stmt = this.db.prepare(
      'SELECT * FROM usage_receipts WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp'
    );
    const rows = stmt.all(startMs, endMs) as ReceiptRow[];
    return rows.map(rowToReceipt);
  }

  /** Get total cost in a time range (sum of costCents). */
  getTotalCost(startMs: number, endMs: number): number {
    const stmt = this.db.prepare(
      'SELECT COALESCE(SUM(cost_cents), 0) as total FROM usage_receipts WHERE timestamp >= ? AND timestamp < ?'
    );
    const row = stmt.get(startMs, endMs) as { total: number };
    return row.total;
  }

  // --- Receipt Verifications ---

  /** Insert a verification result. */
  insertVerification(verification: ReceiptVerification): void {
    const stmt = this.db.prepare(`
      INSERT INTO receipt_verifications (
        receipt_id, signature_valid,
        buyer_input_tokens, buyer_output_tokens, buyer_total_tokens,
        seller_total_tokens,
        token_difference, percentage_difference,
        disputed, verified_at
      ) VALUES (
        @receiptId, @signatureValid,
        @buyerInputTokens, @buyerOutputTokens, @buyerTotalTokens,
        @sellerTotalTokens,
        @tokenDifference, @percentageDifference,
        @disputed, @verifiedAt
      )
    `);

    stmt.run({
      receiptId: verification.receiptId,
      signatureValid: verification.signatureValid ? 1 : 0,
      buyerInputTokens: verification.buyerTokenEstimate.inputTokens,
      buyerOutputTokens: verification.buyerTokenEstimate.outputTokens,
      buyerTotalTokens: verification.buyerTokenEstimate.totalTokens,
      sellerTotalTokens: verification.sellerTokenEstimate.totalTokens,
      tokenDifference: verification.tokenDifference,
      percentageDifference: verification.percentageDifference,
      disputed: verification.disputed ? 1 : 0,
      verifiedAt: verification.verifiedAt,
    });
  }

  /** Get all disputed verifications in a time range. */
  getDisputedVerifications(startMs: number, endMs: number): ReceiptVerification[] {
    const stmt = this.db.prepare(
      'SELECT * FROM receipt_verifications WHERE disputed = 1 AND verified_at >= ? AND verified_at < ? ORDER BY verified_at'
    );
    const rows = stmt.all(startMs, endMs) as VerificationRow[];
    return rows.map(rowToVerification);
  }

  // --- Sessions ---

  /** Upsert session metrics (insert or update). */
  upsertSession(metrics: SessionMetrics): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id, seller_peer_id, buyer_peer_id, provider,
        started_at, ended_at,
        total_requests, total_tokens, total_cost_cents,
        avg_latency_ms, peer_switches, disputed_receipts
      ) VALUES (
        @sessionId, @sellerPeerId, @buyerPeerId, @provider,
        @startedAt, @endedAt,
        @totalRequests, @totalTokens, @totalCostCents,
        @avgLatencyMs, @peerSwitches, @disputedReceipts
      )
      ON CONFLICT(session_id) DO UPDATE SET
        ended_at = @endedAt,
        total_requests = @totalRequests,
        total_tokens = @totalTokens,
        total_cost_cents = @totalCostCents,
        avg_latency_ms = @avgLatencyMs,
        peer_switches = @peerSwitches,
        disputed_receipts = @disputedReceipts
    `);

    stmt.run({
      sessionId: metrics.sessionId,
      sellerPeerId: metrics.sellerPeerId,
      buyerPeerId: metrics.buyerPeerId,
      provider: metrics.provider,
      startedAt: metrics.startedAt,
      endedAt: metrics.endedAt,
      totalRequests: metrics.totalRequests,
      totalTokens: metrics.totalTokens,
      totalCostCents: metrics.totalCostCents,
      avgLatencyMs: metrics.avgLatencyMs,
      peerSwitches: metrics.peerSwitches,
      disputedReceipts: metrics.disputedReceipts,
    });
  }

  /** Get a session by ID. */
  getSession(sessionId: string): SessionMetrics | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    const row = stmt.get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /** Get all sessions in a time range. */
  getSessionsByTimeRange(startMs: number, endMs: number): SessionMetrics[] {
    const stmt = this.db.prepare(
      'SELECT * FROM sessions WHERE started_at >= ? AND started_at < ? ORDER BY started_at'
    );
    const rows = stmt.all(startMs, endMs) as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Get session count and total cost for a time range. */
  getSessionSummary(startMs: number, endMs: number): {
    channelCount: number;
    totalRequests: number;
    totalTokens: number;
    totalCostCents: number;
  } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as session_count,
        COALESCE(SUM(total_requests), 0) as total_requests,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(total_cost_cents), 0) as total_cost_cents
      FROM sessions
      WHERE started_at >= ? AND started_at < ?
    `);
    const row = stmt.get(startMs, endMs) as {
      session_count: number;
      total_requests: number;
      total_tokens: number;
      total_cost_cents: number;
    };
    return {
      channelCount: row.session_count,
      totalRequests: row.total_requests,
      totalTokens: row.total_tokens,
      totalCostCents: row.total_cost_cents,
    };
  }

  /**
   * One page of the request log, newest first. Keyset pagination on the
   * timestamp index (`before` is the previous page's last `{ timestamp, rowid }`),
   * so a page costs the same at any depth of a multi-GB table.
   * A filtered page walks at most `scanLimit` rows: when they hold fewer
   * matches than asked, `scannedTo` is where the walk stopped, to continue from.
   */
  listEventsPage(query: MeteringEventPageQuery): MeteringEventPage {
    const filters: string[] = [];
    if (query.buyerPeerId) filters.push('e.buyer_peer_id = @buyer');
    if (query.service) filters.push('e.service = @service');
    // A stream that fails after its 200 went out keeps the 200 but records the error.
    if (query.errorsOnly) filters.push("(e.status_code >= 400 OR (e.error IS NOT NULL AND e.error <> ''))");
    const bounds = 'timestamp >= @from AND timestamp <= @beforeTs AND NOT (timestamp = @beforeTs AND rowid >= @beforeRowid)';
    const params = {
      from: query.fromMs ?? 0,
      beforeTs: query.before?.timestamp ?? Number.MAX_SAFE_INTEGER,
      beforeRowid: query.before?.rowid ?? Number.MAX_SAFE_INTEGER,
      buyer: query.buyerPeerId ?? null,
      service: query.service ?? null,
      limit: Math.max(1, Math.min(query.limit, 500)),
      scan: Math.max(1, query.scanLimit ?? DEFAULT_EVENT_SCAN_LIMIT),
    };
    // Unfiltered, every row walked is a row returned; filtered, the walk is the window `scan` rows long.
    const window = filters.length === 0 ? 'metering_events' : `(
        SELECT rowid AS rid FROM metering_events INDEXED BY idx_events_timestamp
        WHERE ${bounds} ORDER BY timestamp DESC, rowid DESC LIMIT @scan
      ) w JOIN metering_events`;
    const rows = this.db.prepare(`
      SELECT e.rowid AS rowid, e.event_id, e.session_id, e.timestamp, e.provider, e.service, e.buyer_peer_id,
        e.input_tokens, e.output_tokens, e.total_tokens, e.token_method, e.latency_ms, e.status_code, e.was_streaming,
        e.error, e.cached_input_tokens, r.cost_cents AS cost_cents
      FROM ${window} e ${filters.length === 0 ? 'INDEXED BY idx_events_timestamp' : 'ON e.rowid = w.rid'}
      LEFT JOIN usage_receipts r ON r.session_id = e.session_id AND r.event_id = e.event_id
      WHERE ${filters.length === 0 ? bounds.replace(/(^|\(| AND )(timestamp|rowid)/g, '$1e.$2') : filters.join(' AND ')}
      ORDER BY e.timestamp DESC, e.rowid DESC
      LIMIT @limit
    `).all(params) as MeteringEventPageRow[];
    if (filters.length === 0 || rows.length >= params.limit) return { rows, scannedTo: null };
    const beyond = this.db.prepare(`
      SELECT timestamp, rowid FROM metering_events INDEXED BY idx_events_timestamp
      WHERE ${bounds} ORDER BY timestamp DESC, rowid DESC LIMIT 2 OFFSET @scan - 1
    `).all(params) as Array<{ timestamp: number; rowid: number }>;
    // Only when rows remain past the window: a walk that reached the end has nothing to continue.
    const edge = beyond.length === 2 ? beyond[0]! : null;
    return { rows, scannedTo: edge ? { timestamp: edge.timestamp, rowid: edge.rowid } : null };
  }

  /**
   * One request of the seller's log with everything kept about it: the event,
   * its signed usage receipt and the buyer's check of it, and its metering session.
   * A short id (the first characters, as the CLI prints them) matches by prefix on
   * the primary key; null when it is unknown or matches more than one request.
   */
  getEventDetail(eventId: string): MeteringEventDetailRow | null {
    // An empty prefix would match every id.
    if (!eventId) return null;
    const matches = this.db.prepare(`
      SELECT e.rowid AS rowid, e.event_id, e.session_id, e.timestamp, e.provider, e.service, e.buyer_peer_id,
        e.input_tokens, e.output_tokens, e.total_tokens, e.token_method, e.latency_ms, e.status_code, e.was_streaming,
        e.error, e.cached_input_tokens, e.token_confidence, e.request_id,
        r.cost_cents AS cost_cents, r.receipt_id, r.unit_price_cents_per_thousand_tokens AS unit_price_cents_per_thousand
      FROM metering_events e
      LEFT JOIN usage_receipts r ON r.session_id = e.session_id AND r.event_id = e.event_id
      WHERE e.event_id >= @id AND e.event_id < @end
      ORDER BY e.event_id
      LIMIT 2
    `).all({ id: eventId, end: eventId.length >= 36 ? `${eventId}\0` : `${eventId}\uffff` }) as MeteringEventDetailRow[];
    // A prefix that matches more than one request names none of them.
    const event = matches.length === 1 || matches[0]?.event_id === eventId ? matches[0] : undefined;
    if (!event) return null;
    const verification = event.receipt_id
      ? this.db.prepare('SELECT signature_valid, buyer_total_tokens, percentage_difference, disputed FROM receipt_verifications WHERE receipt_id = ?')
        .get(event.receipt_id) as MeteringEventDetailRow['verification'] | undefined
      : undefined;
    const session = this.db.prepare(
      'SELECT started_at, ended_at, total_requests, total_tokens, total_cost_cents, avg_latency_ms FROM sessions WHERE session_id = ?',
    ).get(event.session_id) as MeteringEventDetailRow['session'] | undefined;
    // The request's place in its session; sessions are short, so this reads few rows.
    const position = this.db.prepare(
      'SELECT COUNT(*) AS n FROM metering_events WHERE session_id = ? AND (timestamp < ? OR (timestamp = ? AND rowid <= ?))',
    ).get(event.session_id, event.timestamp, event.timestamp, event.rowid) as { n: number };
    return { ...event, verification: verification ?? null, session: session ?? null, session_position: position.n };
  }

  /** Get total tokens from metering events in a time range (real-time, per-request). */
  getEventTokenSummary(startMs: number, endMs: number): {
    totalRequests: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens
      FROM metering_events
      WHERE timestamp >= ? AND timestamp < ?
    `);
    const row = stmt.get(startMs, endMs) as {
      total_requests: number;
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
    };
    return {
      totalRequests: row.total_requests,
      totalTokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    };
  }

  /**
   * Totals of the metering events after `afterRowid`, reading at most `limit`
   * rows in rowid order, grouped by UTC day. Lets a reader keep running totals
   * without re-scanning the whole table: pass the returned `lastRowid` next time.
   */
  summarizeEventsAfter(afterRowid: number, limit: number): RowidChunkSummary<EventDayTotals> {
    const rows = this.db.prepare(`
      SELECT
        timestamp / ${DAY_MS} AS day,
        MAX(rid) AS last_rowid,
        COUNT(*) AS requests,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM (
        SELECT rowid AS rid, timestamp, total_tokens, input_tokens, output_tokens
        FROM metering_events WHERE rowid > ? ORDER BY rowid LIMIT ?
      )
      GROUP BY day
    `).all(afterRowid, limit) as Array<{
      day: number; last_rowid: number; requests: number; total_tokens: number; input_tokens: number; output_tokens: number;
    }>;
    return {
      lastRowid: rows.reduce((max, row) => Math.max(max, row.last_rowid), afterRowid),
      rows: rows.reduce((count, row) => count + row.requests, 0),
      days: rows.map((row) => ({
        day: row.day,
        requests: row.requests,
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
    };
  }

  /** Like `summarizeEventsAfter`, for usage receipt cost. */
  summarizeReceiptsAfter(afterRowid: number, limit: number): RowidChunkSummary<ReceiptDayTotals> {
    const rows = this.db.prepare(`
      SELECT
        timestamp / ${DAY_MS} AS day,
        MAX(rid) AS last_rowid,
        COUNT(*) AS receipts,
        COALESCE(SUM(cost_cents), 0) AS cost_cents
      FROM (
        SELECT rowid AS rid, timestamp, cost_cents
        FROM usage_receipts WHERE rowid > ? ORDER BY rowid LIMIT ?
      )
      GROUP BY day
    `).all(afterRowid, limit) as Array<{ day: number; last_rowid: number; receipts: number; cost_cents: number }>;
    return {
      lastRowid: rows.reduce((max, row) => Math.max(max, row.last_rowid), afterRowid),
      rows: rows.reduce((count, row) => count + row.receipts, 0),
      days: rows.map((row) => ({ day: row.day, costCents: row.cost_cents })),
    };
  }

  /** `event_id` / `receipt_id` stored at the given rowids (null where there is no such row). */
  getIdsAtRowids(eventRowid: number, receiptRowid: number): { eventId: string | null; receiptId: string | null } {
    const event = this.db.prepare('SELECT event_id AS id FROM metering_events WHERE rowid = ?').get(eventRowid) as { id: string } | undefined;
    const receipt = this.db.prepare('SELECT receipt_id AS id FROM usage_receipts WHERE rowid = ?').get(receiptRowid) as { id: string } | undefined;
    return { eventId: event?.id ?? null, receiptId: receipt?.id ?? null };
  }

  /** Highest rowid in `metering_events` and `usage_receipts` (0 when empty). */
  getMaxRowids(): { events: number; receipts: number } {
    const events = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM metering_events').get() as { m: number };
    const receipts = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM usage_receipts').get() as { m: number };
    return { events: events.m, receipts: receipts.m };
  }

  /**
   * Atomically consume one seller free-tier request in a sliding window.
   * Each configured limit (buyer address, remote IP) is checked; the request
   * is recorded only when every applicable limit still has headroom.
   */
  consumeFreeTierRequest(input: FreeTierUsageInput & { service: string }): FreeTierConsumption {
    return this.evaluateFreeTierRequest(input, input.service);
  }

  /** Check admission without recording a request or changing the quota. */
  checkFreeTierRequest(input: FreeTierUsageInput): FreeTierConsumption {
    return this.evaluateFreeTierRequest(input, null);
  }

  private evaluateFreeTierRequest(input: FreeTierUsageInput, service: string | null): FreeTierConsumption {
    const nowMs = input.nowMs ?? Date.now();
    const windowStart = nowMs - input.windowMs;
    const buyerAddress = input.buyerAddress.toLowerCase();
    const remoteIp = input.remoteIp ?? '';
    const stake = input.stake ?? null;
    const scope = input.scope ?? '';
    const pruneIntervalMs = Math.min(input.windowMs, 60 * 60_000);
    if (
      service !== null && (
        this.lastFreeTierPruneAt === null
        || nowMs < this.lastFreeTierPruneAt
        || nowMs - this.lastFreeTierPruneAt >= pruneIntervalMs
      )
    ) {
      const retainFrom = nowMs - Math.max(input.windowMs, input.retentionMs ?? 0);
      this.db.prepare('DELETE FROM free_tier_usage WHERE timestamp < ?').run(retainFrom);
      this.db.prepare('DELETE FROM free_tier_position_usage WHERE timestamp < ?').run(retainFrom);
      this.lastFreeTierPruneAt = nowMs;
    }
    // Base limits count only unstaked requests, so staked traffic never uses
    // up the allowance of unstaked buyers sharing an address or network.
    const countBaseUsage = (column: 'buyer_address' | 'remote_ip', key: string): { count: number; oldestTimestamp: number | null } => {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS request_count, MIN(timestamp) AS oldest_timestamp
        FROM free_tier_usage
        WHERE scope = ? AND ${column} = ? AND staked = 0 AND timestamp >= ?
      `).get(scope, key, windowStart) as { request_count: number; oldest_timestamp: number | null };
      return { count: row.request_count, oldestTimestamp: row.oldest_timestamp };
    };
    const countPositionUsage = (positionId: number): { count: number; oldestTimestamp: number | null } => {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS request_count, MIN(timestamp) AS oldest_timestamp
        FROM free_tier_position_usage
        WHERE scope = ? AND position_id = ? AND timestamp >= ?
      `).get(scope, positionId, windowStart) as { request_count: number; oldest_timestamp: number | null };
      return { count: row.request_count, oldestTimestamp: row.oldest_timestamp };
    };
    const consume = this.db.transaction((): FreeTierConsumption => {
      const checks: FreeTierLimitCheck[] = [];
      if (stake) {
        if (stake.limit !== null) {
          for (const positionId of stake.positionIds) {
            checks.push({ kind: 'stake', limit: stake.limit, ...countPositionUsage(positionId) });
          }
        }
      } else {
        if (input.maxRequestsPerAddress !== null) {
          checks.push({ kind: 'address', limit: input.maxRequestsPerAddress, ...countBaseUsage('buyer_address', buyerAddress) });
        }
        if (input.maxRequestsPerIp !== null && remoteIp !== '') {
          checks.push({ kind: 'ip', limit: input.maxRequestsPerIp, ...countBaseUsage('remote_ip', remoteIp) });
        }
      }
      const decision = evaluateFreeTierLimits(checks, input.windowMs, nowMs);
      if (decision.allowed && service !== null) {
        this.db.prepare(`
          INSERT INTO free_tier_usage (buyer_address, remote_ip, service, timestamp, staked, scope)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(buyerAddress, remoteIp, service, nowMs, stake ? 1 : 0, scope);
        if (stake && stake.limit !== null) {
          const recordPosition = this.db.prepare('INSERT INTO free_tier_position_usage (position_id, timestamp, scope) VALUES (?, ?, ?)');
          for (const positionId of stake.positionIds) recordPosition.run(positionId, nowMs, scope);
        }
      }
      return decision;
    });
    return consume();
  }

  /** Get aggregated metering stats for a specific seller peer. */
  getEventStatsByPeer(sellerPeerId: string): {
    totalRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCostCents: number;
    firstEventAt: number | null;
    lastEventAt: number | null;
  } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        MIN(timestamp) as first_event_at,
        MAX(timestamp) as last_event_at,
        (SELECT COALESCE(SUM(total_cost_cents), 0) FROM sessions WHERE seller_peer_id = ?) as total_cost_cents
      FROM metering_events
      WHERE seller_peer_id = ?
    `).get(sellerPeerId, sellerPeerId) as {
      total_requests: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      first_event_at: number | null;
      last_event_at: number | null;
      total_cost_cents: number;
    };
    return {
      totalRequests: row.total_requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      totalCostCents: row.total_cost_cents,
      firstEventAt: row.first_event_at,
      lastEventAt: row.last_event_at,
    };
  }

  // --- Maintenance ---

  /**
   * Delete data older than the given timestamp.
   * Used for storage maintenance / retention policy.
   */
  pruneOlderThan(timestampMs: number): {
    eventsDeleted: number;
    receiptsDeleted: number;
    verificationsDeleted: number;
    sessionsDeleted: number;
    freeTierUsageDeleted: number;
  } {
    const deleteEvents = this.db.prepare(
      'DELETE FROM metering_events WHERE timestamp < ?'
    );
    const deleteReceipts = this.db.prepare(
      'DELETE FROM usage_receipts WHERE timestamp < ?'
    );
    const deleteVerifications = this.db.prepare(
      'DELETE FROM receipt_verifications WHERE verified_at < ?'
    );
    const deleteSessions = this.db.prepare(
      'DELETE FROM sessions WHERE started_at < ?'
    );
    const deleteFreeTierUsage = this.db.prepare(
      'DELETE FROM free_tier_usage WHERE timestamp < ?'
    );

    const eventsResult = deleteEvents.run(timestampMs);
    const receiptsResult = deleteReceipts.run(timestampMs);
    const verificationsResult = deleteVerifications.run(timestampMs);
    const sessionsResult = deleteSessions.run(timestampMs);
    const freeTierUsageResult = deleteFreeTierUsage.run(timestampMs);
    this.db.prepare('DELETE FROM free_tier_position_usage WHERE timestamp < ?').run(timestampMs);

    return {
      eventsDeleted: eventsResult.changes,
      receiptsDeleted: receiptsResult.changes,
      verificationsDeleted: verificationsResult.changes,
      sessionsDeleted: sessionsResult.changes,
      freeTierUsageDeleted: freeTierUsageResult.changes,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

// --- Row types for SQLite results ---

interface EventRow {
  event_id: string;
  session_id: string;
  timestamp: number;
  provider: string;
  seller_peer_id: string;
  buyer_peer_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  token_method: string;
  token_confidence: string;
  latency_ms: number;
  status_code: number;
  was_streaming: number;
  /** Null on rows written before migrations 6 and 7. */
  service: string | null;
  error: string | null;
  cached_input_tokens: number | null;
  request_id: string | null;
}

interface ReceiptRow {
  receipt_id: string;
  session_id: string;
  event_id: string;
  timestamp: number;
  provider: string;
  seller_peer_id: string;
  buyer_peer_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  token_method: string;
  token_confidence: string;
  unit_price_cents_per_thousand_tokens: number;
  cost_cents: number;
  signature: string;
}

interface VerificationRow {
  receipt_id: string;
  signature_valid: number;
  buyer_input_tokens: number;
  buyer_output_tokens: number;
  buyer_total_tokens: number;
  seller_total_tokens: number;
  token_difference: number;
  percentage_difference: number;
  disputed: number;
  verified_at: number;
}

interface SessionRow {
  session_id: string;
  seller_peer_id: string;
  buyer_peer_id: string;
  provider: string;
  started_at: number;
  ended_at: number | null;
  total_requests: number;
  total_tokens: number;
  total_cost_cents: number;
  avg_latency_ms: number;
  peer_switches: number;
  disputed_receipts: number;
}

// --- Row mapping functions ---

const VALID_TOKEN_METHODS = new Set(['content-length', 'chunk-accumulation', 'fallback']);
const VALID_TOKEN_CONFIDENCES = new Set(['high', 'medium', 'low']);

function validateTokenMethod(value: string): TokenCount['method'] {
  if (VALID_TOKEN_METHODS.has(value)) return value as TokenCount['method'];
  return 'fallback';
}

function validateTokenConfidence(value: string): TokenCount['confidence'] {
  if (VALID_TOKEN_CONFIDENCES.has(value)) return value as TokenCount['confidence'];
  return 'low';
}

function rowToEvent(row: EventRow): MeteringEvent {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    provider: row.provider,
    sellerPeerId: row.seller_peer_id,
    buyerPeerId: row.buyer_peer_id,
    tokens: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      method: validateTokenMethod(row.token_method),
      confidence: validateTokenConfidence(row.token_confidence),
    },
    latencyMs: row.latency_ms,
    statusCode: row.status_code,
    wasStreaming: row.was_streaming === 1,
    ...(row.service !== null ? { service: row.service } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.cached_input_tokens !== null ? { cachedInputTokens: row.cached_input_tokens } : {}),
    ...(row.request_id !== null ? { requestId: row.request_id } : {}),
  };
}

function rowToReceipt(row: ReceiptRow): UsageReceipt {
  return {
    receiptId: row.receipt_id,
    sessionId: row.session_id,
    eventId: row.event_id,
    timestamp: row.timestamp,
    provider: row.provider,
    sellerPeerId: row.seller_peer_id,
    buyerPeerId: row.buyer_peer_id,
    tokens: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      method: validateTokenMethod(row.token_method),
      confidence: validateTokenConfidence(row.token_confidence),
    },
    unitPriceCentsPerThousandTokens: row.unit_price_cents_per_thousand_tokens,
    costCents: row.cost_cents,
    signature: row.signature,
  };
}

function rowToVerification(row: VerificationRow): ReceiptVerification {
  return {
    receiptId: row.receipt_id,
    signatureValid: row.signature_valid === 1,
    buyerTokenEstimate: {
      inputTokens: row.buyer_input_tokens,
      outputTokens: row.buyer_output_tokens,
      totalTokens: row.buyer_total_tokens,
      method: 'content-length',
      confidence: 'high',
    },
    sellerTokenEstimate: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: row.seller_total_tokens,
      method: 'content-length',
      confidence: 'high',
    },
    tokenDifference: row.token_difference,
    percentageDifference: row.percentage_difference,
    disputed: row.disputed === 1,
    verifiedAt: row.verified_at,
  };
}

function rowToSession(row: SessionRow): SessionMetrics {
  return {
    sessionId: row.session_id,
    sellerPeerId: row.seller_peer_id,
    buyerPeerId: row.buyer_peer_id,
    provider: row.provider,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalRequests: row.total_requests,
    totalTokens: row.total_tokens,
    totalCostCents: row.total_cost_cents,
    avgLatencyMs: row.avg_latency_ms,
    peerSwitches: row.peer_switches,
    disputedReceipts: row.disputed_receipts,
  };
}

export interface MeteringEventPageQuery {
  limit: number;
  /** Newest bound (exclusive), from the previous page. */
  before?: { timestamp: number; rowid: number };
  fromMs?: number;
  buyerPeerId?: string;
  service?: string;
  errorsOnly?: boolean;
  /** Rows a filtered page walks at most (default 5,000). */
  scanLimit?: number;
}

export interface MeteringEventPage {
  rows: MeteringEventPageRow[];
  /** Set when a filtered walk hit `scanLimit` first: pass it as `before` to keep looking. */
  scannedTo: { timestamp: number; rowid: number } | null;
}

export interface MeteringEventPageRow {
  rowid: number;
  event_id: string;
  session_id: string;
  timestamp: number;
  provider: string;
  service: string | null;
  buyer_peer_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  token_method: string;
  latency_ms: number;
  status_code: number;
  was_streaming: number;
  error: string | null;
  cached_input_tokens: number | null;
  cost_cents: number | null;
}

export interface MeteringEventDetailRow extends MeteringEventPageRow {
  token_confidence: string;
  /** NULL on rows written before migration 8. */
  request_id: string | null;
  receipt_id: string | null;
  unit_price_cents_per_thousand: number | null;
  verification: { signature_valid: number; buyer_total_tokens: number; percentage_difference: number; disputed: number } | null;
  /** The metering session (a buyer's run of requests); null until it is first saved. */
  session: { started_at: number; ended_at: number | null; total_requests: number; total_tokens: number; total_cost_cents: number; avg_latency_ms: number } | null;
  /** 1-based index of this request within its session. */
  session_position: number;
}
