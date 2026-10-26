import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSellerEvents, SELLER_EVENTS_FILE } from '@antseed/node'
import { MeteringStorage } from '@antseed/node/metering'
import { CHANNEL_KIND, ChannelStore } from '@antseed/node/payments'
import type { SellerAlertsState, SellerEventView, SellerGas, SellerModelHealth, SellerStatus, SellerUsage, SellerUsageDay } from '../gateway/console-api/types.js'

const DAY_MS = 86_400_000
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

async function readDaemonState(dataDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, DAEMON_STATE_FILE), 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** `modelHealth` from daemon.state.json, withdrawn services first (shared with the metrics exporter). */
export function parseModelHealth(raw: unknown): SellerModelHealth[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry: Record<string, unknown>) => ({
    provider: String(entry.provider ?? ''),
    providerId: String(entry.providerId ?? entry.provider ?? ''),
    service: String(entry.service ?? ''),
    advertised: entry.advertised !== false,
    consecutiveFailures: num(entry.consecutiveFailures),
    lastProbeAt: numOrNull(entry.lastProbeAt),
    lastStatusCode: numOrNull(entry.lastStatusCode),
    lastDetail: strOrNull(entry.lastDetail),
  })).sort((a, b) => Number(a.advertised) - Number(b.advertised) || a.service.localeCompare(b.service))
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

/** The seller's live state from daemon.state.json; `running` is false once the file goes stale or away. */
export async function readSellerStatus(dataDir: string | null, version: string, now = Date.now()): Promise<SellerStatus> {
  if (!dataDir || !hasSeller(dataDir)) return { available: false }
  const state = await readDaemonState(dataDir)
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
  private _channels: { at: number; value: Pick<SellerUsage, 'channels' | 'deliveredUsdc' | 'settledUsdc'> } | null = null
  private readonly _inFlight = new Map<string, Promise<SellerUsage>>()

  constructor(private readonly _todayTtlMs = 60_000) {}

  usage(dataDir: string, days: number, now = Date.now()): Promise<SellerUsage> {
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
    const metering = existsSync(meteringPath) ? new MeteringStorage(meteringPath) : null
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
    return { days: series, ...this._channelTotals(dataDir, now) }
  }

  private _channelTotals(dataDir: string, now: number): Pick<SellerUsage, 'channels' | 'deliveredUsdc' | 'settledUsdc'> {
    if (this._channels && now - this._channels.at < this._todayTtlMs) return this._channels.value
    const channels = { active: 0, settled: 0, timeout: 0, ghost: 0, total: 0 }
    let delivered = 0
    let settled = 0
    const dbPath = join(dataDir, 'payments', 'sessions.db')
    if (existsSync(dbPath)) {
      const store = new ChannelStore(join(dataDir, 'payments'))
      try {
        // Regular and one-off channels: a one-off channel pays for a single request, and is paid all the same.
        const all = [...store.listAllChannels(1_000_000, CHANNEL_KIND.PAID), ...store.listAllChannels(1_000_000, CHANNEL_KIND.ONE_OFF)]
        for (const channel of all.filter((entry) => entry.role === 'seller')) {
          channels.total += 1
          if (channel.status in channels) channels[channel.status as keyof typeof channels] += 1
          delivered += num(channel.tokensDelivered)
          settled += num(channel.settledAmount)
        }
      } finally {
        store.close()
      }
    }
    const value = { channels, deliveredUsdc: delivered / MICRO_USDC, settledUsdc: settled / MICRO_USDC }
    this._channels = { at: now, value }
    return value
  }
}
