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

export type FreeTierLimitKind = 'address' | 'ip';

export interface FreeTierConsumption {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  /** Which limit denied the request, or null when allowed. */
  limitedBy: FreeTierLimitKind | null;
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
export class MeteringStorage {
  private readonly db: Database.Database;
  private lastFreeTierPruneAt: number | null = null;

  /**
   * Open or create the SQLite database at the given path.
   * Creates tables if they don't exist.
   *
   * @param dbPath - Path to the SQLite database file (or ':memory:' for tests)
   */
  constructor(dbPath: string) {
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
        latency_ms, status_code, was_streaming
      ) VALUES (
        @eventId, @sessionId, @timestamp, @provider,
        @sellerPeerId, @buyerPeerId,
        @inputTokens, @outputTokens, @totalTokens,
        @tokenMethod, @tokenConfidence,
        @latencyMs, @statusCode, @wasStreaming
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
   * Atomically consume one seller free-tier request in a sliding window.
   * Each configured limit (buyer address, remote IP) is checked; the request
   * is recorded only when every applicable limit still has headroom.
   */
  consumeFreeTierRequest(input: {
    buyerAddress: string;
    remoteIp: string | null;
    service: string;
    maxRequestsPerAddress: number | null;
    maxRequestsPerIp: number | null;
    windowMs: number;
    nowMs?: number;
  }): FreeTierConsumption {
    const nowMs = input.nowMs ?? Date.now();
    const windowStart = nowMs - input.windowMs;
    const buyerAddress = input.buyerAddress.toLowerCase();
    const remoteIp = input.remoteIp ?? '';
    const pruneIntervalMs = Math.min(input.windowMs, 60 * 60_000);
    if (
      this.lastFreeTierPruneAt === null
      || nowMs < this.lastFreeTierPruneAt
      || nowMs - this.lastFreeTierPruneAt >= pruneIntervalMs
    ) {
      this.db.prepare('DELETE FROM free_tier_usage WHERE timestamp < ?').run(windowStart);
      this.lastFreeTierPruneAt = nowMs;
    }
    const countUsage = (column: 'buyer_address' | 'remote_ip', key: string): { count: number; oldestTimestamp: number | null } => {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS request_count, MIN(timestamp) AS oldest_timestamp
        FROM free_tier_usage
        WHERE ${column} = ? AND timestamp >= ?
      `).get(key, windowStart) as { request_count: number; oldest_timestamp: number | null };
      return { count: row.request_count, oldestTimestamp: row.oldest_timestamp };
    };
    const consume = this.db.transaction((): FreeTierConsumption => {
      const checks: FreeTierLimitCheck[] = [];
      if (input.maxRequestsPerAddress !== null) {
        checks.push({ kind: 'address', limit: input.maxRequestsPerAddress, ...countUsage('buyer_address', buyerAddress) });
      }
      if (input.maxRequestsPerIp !== null && remoteIp !== '') {
        checks.push({ kind: 'ip', limit: input.maxRequestsPerIp, ...countUsage('remote_ip', remoteIp) });
      }
      const decision = evaluateFreeTierLimits(checks, input.windowMs, nowMs);
      if (decision.allowed) {
        this.db.prepare(`
          INSERT INTO free_tier_usage (buyer_address, remote_ip, service, timestamp)
          VALUES (?, ?, ?, ?)
        `).run(buyerAddress, remoteIp, input.service, nowMs);
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
