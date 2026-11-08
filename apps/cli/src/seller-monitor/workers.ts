import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { COLONY_POOL_LEDGER_FILE, COLONY_POOL_LEDGER_POINTER_FILE, rankScores } from '@antseed/provider-core'
import type { SellerWorkers } from '../gateway/console-api/types.js'
import { SELLER_STALE_MS } from './reader.js'
import { median } from './statistics.js'

const DAY_MS = 86_400_000
const MICRO_USDC = 1_000_000
export { COLONY_POOL_LEDGER_FILE, COLONY_POOL_LEDGER_POINTER_FILE }

/** Recent first-byte samples per worker the median is taken over. */
const FIRST_BYTE_SAMPLES = 500


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
             @live AND COALESCE(s.open, 0) AS connected, s.last_seen, COALESCE(s.online_ms, 0) AS online_ms,
             COALESCE(e.requests, 0) AS requests, COALESCE(e.output_tokens, 0) AS output_tokens,
             COALESCE(e.timed_tokens, 0) AS timed_tokens, COALESCE(e.stream_ms, 0) AS stream_ms,
             COALESCE(e.earned_week, 0) AS earned_week, COALESCE(t.earned_total, 0) AS earned_total
      FROM (SELECT worker FROM connections UNION SELECT worker FROM earnings) w
      LEFT JOIN (
        SELECT worker, MAX(disconnected_at IS NULL) AS open, MAX(${end}) AS last_seen,
               SUM(CASE WHEN ${end} > @weekAgo THEN MIN(${end}, @now) - MAX(connected_at, @weekAgo) ELSE 0 END) AS online_ms
        FROM connections GROUP BY worker
      ) s ON s.worker = w.worker
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
    // One query per kind for every worker (not three per worker on each 15 s poll), keyed by address.
    type Counts = { ok_day: number | null; day: number; ok_week: number | null; week: number }
    type Rank = { reliability: number | null; benched_until: number; priority: number; tokens_per_second: number }
    const countsByWorker = new Map(dispatches ? (db.prepare(`
      SELECT worker, SUM(CASE WHEN at >= @dayAgo THEN ok ELSE 0 END) AS ok_day, SUM(CASE WHEN at >= @dayAgo THEN 1 ELSE 0 END) AS day,
             SUM(ok) AS ok_week, COUNT(*) AS week
      FROM dispatches WHERE at >= @weekAgo GROUP BY worker
    `).all({ dayAgo: now - DAY_MS, weekAgo }) as Array<Counts & { worker: string }>).map((r) => [r.worker, r]) : [])
    const firstBytesByWorker = new Map<string, number[]>()
    if (dispatches) {
      const samples = db.prepare(`
        SELECT worker, first_byte_ms FROM (
          SELECT worker, first_byte_ms, ROW_NUMBER() OVER (PARTITION BY worker ORDER BY at DESC) AS sample
          FROM dispatches WHERE at >= ? AND first_byte_ms IS NOT NULL
        ) WHERE sample <= ${FIRST_BYTE_SAMPLES}
      `).all(weekAgo) as Array<{ worker: string; first_byte_ms: number }>
      for (const { worker, first_byte_ms } of samples) {
        const list = firstBytesByWorker.get(worker)
        if (list) list.push(first_byte_ms)
        else firstBytesByWorker.set(worker, [first_byte_ms])
      }
    }
    // The decode speed the pool routes by (smoothed, per finished request) is kept with its rank.
    const liveSpeed = tables.has('worker_rank')
      && (db.prepare('PRAGMA table_info(worker_rank)').all() as Array<{ name: string }>).some((c) => c.name === 'tokens_per_second')
    const rankByWorker = new Map(tables.has('worker_rank')
      ? (db.prepare(`SELECT worker, reliability, benched_until, priority, ${liveSpeed ? 'tokens_per_second' : '0'} AS tokens_per_second FROM worker_rank`)
          .all() as Array<Rank & { worker: string }>).map((r) => [r.worker, r])
      : [])
    const workers = rows.map((row) => {
      const counts = countsByWorker.get(row.address)
      const rank = rankByWorker.get(row.address)
      return {
        ...summary(row),
        successRateDay: counts && counts.day > 0 ? (counts.ok_day ?? 0) / counts.day : null,
        successRateWeek: counts && counts.week > 0 ? (counts.ok_week ?? 0) / counts.week : null,
        firstByteMsMedian: median(firstBytesByWorker.get(row.address) ?? []),
        reliability: rank?.reliability ?? null,
        routingSpeed: rank?.tokens_per_second ?? 0,
        benchedUntil: live && rank && rank.benched_until > now ? rank.benched_until : null,
        priority: rank?.priority ?? 1,
      }
    })
    // Rank the workers the pool would route to now, by its own score and inputs
    // (with no load, since the dashboard shows standing, not who is busy this second).
    // The weekly tokens per second shown next to it is an average, not what it routes by.
    const routable = workers.filter((w) => w.connected && w.priority > 0 && w.benchedUntil === null)
    const scores = rankScores(routable.map((w) => ({ reliability: w.reliability, tokensPerSecond: w.routingSpeed, priority: w.priority, load: 0 })))
    const order = routable.map((w, i) => ({ w, score: scores[i]! })).sort((a, b) => b.score - a.score)
    const rankByAddress = new Map(order.map(({ w }, i) => [w.address, i + 1]))
    const ranked = workers.map(({ reliability: _reliability, routingSpeed: _routingSpeed, ...w }) => ({ ...w, rank: rankByAddress.get(w.address) ?? null }))
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
