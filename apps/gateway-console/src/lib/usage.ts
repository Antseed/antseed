import type { RequestLogEntry, UsageGroupBy, UsageReport, UsageTotals } from '../api/types'
import { usdcToNumber } from './format'

const DAY = 86_400_000

function startOfUtcDay(ms: number): number {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/** `YYYY-MM-DD` for a UTC day; the gateway's day groups use this key. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Daily spend points from a `groupBy=day` report, with zero-filled gaps across [from, to]. */
export function dailySeries(report: UsageReport | undefined, from: number, to: number): Array<{ label: string; value: number; sub: string }> {
  const byDay = new Map<string, { spent: number; requests: number }>()
  for (const group of report?.groups ?? []) {
    byDay.set(group.group.slice(0, 10), { spent: usdcToNumber(group.spent), requests: group.requests })
  }
  const points = []
  for (let day = startOfUtcDay(from); day <= to; day += DAY) {
    const key = dayKey(day)
    const entry = byDay.get(key)
    const label = new Date(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    points.push({ label, value: entry?.spent ?? 0, sub: `${entry?.requests ?? 0} requests` })
  }
  return points
}

export const RANGES = [
  { id: '24h', label: '24 hours', ms: DAY },
  { id: '7d', label: '7 days', ms: 7 * DAY },
  { id: '30d', label: '30 days', ms: 30 * DAY },
  { id: '90d', label: '90 days', ms: 90 * DAY },
] as const

export type RangeId = (typeof RANGES)[number]['id']

export function rangeFrom(id: RangeId, now = Date.now()): number {
  const range = RANGES.find((entry) => entry.id === id)!
  return id === '24h' ? now - range.ms : startOfUtcDay(now - range.ms + DAY)
}

const HOUR = 3_600_000

interface Bucket { from: number; to: number; label: string }

/**
 * Chart buckets for a range: hours for 24 hours, days for 7 and 30 days,
 * weeks for 90 days, so a chart never has more than ~31 columns. `to` is
 * exclusive and the last bucket ends at `now`.
 */
export function rangeBuckets(id: RangeId, now = Date.now()): Bucket[] {
  const buckets: Bucket[] = []
  if (id === '24h') {
    const end = Math.floor(now / HOUR) * HOUR + HOUR
    for (let start = end - 24 * HOUR; start < end; start += HOUR) {
      const label = new Date(start).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'UTC' })
      buckets.push({ from: start, to: Math.min(start + HOUR, now + 1), label })
    }
    return buckets
  }
  const step = id === '90d' ? 7 * DAY : DAY
  const from = rangeFrom(id, now)
  for (let start = from; start <= now; start += step) {
    const label = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    buckets.push({ from: start, to: Math.min(start + step, now + 1), label })
  }
  return buckets
}

export type SeriesMetric = 'spend' | 'requests' | 'tokens'

type Group = UsageReport['groups'][number]

function metricValue(group: Pick<Group, 'spent' | 'requests' | 'inputTokens' | 'outputTokens'>, metric: SeriesMetric): number {
  if (metric === 'spend') return usdcToNumber(group.spent)
  if (metric === 'requests') return group.requests
  return group.inputTokens + group.outputTokens
}

export const OTHER_SERIES = '__other__'

/**
 * Stacked series from one set of groups per bucket: the `top` largest groups
 * over the whole range keep their own series, the rest fold into "Other".
 */
export function stackSeries(reports: Array<Pick<UsageReport, 'groups'> | undefined>, metric: SeriesMetric, top = 6): {
  series: Array<{ key: string; label: string; total: number }>
  columns: Array<Record<string, number>>
} {
  const totals = new Map<string, { label: string; total: number }>()
  for (const report of reports) {
    for (const group of report?.groups ?? []) {
      const entry = totals.get(group.group) ?? { label: group.label || group.group, total: 0 }
      entry.total += metricValue(group, metric)
      totals.set(group.group, entry)
    }
  }
  const ranked = [...totals.entries()].filter(([, entry]) => entry.total > 0).sort((a, b) => b[1].total - a[1].total)
  const kept = ranked.slice(0, top)
  const keep = new Set(kept.map(([key]) => key))
  const otherTotal = ranked.slice(top).reduce((sum, [, entry]) => sum + entry.total, 0)
  const series = kept.map(([key, entry]) => ({ key, label: entry.label, total: entry.total }))
  if (otherTotal > 0) series.push({ key: OTHER_SERIES, label: 'Other', total: otherTotal })
  const columns = reports.map((report) => {
    const column: Record<string, number> = {}
    for (const group of report?.groups ?? []) {
      const key = keep.has(group.group) ? group.group : OTHER_SERIES
      column[key] = (column[key] ?? 0) + metricValue(group, metric)
    }
    return column
  })
  return { series, columns }
}

/** The report grouping a range's chart reads: hours for 24 hours, else days (folded into weeks for 90 days). */
export function chartGrouping(id: RangeId): Extract<UsageGroupBy, 'hour' | 'day'> {
  return id === '24h' ? 'hour' : 'day'
}

/** Start (UTC ms) of an `hour` (`YYYY-MM-DDTHH`) or `day` (`YYYY-MM-DD`) group key; NaN if it is neither. */
export function groupStart(key: string): number {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(key)) return Date.parse(`${key}:00:00Z`)
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return Date.parse(`${key}T00:00:00Z`)
  return Number.NaN
}

type SplitGroup = { group: string; label: string } & UsageTotals

/**
 * One single report (grouped by hour or day, split by model) folded into
 * the chart's buckets: per bucket, the models' totals summed over the hours
 * or days in it. Groups outside every bucket are dropped.
 */
export function bucketReports(report: UsageReport | undefined, buckets: readonly Bucket[]): Array<{ groups: SplitGroup[] }> {
  const columns = buckets.map(() => new Map<string, SplitGroup>())
  for (const group of report?.groups ?? []) {
    const start = groupStart(group.group)
    const index = buckets.findIndex((bucket) => start >= bucket.from && start < bucket.to)
    if (index === -1) continue
    const column = columns[index]!
    for (const split of group.splits ?? []) {
      const entry = column.get(split.group)
      if (!entry) { column.set(split.group, { ...split }); continue }
      entry.requests += split.requests
      entry.failedRequests += split.failedRequests
      entry.spent = (usdcToNumber(entry.spent) + usdcToNumber(split.spent)).toFixed(6)
      entry.inputTokens += split.inputTokens
      entry.cachedInputTokens += split.cachedInputTokens
      entry.outputTokens += split.outputTokens
    }
  }
  return columns.map((column) => ({ groups: [...column.values()] }))
}

export const TOKEN_SERIES = [
  { key: 'input', label: 'Input' },
  { key: 'cached', label: 'Cached input' },
  { key: 'output', label: 'Output' },
] as const

/**
 * Tokens per bucket by type, summed across models: uncached input (input
 * tokens include cached ones), cached input and output. Always the three
 * series, in this order, so colours and legend stay put.
 */
export function tokenSeries(columns: Array<{ groups: Array<Pick<UsageTotals, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>> } | undefined>): {
  series: Array<{ key: string; label: string; total: number }>
  columns: Array<Record<string, number>>
} {
  const totals = { input: 0, cached: 0, output: 0 }
  const out = columns.map((column) => {
    const values = { input: 0, cached: 0, output: 0 }
    for (const group of column?.groups ?? []) {
      values.cached += group.cachedInputTokens
      values.input += Math.max(0, group.inputTokens - group.cachedInputTokens)
      values.output += group.outputTokens
    }
    totals.input += values.input
    totals.cached += values.cached
    totals.output += values.output
    return values
  })
  return { series: TOKEN_SERIES.map((entry) => ({ ...entry, total: totals[entry.key] })), columns: out }
}

/** Requests across the chart's columns (the empty state is about requests, not spend). */
export function columnRequests(columns: Array<{ groups: Array<Pick<UsageTotals, 'requests'>> } | undefined>): number {
  return columns.reduce((sum, column) => sum + (column?.groups ?? []).reduce((inner, group) => inner + group.requests, 0), 0)
}

/** After this long without spend, a pending cost is shown as not recorded. */
export const COST_PENDING_MS = 10 * 60 * 1000

/**
 * How a request's cost reads: its spend; `pending` while a model request
 * waits for the buyer to report spend; `not recorded` once it waited
 * `COST_PENDING_MS` (a free seller, or spend the buyer lost); null when
 * there is nothing to show (failed requests).
 */
export function costStatus(entry: Pick<RequestLogEntry, 'spent' | 'costPending' | 'startedAt' | 'finishedAt'>, now: number): 'spent' | 'pending' | 'not-recorded' | null {
  if (entry.spent !== null) return 'spent'
  if (!entry.costPending) return null
  return now - (entry.finishedAt ?? entry.startedAt) < COST_PENDING_MS ? 'pending' : 'not-recorded'
}
