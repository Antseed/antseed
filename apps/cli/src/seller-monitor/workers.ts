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

/** Recent first-byte samples per worker the median is taken over. */
const FIRST_BYTE_SAMPLES = 500

/**
 * The pool's routing score (plugins/provider-colony-pool/src/ranking.ts,
 * `rankScores`, without load): priority × reliability × speed relative to
 * the fastest, with the others' averages for a worker that has no record.
 */
function rankScores(candidates: Array<{ reliability: number | null; tokensPerSecond: number | null; priority: number }>): number[] {
  const known = candidates.filter((c) => c.reliability !== null).map((c) => c.reliability!)
  const averageReliability = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1
  const fastest = Math.max(0, ...candidates.map((c) => c.tokensPerSecond ?? 0))
  const speeds = candidates.filter((c) => (c.tokensPerSecond ?? 0) > 0).map((c) => c.tokensPerSecond! / fastest)
  const averageSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 1
  return candidates.map((c) => c.priority * (c.reliability ?? averageReliability) * ((c.tokensPerSecond ?? 0) > 0 ? c.tokensPerSecond! / fastest : averageSpeed))
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

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
    `).all({ now, weekAgo, openEnd, live: live ? 1 : 0 }) as LedgerRow[]
    // Ledgers from before routing outcomes were recorded have no dispatch or rank tables.
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((t) => t.name))
    const dispatches = tables.has('dispatches')
    const rate = dispatches ? db.prepare(`
      SELECT SUM(CASE WHEN at >= @dayAgo THEN ok ELSE 0 END) AS ok_day, SUM(CASE WHEN at >= @dayAgo THEN 1 ELSE 0 END) AS day,
             SUM(ok) AS ok_week, COUNT(*) AS week
      FROM dispatches WHERE worker = @worker AND at >= @weekAgo
    `) : null
    const firstBytes = dispatches ? db.prepare(`
      SELECT first_byte_ms FROM dispatches WHERE worker = ? AND at >= ? AND first_byte_ms IS NOT NULL ORDER BY at DESC LIMIT ${FIRST_BYTE_SAMPLES}
    `) : null
    const rankOf = tables.has('worker_rank') ? db.prepare('SELECT reliability, benched_until, priority FROM worker_rank WHERE worker = ?') : null
    const workers = rows.map((row) => {
      const counts = rate?.get({ worker: row.address, dayAgo: now - DAY_MS, weekAgo }) as { ok_day: number | null; day: number; ok_week: number | null; week: number } | undefined
      const rank = rankOf?.get(row.address) as { reliability: number | null; benched_until: number; priority: number } | undefined
      return {
        ...summary(row),
        successRateDay: counts && counts.day > 0 ? (counts.ok_day ?? 0) / counts.day : null,
        successRateWeek: counts && counts.week > 0 ? (counts.ok_week ?? 0) / counts.week : null,
        firstByteMsMedian: median(((firstBytes?.all(row.address, weekAgo) ?? []) as Array<{ first_byte_ms: number }>).map((r) => r.first_byte_ms)),
        reliability: rank?.reliability ?? null,
        benchedUntil: live && rank && rank.benched_until > now ? rank.benched_until : null,
        priority: rank?.priority ?? 1,
      }
    })
    // Rank the workers the pool would route to now, by its score.
    const routable = workers.filter((w) => w.connected && w.priority > 0 && w.benchedUntil === null)
    const scores = rankScores(routable)
    const order = routable.map((w, i) => ({ w, score: scores[i]! })).sort((a, b) => b.score - a.score)
    const rankByAddress = new Map(order.map(({ w }, i) => [w.address, i + 1]))
    const ranked = workers.map(({ reliability: _reliability, ...w }) => ({ ...w, rank: rankByAddress.get(w.address) ?? null }))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.earnedWeekUsdc - a.earnedWeekUsdc)
    return { available: true, workers: ranked }
  } finally {
    db.close()
  }
}

type LedgerRow = {
  address: string; agent: string | null; connected: number; last_seen: number | null; online_ms: number
  requests: number; output_tokens: number; timed_tokens: number; stream_ms: number; earned_week: number; earned_total: number
}

function summary(row: LedgerRow) {
  return {
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
  }
}
