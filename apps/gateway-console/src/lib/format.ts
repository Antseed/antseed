import type { LimitPeriod, SpendLimits, Usdc } from '../api/types'

const USDC_DECIMALS = 6

/** Parse a wire USDC decimal string into a number of dollars (NaN-safe: invalid → 0). */
export function usdcToNumber(value: Usdc | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Dollar display: cents normally, up to 4 decimals for sub-cent amounts so
 * small per-request costs never read as $0.00.
 */
export function formatUsd(value: Usdc | number | null | undefined, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined) return '—'
  const amount = typeof value === 'number' ? value : usdcToNumber(value)
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  if (options.compact && abs >= 10_000) {
    return `${sign}$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(abs)}`
  }
  if (abs !== 0 && abs < 0.0001) return `${sign}<$0.0001`
  if (abs !== 0 && abs < 0.01) return `${sign}$${abs.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Normalize a user-entered dollar amount into a wire decimal string; null for blank, throws on invalid. */
export function parseUsdInput(value: string): Usdc | null {
  const raw = value.trim().replace(/^\$/, '').replace(/,/g, '')
  if (raw === '') return null
  const match = /^(\d+)(?:\.(\d{0,6}))?$/.exec(raw)
  if (!match) throw new Error('Use a dollar amount like 5 or 12.50 (up to 6 decimals).')
  const whole = match[1]!.replace(/^0+(?=\d)/, '')
  const fraction = (match[2] ?? '').padEnd(USDC_DECIMALS, '0')
  return `${whole}.${fraction}`
}

/** Trim a wire decimal for an input field ("5.500000" → "5.5"). */
export function usdcForInput(value: Usdc | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (!value.includes('.')) return value
  return value.replace(/0+$/, '').replace(/\.$/, '')
}

export function formatNumber(value: number | null | undefined, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (options.compact && Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  }
  return value.toLocaleString('en-US')
}

export function formatTokens(value: number): string {
  return formatNumber(value, { compact: true })
}

export function formatPricePerMillion(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value === 0) return 'Free'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 3 : 2 })}`
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

export function formatDateTime(epochMs: number | null | undefined): string {
  if (!epochMs) return '—'
  return new Date(epochMs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatDate(epochMs: number | null | undefined): string {
  if (!epochMs) return '—'
  return new Date(epochMs).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatRelative(epochMs: number | null | undefined, now = Date.now()): string {
  if (!epochMs) return 'Never'
  const diff = now - epochMs
  const future = diff < 0
  const abs = Math.abs(diff)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  let text: string
  if (abs < minute) return future ? 'in a moment' : 'just now'
  if (abs < hour) text = `${Math.round(abs / minute)} min`
  else if (abs < day) text = `${Math.round(abs / hour)} h`
  else if (abs < 30 * day) text = `${Math.round(abs / day)} d`
  else return formatDate(epochMs)
  return future ? `in ${text}` : `${text} ago`
}

/** Shorten a peer id or address for tables: `0x1234…abcd`. */
export function shortId(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return '—'
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export const LIMIT_PERIODS: LimitPeriod[] = ['daily', 'weekly', 'monthly', 'total']

export const PERIOD_LABELS: Record<LimitPeriod, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  total: 'Total',
}

/** One-line summary like "$5/day · $100/month", or "No limits". */
export function describeLimits(limits: SpendLimits | null | undefined): string {
  if (!limits) return 'No limits'
  const suffix: Record<LimitPeriod, string> = { daily: '/day', weekly: '/week', monthly: '/month', total: ' total' }
  const parts = LIMIT_PERIODS.filter((period) => limits[period] !== null).map((period) => `${formatUsd(limits[period])}${suffix[period]}`)
  return parts.length > 0 ? parts.join(' · ') : 'No limits'
}

/** UTC calendar period windows, matching the gateway's budget periods (weeks start Monday). */
export function periodStart(period: Exclude<LimitPeriod, 'total'>, now = Date.now()): number {
  const date = new Date(now)
  const startOfDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  if (period === 'daily') return startOfDay
  if (period === 'monthly') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  const weekday = (date.getUTCDay() + 6) % 7
  return startOfDay - weekday * 86_400_000
}
