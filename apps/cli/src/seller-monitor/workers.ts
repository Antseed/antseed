import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { SellerWorkers } from '../gateway/console-api/types.js'
import { SELLER_STALE_MS } from './reader.js'

const DAY_MS = 86_400_000
const MICRO_USDC = 1_000_000
/** Where the colony-pool provider keeps its ledger unless COLONY_POOL_LEDGER_PATH moves it. */
export const COLONY_POOL_LEDGER_FILE = 'colony-pool.db'
/** Written by the provider when COLONY_POOL_LEDGER_PATH moves the ledger: the ledger's path. */
export const COLONY_POOL_LEDGER_POINTER_FILE = 'colony-pool.ledger-path'

function ledgerPath(dataDir: string): string {
  const pointer = join(dataDir, COLONY_POOL_LEDGER_POINTER_FILE)
  const moved = existsSync(pointer) ? readFileSync(pointer, 'utf-8').trim() : ''
  return moved || join(dataDir, COLONY_POOL_LEDGER_FILE)
}

/**
 * The Macs (and other workers) serving this seller's colony pool, from the
 * provider's ledger, read-only. `available: false` when the seller runs no
 * colony pool, so the dashboard shows nothing extra.
 *
 * `sellerSeenAt` is the seller's last heartbeat, or null when it never wrote
 * one. Connections the ledger still has open count as live only while the
 * seller is running: a seller that died without closing them leaves them
 * open, so once its heartbeat goes stale they end at that heartbeat.
 */
export function readSellerWorkers(dataDir: string, now = Date.now(), sellerSeenAt: number | null = now): SellerWorkers {
  const path = ledgerPath(dataDir)
  if (!existsSync(path)) return { available: false }
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const weekAgo = now - 7 * DAY_MS
    const live = sellerSeenAt !== null && now - sellerSeenAt < SELLER_STALE_MS
    // When an open connection ends: now while the seller runs, else its last heartbeat (never before it opened).
    const openEnd = live ? now : sellerSeenAt
    const end = 'COALESCE(disconnected_at, MAX(connected_at, COALESCE(@openEnd, connected_at)))'
    const rows = db.prepare(`
      SELECT w.worker AS address,
             (SELECT agent FROM connections c WHERE c.worker = w.worker ORDER BY connected_at DESC LIMIT 1) AS agent,
             @live AND EXISTS (SELECT 1 FROM connections c WHERE c.worker = w.worker AND c.disconnected_at IS NULL) AS connected,
             (SELECT MAX(${end}) FROM connections c WHERE c.worker = w.worker) AS last_seen,
             (SELECT COALESCE(SUM(MIN(${end}, @now) - MAX(connected_at, @weekAgo)), 0) FROM connections c
               WHERE c.worker = w.worker AND ${end} > @weekAgo) AS online_ms,
             COALESCE(e.requests, 0) AS requests, COALESCE(e.output_tokens, 0) AS output_tokens,
             COALESCE(e.timed_tokens, 0) AS timed_tokens, COALESCE(e.stream_ms, 0) AS stream_ms,
             COALESCE(e.earned_week, 0) AS earned_week, COALESCE(t.earned_total, 0) AS earned_total
      FROM (SELECT worker FROM connections UNION SELECT worker FROM earnings) w
      LEFT JOIN (
        SELECT worker, COUNT(*) AS requests, SUM(output_tokens) AS output_tokens, SUM(worker_usdc) AS earned_week,
               SUM(CASE WHEN stream_ms > 0 THEN output_tokens ELSE 0 END) AS timed_tokens, SUM(COALESCE(stream_ms, 0)) AS stream_ms
        FROM earnings WHERE created_at >= @weekAgo GROUP BY worker
      ) e ON e.worker = w.worker
      LEFT JOIN (SELECT worker, SUM(worker_usdc) AS earned_total FROM earnings GROUP BY worker) t ON t.worker = w.worker
    `).all({ now, weekAgo, openEnd, live: live ? 1 : 0 }) as Array<{
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
