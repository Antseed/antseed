import Database from 'better-sqlite3';
import { runMigrations } from '@antseed/node';
import { ledgerMigrations } from './ledger-migrations/index.js';
import type { WorkerStats } from './protocol.js';
import type { WorkerRank } from './ranking.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Dispatch outcomes are kept this long, for the dashboard's success rates. */
const DISPATCH_RETENTION_MS = 30 * DAY_MS;
const PRUNE_EVERY_DISPATCHES = 1000;

export interface EarningInput {
  /** Unique per served request (the pool's dispatch ID): buyers' own request IDs can collide. */
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

export interface DispatchRecord {
  worker: string;
  ok: boolean;
  /** Why it failed: timeout, disconnect, idle, oversize. */
  reason?: string;
  firstByteMs?: number;
  at?: number;
}

/**
 * The pool's record of what each worker earned and was paid. Amounts are
 * USDC base units (6 decimals) stored as integers; sums stay far below 2^53.
 * The seller dashboard reads `earnings` and `connections` read-only (apps/cli
 * seller-monitor/workers.ts), so keep those columns stable, and `dispatches`
 * and `worker_rank` too.
 */
export class WorkerLedger {
  private readonly db: Database.Database;
  private readonly stmts: ReturnType<WorkerLedger['prepareStatements']>;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db, ledgerMigrations);
    // A pool that crashed left sessions open; they ended no later than now.
    this.db.prepare('UPDATE connections SET disconnected_at = ? WHERE disconnected_at IS NULL').run(Date.now());
    this.stmts = this.prepareStatements();
    this.pruneDispatches();
  }

  /** The ledger's fixed statements, compiled once. */
  private prepareStatements() {
    return {
      insertEarning: this.db.prepare(`
        INSERT OR IGNORE INTO earnings (request_id, worker, service, gross_usdc, worker_usdc, input_tokens, output_tokens, stream_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertConnection: this.db.prepare('INSERT INTO connections (worker, agent, connected_at) VALUES (?, ?, ?)'),
      closeConnection: this.db.prepare('UPDATE connections SET disconnected_at = ? WHERE id = ? AND disconnected_at IS NULL'),
      earningTotals: this.db.prepare(`
        SELECT COALESCE(SUM(worker_usdc), 0) AS earned,
               COALESCE(SUM(CASE WHEN created_at >= ? THEN worker_usdc ELSE 0 END), 0) AS today,
               COALESCE(SUM(CASE WHEN created_at >= ? THEN worker_usdc ELSE 0 END), 0) AS week,
               COUNT(*) AS requests,
               COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output
        FROM earnings WHERE worker = ?
      `),
      connectedMs: this.db.prepare(`
        SELECT COALESCE(SUM(MIN(COALESCE(disconnected_at, ?), ?) - MAX(connected_at, ?)), 0) AS ms
        FROM connections WHERE worker = ? AND COALESCE(disconnected_at, ?) > ?
      `),
      insertDispatch: this.db.prepare('INSERT INTO dispatches (worker, at, ok, reason, first_byte_ms) VALUES (?, ?, ?, ?, ?)'),
      pruneDispatches: this.db.prepare('DELETE FROM dispatches WHERE at < ?'),
      saveRank: this.db.prepare(`
        INSERT INTO worker_rank (worker, reliability, first_byte_ms, failures, benched_until, priority, updated_at, tokens_per_second)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (worker) DO UPDATE SET reliability = excluded.reliability, first_byte_ms = excluded.first_byte_ms,
          failures = excluded.failures, benched_until = excluded.benched_until, priority = excluded.priority, updated_at = excluded.updated_at,
          tokens_per_second = excluded.tokens_per_second
      `),
      loadRank: this.db.prepare('SELECT reliability, first_byte_ms, failures, benched_until, tokens_per_second FROM worker_rank WHERE worker = ?'),
    };
  }

  recordEarning(input: EarningInput): void {
    this.stmts.insertEarning.run(
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

  /** One buyer dispatch's outcome, for the dashboard's success rates and first-byte times. */
  recordDispatch(record: DispatchRecord): void {
    this.stmts.insertDispatch.run(record.worker.toLowerCase(), record.at ?? Date.now(), record.ok ? 1 : 0, record.reason ?? null, record.firstByteMs ?? null);
    if (++this.dispatchesSincePrune >= PRUNE_EVERY_DISPATCHES) this.pruneDispatches();
  }

  /** The worker's current rank, so it survives reconnects and pool restarts. */
  saveRank(worker: string, rank: WorkerRank, priority: number, at = Date.now()): void {
    this.stmts.saveRank.run(worker.toLowerCase(), rank.reliability, rank.firstByteMs, rank.failures, rank.benchedUntil, priority, at, rank.tokensPerSecond);
  }

  loadRank(worker: string): WorkerRank | null {
    const row = this.stmts.loadRank.get(worker.toLowerCase()) as { reliability: number | null; first_byte_ms: number | null; failures: number; benched_until: number; tokens_per_second: number } | undefined;
    return row ? { reliability: row.reliability, firstByteMs: row.first_byte_ms, failures: row.failures, benchedUntil: row.benched_until, tokensPerSecond: row.tokens_per_second } : null;
  }

  private dispatchesSincePrune = 0;

  private pruneDispatches(now = Date.now()): void {
    this.dispatchesSincePrune = 0;
    this.stmts.pruneDispatches.run(now - DISPATCH_RETENTION_MS);
  }

  /** Returns the connection row id, to pass to `recordDisconnect`. */
  recordConnect(worker: string, agent?: string, at = Date.now()): number {
    const result = this.stmts.insertConnection.run(worker.toLowerCase(), agent ?? null, at);
    return Number(result.lastInsertRowid);
  }

  recordDisconnect(connectionId: number, at = Date.now()): void {
    this.stmts.closeConnection.run(at, connectionId);
  }

  stats(worker: string, now = Date.now()): WorkerStats {
    const address = worker.toLowerCase();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const weekAgo = now - 7 * DAY_MS;
    const totals = this.stmts.earningTotals.get(startOfDay.getTime(), weekAgo, address) as { earned: number; today: number; week: number; requests: number; input: number; output: number };
    const connected = (this.stmts.connectedMs.get(now, now, weekAgo, address, now, weekAgo) as { ms: number }).ms;
    return {
      address,
      earnedToday: String(totals.today),
      earnedLast7Days: String(totals.week),
      earnedTotal: String(totals.earned),
      requestsTotal: totals.requests,
      inputTokensTotal: totals.input,
      outputTokensTotal: totals.output,
      connectedSecondsLast7Days: Math.floor(connected / 1000),
    };
  }

  close(): void {
    this.db.close();
  }
}
