import Database from 'better-sqlite3';
import type { WorkerStats } from './protocol.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EarningInput {
  requestId: string;
  worker: string;
  service?: string;
  /** What the buyer was charged, USDC base units. */
  grossUsdc: bigint;
  /** The worker's share of grossUsdc. */
  workerUsdc: bigint;
  inputTokens: number;
  outputTokens: number;
  /** First byte to last byte, for the worker's decode speed; omitted when unknown. */
  streamMs?: number;
  at?: number;
}

export interface PendingPayout {
  worker: string;
  pendingUsdc: bigint;
}

/**
 * The pool's record of what each worker earned and was paid. Amounts are
 * USDC base units (6 decimals) stored as integers; sums stay far below 2^53.
 * The seller dashboard reads `earnings` and `connections` read-only (apps/cli
 * seller-monitor/workers.ts), so keep those columns stable.
 */
export class WorkerLedger {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS earnings (
        request_id TEXT PRIMARY KEY,
        worker TEXT NOT NULL,
        service TEXT,
        gross_usdc INTEGER NOT NULL,
        worker_usdc INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        stream_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS earnings_worker_time ON earnings (worker, created_at);
      CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker TEXT NOT NULL,
        amount_usdc INTEGER NOT NULL,
        tx_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payouts_worker ON payouts (worker);
      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker TEXT NOT NULL,
        agent TEXT,
        connected_at INTEGER NOT NULL,
        disconnected_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS connections_worker ON connections (worker, connected_at);
    `);
    // A pool that crashed left sessions open; they ended no later than now.
    this.db.prepare('UPDATE connections SET disconnected_at = ? WHERE disconnected_at IS NULL').run(Date.now());
  }

  recordEarning(input: EarningInput): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO earnings (request_id, worker, service, gross_usdc, worker_usdc, input_tokens, output_tokens, stream_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId,
      input.worker.toLowerCase(),
      input.service ?? null,
      Number(input.grossUsdc),
      Number(input.workerUsdc),
      input.inputTokens,
      input.outputTokens,
      input.streamMs ?? null,
      input.at ?? Date.now(),
    );
  }

  recordPayout(worker: string, amountUsdc: bigint, txHash?: string, at = Date.now()): void {
    this.db.prepare('INSERT INTO payouts (worker, amount_usdc, tx_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(worker.toLowerCase(), Number(amountUsdc), txHash ?? null, at);
  }

  /** Returns the connection row id, to pass to `recordDisconnect`. */
  recordConnect(worker: string, agent?: string, at = Date.now()): number {
    const result = this.db.prepare('INSERT INTO connections (worker, agent, connected_at) VALUES (?, ?, ?)').run(worker.toLowerCase(), agent ?? null, at);
    return Number(result.lastInsertRowid);
  }

  recordDisconnect(connectionId: number, at = Date.now()): void {
    this.db.prepare('UPDATE connections SET disconnected_at = ? WHERE id = ? AND disconnected_at IS NULL').run(at, connectionId);
  }

  stats(worker: string, now = Date.now()): WorkerStats {
    const address = worker.toLowerCase();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const weekAgo = now - 7 * DAY_MS;
    const earned = (since: number): number => (this.db.prepare(
      'SELECT COALESCE(SUM(worker_usdc), 0) AS total FROM earnings WHERE worker = ? AND created_at >= ?',
    ).get(address, since) as { total: number }).total;
    const totals = this.db.prepare(`
      SELECT COALESCE(SUM(worker_usdc), 0) AS earned, COUNT(*) AS requests,
             COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output
      FROM earnings WHERE worker = ?
    `).get(address) as { earned: number; requests: number; input: number; output: number };
    const paid = (this.db.prepare('SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM payouts WHERE worker = ?')
      .get(address) as { total: number }).total;
    const connected = (this.db.prepare(`
      SELECT COALESCE(SUM(MIN(COALESCE(disconnected_at, ?), ?) - MAX(connected_at, ?)), 0) AS ms
      FROM connections WHERE worker = ? AND COALESCE(disconnected_at, ?) > ?
    `).get(now, now, weekAgo, address, now, weekAgo) as { ms: number }).ms;
    return {
      address,
      earnedToday: String(earned(startOfDay.getTime())),
      earnedLast7Days: String(earned(weekAgo)),
      earnedTotal: String(totals.earned),
      paidTotal: String(paid),
      pending: String(Math.max(0, totals.earned - paid)),
      requestsTotal: totals.requests,
      inputTokensTotal: totals.input,
      outputTokensTotal: totals.output,
      connectedSecondsLast7Days: Math.floor(connected / 1000),
    };
  }

  /** Workers owed at least `minUsdc`, largest balance first. */
  pendingPayouts(minUsdc = 0n): PendingPayout[] {
    const rows = this.db.prepare(`
      SELECT e.worker AS worker, e.earned - COALESCE(p.paid, 0) AS pending
      FROM (SELECT worker, SUM(worker_usdc) AS earned FROM earnings GROUP BY worker) e
      LEFT JOIN (SELECT worker, SUM(amount_usdc) AS paid FROM payouts GROUP BY worker) p ON p.worker = e.worker
      ORDER BY pending DESC
    `).all() as { worker: string; pending: number }[];
    return rows
      .map((row) => ({ worker: row.worker, pendingUsdc: BigInt(row.pending) }))
      .filter((row) => row.pendingUsdc > 0n && row.pendingUsdc >= minUsdc);
  }

  close(): void {
    this.db.close();
  }
}
