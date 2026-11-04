import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { SellerWorkers } from '../gateway/console-api/types.js'

const DAY_MS = 86_400_000
const MICRO_USDC = 1_000_000
/** Where the worker-pool provider keeps its ledger unless WORKER_POOL_LEDGER_PATH moves it. */
export const WORKER_POOL_LEDGER_FILE = 'worker-pool.db'

/**
 * The Macs (and other workers) serving this seller's worker pool, from the
 * provider's ledger, read-only. `available: false` when the seller runs no
 * worker pool, so the dashboard shows nothing extra.
 */
export function readSellerWorkers(dataDir: string, now = Date.now()): SellerWorkers {
  const path = join(dataDir, WORKER_POOL_LEDGER_FILE)
  if (!existsSync(path)) return { available: false }
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const weekAgo = now - 7 * DAY_MS
    const rows = db.prepare(`
      SELECT w.worker AS address,
             (SELECT agent FROM connections c WHERE c.worker = w.worker ORDER BY connected_at DESC LIMIT 1) AS agent,
             EXISTS (SELECT 1 FROM connections c WHERE c.worker = w.worker AND c.disconnected_at IS NULL) AS connected,
             (SELECT MAX(COALESCE(disconnected_at, ?)) FROM connections c WHERE c.worker = w.worker) AS last_seen,
             (SELECT COALESCE(SUM(MIN(COALESCE(disconnected_at, ?), ?) - MAX(connected_at, ?)), 0) FROM connections c
               WHERE c.worker = w.worker AND COALESCE(disconnected_at, ?) > ?) AS online_ms,
             COALESCE(e.requests, 0) AS requests, COALESCE(e.output_tokens, 0) AS output_tokens,
             COALESCE(e.timed_tokens, 0) AS timed_tokens, COALESCE(e.stream_ms, 0) AS stream_ms,
             COALESCE(e.earned_week, 0) AS earned_week, COALESCE(t.earned_total, 0) AS earned_total
      FROM (SELECT worker FROM connections UNION SELECT worker FROM earnings) w
      LEFT JOIN (
        SELECT worker, COUNT(*) AS requests, SUM(output_tokens) AS output_tokens, SUM(worker_usdc) AS earned_week,
               SUM(CASE WHEN stream_ms > 0 THEN output_tokens ELSE 0 END) AS timed_tokens, SUM(COALESCE(stream_ms, 0)) AS stream_ms
        FROM earnings WHERE created_at >= ? GROUP BY worker
      ) e ON e.worker = w.worker
      LEFT JOIN (SELECT worker, SUM(worker_usdc) AS earned_total FROM earnings GROUP BY worker) t ON t.worker = w.worker
    `).all(now, now, now, weekAgo, now, weekAgo, weekAgo) as Array<{
      address: string; agent: string | null; connected: number; last_seen: number | null; online_ms: number
      requests: number; output_tokens: number; timed_tokens: number; stream_ms: number; earned_week: number; earned_total: number
    }>
    const workers = rows.map((row) => ({
      address: row.address,
      agent: row.agent,
      connected: row.connected === 1,
      lastSeenAt: row.last_seen,
      onlineHoursWeek: row.online_ms / 3_600_000,
      requestsWeek: row.requests,
      outputTokensWeek: row.output_tokens,
      tokensPerSecond: row.stream_ms > 0 ? row.timed_tokens / (row.stream_ms / 1000) : null,
      earnedWeekUsdc: row.earned_week / MICRO_USDC,
      earnedTotalUsdc: row.earned_total / MICRO_USDC,
    })).sort((a, b) => Number(b.connected) - Number(a.connected) || b.earnedWeekUsdc - a.earnedWeekUsdc)
    return { available: true, workers }
  } finally {
    db.close()
  }
}
