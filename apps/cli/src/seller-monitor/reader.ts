import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSellerEvents, SELLER_EVENTS_FILE } from '@antseed/node'
import { MeteringStorage } from '@antseed/node/metering'
import { CHANNEL_KIND, ChannelStore } from '@antseed/node/payments'
import type { SellerAlertsState, SellerEventView, SellerGas, SellerGasRefuel, SellerModelHealth, SellerStatus, SellerUsage, SellerUsageDay } from '../gateway/console-api/types.js'

const DAY_MS = 86_400_000
/** The longest usage series asked for; older cached days are dropped. */
export const MAX_USAGE_DAYS = 30
/** The daemon rewrites its state every second; older than this means it is not running. */
export const SELLER_STALE_MS = 15_000
const DAEMON_STATE_FILE = 'daemon.state.json'
const MICRO_USDC = 1_000_000

/** Where a seller on this host keeps its data: `ANTSEED_SELLER_DATA_DIR`, else `fallbackDir`; null when neither holds a seller. */
export function resolveSellerDataDir(fallbackDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env['ANTSEED_SELLER_DATA_DIR']?.trim() || fallbackDir
  return hasSeller(dir) ? dir : null
}

/** A seller ran here: its state file (removed on a clean stop) or its event journal (kept). */
export function hasSeller(dataDir: string): boolean {
  return existsSync(join(dataDir, DAEMON_STATE_FILE)) || existsSync(join(dataDir, SELLER_EVENTS_FILE))
}

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** daemon.state.json as the running seller last wrote it; null when absent or mid-write. */
export async function readDaemonState(dataDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, DAEMON_STATE_FILE), 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const HEALTH_ORDER: Record<SellerModelHealth['status'], number> = { failing: 0, unknown: 1, healthy: 2 }

function parseHealthStatus(entry: Record<string, unknown>): SellerModelHealth['status'] {
  if (entry.status === 'healthy' || entry.status === 'failing' || entry.status === 'unknown') return entry.status
  // Sellers before self health status wrote `advertised` instead.
  if (entry.advertised === false) return 'failing'
  return entry.lastProbeAt ? 'healthy' : 'unknown'
}

/** `modelHealth` from daemon.state.json, failing services first (shared with the metrics exporter). */
export function parseModelHealth(raw: unknown): SellerModelHealth[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry: Record<string, unknown>) => ({
    provider: String(entry.provider ?? ''),
    providerId: String(entry.providerId ?? entry.provider ?? ''),
    service: String(entry.service ?? ''),
    status: parseHealthStatus(entry),
    reason: strOrNull(entry.reason),
    consecutiveFailures: num(entry.consecutiveFailures),
    failingSince: numOrNull(entry.failingSince),
    checkedAt: numOrNull(entry.checkedAt),
    source: entry.source === 'probe' || entry.source === 'traffic' ? entry.source as 'probe' | 'traffic' : null,
    lastTrafficAt: numOrNull(entry.lastTrafficAt),
    lastProbeAt: numOrNull(entry.lastProbeAt),
    lastStatusCode: numOrNull(entry.lastStatusCode),
    lastDetail: strOrNull(entry.lastDetail),
  })).sort((a, b) => HEALTH_ORDER[a.status] - HEALTH_ORDER[b.status] || a.service.localeCompare(b.service))
}

/** `gas` from daemon.state.json (shared with the metrics exporter). */
export function parseGas(raw: unknown): SellerGas | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  return {
    address: String(entry.address ?? ''),
    depleted: entry.depleted === true,
    balanceEth: numOrNull(entry.balanceEth),
    minBalanceEth: num(entry.minBalanceEth),
    lastCheckedAt: numOrNull(entry.lastCheckedAt),
    refuel: parseGasRefuel(entry.refuel),
  }
}

const REFUEL_SKIPS = new Set(['daily_cap', 'insufficient_usdc', 'insufficient_eth'])

function parseGasRefuel(raw: unknown): SellerGasRefuel | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const last = entry.lastRefuel && typeof entry.lastRefuel === 'object' ? entry.lastRefuel as Record<string, unknown> : null
  return {
    triggerBalanceEth: num(entry.triggerBalanceEth),
    swapUsdc: num(entry.swapUsdc),
    maxUsdcPerDay: num(entry.maxUsdcPerDay),
    usdcLast24h: num(entry.usdcLast24h),
    lastRefuel: last ? { at: num(last.at), usdc: num(last.usdc), txHash: String(last.txHash ?? '') } : null,
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
    skipped: typeof entry.skipped === 'string' && REFUEL_SKIPS.has(entry.skipped) ? entry.skipped as SellerGasRefuel['skipped'] : null,
    nextAttemptAt: numOrNull(entry.nextAttemptAt),
  }
}

function alerts(raw: unknown): SellerAlertsState | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  return {
    channels: Array.isArray(entry.channels) ? entry.channels.map(String) : [],
    lastSentAt: numOrNull(entry.lastSentAt),
    lastError: strOrNull(entry.lastError),
  }
}

/**
 * The seller's live state from daemon.state.json; `running` is false once the file goes stale or away.
 * `snapshot` is a state already read, so callers needing more from the file see one moment.
 */
export async function readSellerStatus(dataDir: string | null, version: string, now = Date.now(), snapshot?: Record<string, unknown> | null): Promise<SellerStatus> {
  if (!dataDir || !hasSeller(dataDir)) return { available: false }
  const state = snapshot === undefined ? await readDaemonState(dataDir) : snapshot
  const updatedAt = numOrNull(state?.updatedAt)
  return {
    available: true,
    running: updatedAt !== null && now - updatedAt < SELLER_STALE_MS,
    dataDir,
    peerId: strOrNull(state?.peerId),
    provider: strOrNull(state?.provider),
    startedAt: numOrNull(state?.startedAt),
    updatedAt,
    activeChannels: num(state?.activeChannels),
    capacityUsedPercent: num(state?.capacityUsedPercent),
    notices: Array.isArray(state?.notices) ? state.notices.map(String) : [],
    models: parseModelHealth(state?.modelHealth),
    gas: parseGas(state?.gas),
    alerts: alerts(state?.alerts),
    version,
  }
}

export async function readSellerEventViews(dataDir: string, limit: number): Promise<SellerEventView[]> {
  return (await readSellerEvents(dataDir, limit)).map((event) => ({ ...event }))
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Per-UTC-day usage from metering.db. A busy seller's metering DB runs to
 * gigabytes, so only bounded day ranges are queried (indexed on timestamp),
 * finished days are kept for good, and today is re-read at most every
 * `todayTtlMs`. The loop yields between queries so a host serving other
 * requests (the gateway) keeps answering.
 */
export class SellerUsageReader {
  private readonly _days = new Map<string, { entry: SellerUsageDay; readAt: number }>()
  private readonly _channels = new Map<string, { at: number; value: Pick<SellerUsage, 'channels' | 'deliveredUsdc' | 'settledUsdc'> }>()
  private readonly _inFlight = new Map<string, Promise<SellerUsage>>()

  constructor(private readonly _todayTtlMs = 60_000) {}

  usage(dataDir: string, days: number, now = Date.now()): Promise<SellerUsage> {
    days = Math.min(Math.max(1, days), MAX_USAGE_DAYS)
    const key = `${dataDir}:${days}`
    let pending = this._inFlight.get(key)
    if (!pending) {
      pending = this._read(dataDir, days, now).finally(() => this._inFlight.delete(key))
      this._inFlight.set(key, pending)
    }
    return pending
  }

  private async _read(dataDir: string, days: number, now: number): Promise<SellerUsage> {
    const todayStart = now - (now % DAY_MS)
    const series: SellerUsageDay[] = []
    const meteringPath = join(dataDir, 'metering.db')
    const metering = existsSync(meteringPath) ? new MeteringStorage(meteringPath, { readonly: true }) : null
    try {
      for (let index = days - 1; index >= 0; index -= 1) {
        const day = todayStart - index * DAY_MS
        const key = `${dataDir}:${day}`
        const cached = this._days.get(key)
        const today = day === todayStart
        // A day read after it ended never changes; anything read earlier (today,
        // or yesterday last read before midnight) is re-read after the TTL.
        const final = cached && cached.readAt >= day + DAY_MS
        if (cached && (final || (today && now - cached.readAt < this._todayTtlMs))) {
          series.push(cached.entry)
          continue
        }
        const entry: SellerUsageDay = { day, requests: 0, tokens: 0, sessions: 0, revenueUsd: 0 }
        if (metering) {
          const end = day + DAY_MS
          const events = metering.getEventTokenSummary(day, end)
          entry.requests = events.totalRequests
          entry.tokens = events.totalTokens
          entry.sessions = metering.getSessionSummary(day, end).channelCount
          entry.revenueUsd = metering.getTotalCost(day, end) / 100
          await yieldToLoop()
        }
        this._days.set(key, { entry, readAt: now })
        series.push(entry)
      }
    } finally {
      metering?.close()
    }
    // Days that have fallen out of every series a caller can ask for are never read again.
    const oldest = todayStart - (MAX_USAGE_DAYS - 1) * DAY_MS
    for (const [key, cached] of this._days) if (cached.entry.day < oldest) this._days.delete(key)
    return { days: series, ...this._channelTotals(dataDir, now) }
  }

  private _channelTotals(dataDir: string, now: number): Pick<SellerUsage, 'channels' | 'deliveredUsdc' | 'settledUsdc'> {
    const cached = this._channels.get(dataDir)
    if (cached && now - cached.at < this._todayTtlMs) return cached.value
    const channels = { active: 0, settled: 0, timeout: 0, ghost: 0, total: 0 }
    let delivered = 0
    let settled = 0
    const dbPath = join(dataDir, 'payments', 'sessions.db')
    if (existsSync(dbPath)) {
      const store = new ChannelStore(join(dataDir, 'payments'))
      try {
        // Regular and one-off channels: a one-off channel pays for a single request, and is paid all the same.
        for (const row of store.getRoleTotalsByStatus('seller', [CHANNEL_KIND.PAID, CHANNEL_KIND.ONE_OFF])) {
          channels.total += row.count
          if (row.status in channels) channels[row.status as keyof typeof channels] += row.count
          delivered += Number(row.tokensDelivered)
          settled += Number(row.settledAmount)
        }
      } finally {
        store.close()
      }
    }
    const value = { channels, deliveredUsdc: delivered / MICRO_USDC, settledUsdc: settled / MICRO_USDC }
    this._channels.set(dataDir, { at: now, value })
    return value
  }
}
