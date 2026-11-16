import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { OTHER_COLOR, SERIES_COLORS, StackedBarChart } from '@antseed/ui'
import { api } from '../api'
import type { UsageFilter } from '../api/client'
import { formatNumber, formatTokens, formatUsd, usdcToNumber } from '../lib/format'
import { qk } from '../lib/queries'
import {
  OTHER_SERIES, TOKEN_SERIES, bucketReports, chartGrouping, columnRequests, rangeBuckets, stackSeries, tokenSeries,
  type RangeId, type SeriesMetric,
} from '../lib/usage'
import { Icon } from './icons'
import { EmptyState, ErrorAlert, LoadingRows } from './ui'

export const METRICS: Array<{ value: SeriesMetric; label: string }> = [
  { value: 'spend', label: 'Spend' },
  { value: 'requests', label: 'Requests' },
  { value: 'tokens', label: 'Tokens' },
]

const METRIC_FORMAT: Record<SeriesMetric, (value: number) => string> = {
  spend: (value) => formatUsd(value),
  requests: (value) => formatNumber(value, { compact: true }),
  tokens: (value) => formatTokens(value),
}

export function bucketUnit(range: RangeId): string {
  if (range === '24h') return 'hour'
  if (range === '90d') return 'week'
  return 'day'
}

/** Fixed colours per token type, so the legend reads the same in every range. */
const TOKEN_COLORS: Record<(typeof TOKEN_SERIES)[number]['key'], string> = {
  input: SERIES_COLORS[0]!,
  cached: SERIES_COLORS[5]!,
  output: SERIES_COLORS[2]!,
}

/** What the chart shows, for the panel description. */
export function chartDescription(metric: SeriesMetric, range: RangeId): string {
  if (metric === 'tokens') return `Tokens per ${bucketUnit(range)} by type (input, cached input, output), UTC.`
  return `${METRICS.find((entry) => entry.value === metric)!.label} per ${bucketUnit(range)} by model, UTC. The largest models get their own colour.`
}

/**
 * Usage over a range in one request (grouped by hour or day, split by
 * model), one column per hour, day or week. Spend and requests stack by
 * model (the largest in their own colour, the rest as Other); tokens stack
 * by type.
 */
export function UsageByModel({ filter, range, now, metric, height }: {
  filter: Omit<UsageFilter, 'from' | 'to'>; range: RangeId; now: number; metric: SeriesMetric; height?: number
}) {
  const buckets = useMemo(() => rangeBuckets(range, now), [range, now])
  const reportFilter = { ...filter, from: buckets[0]!.from, to: buckets.at(-1)!.to - 1, groupBy: chartGrouping(range), splitBy: 'model' as const }
  const report = useQuery({ queryKey: qk.usage(reportFilter), queryFn: () => api.usage.report(reportFilter) })
  const columns = useMemo(() => bucketReports(report.data, buckets), [report.data, buckets])
  if (report.isLoading) return <LoadingRows rows={1} height={height ?? 240} />
  if (report.error) return <ErrorAlert error={report.error} onRetry={() => void report.refetch()} />
  const requests = columnRequests(columns)
  if (requests === 0) {
    return <EmptyState icon={<Icon.activity size={18} />} title="No usage in this range" body="Requests made with this workspace's keys show up here." />
  }
  const stacked = metric === 'tokens' ? tokenSeries(columns) : stackSeries(columns, metric)
  const series = stacked.series.map((entry, index) => ({
    ...entry,
    color: metric === 'tokens'
      ? TOKEN_COLORS[entry.key as keyof typeof TOKEN_COLORS]
      : entry.key === OTHER_SERIES ? OTHER_COLOR : SERIES_COLORS[index % SERIES_COLORS.length]!,
  }))
  const total = series.reduce((sum, entry) => sum + entry.total, 0)
  const spent = columns.reduce((sum, column) => sum + column.groups.reduce((inner, group) => inner + usdcToNumber(group.spent), 0), 0)
  return (
    <>
      <StackedBarChart label={metric === 'tokens' ? 'tokens by type' : `${metric} by model`} labels={buckets.map((bucket) => bucket.label)}
        columns={stacked.columns} series={series} format={METRIC_FORMAT[metric]} height={height} />
      {total === 0 && (
        <p className="gc-fineprint">
          {formatNumber(requests)} {requests === 1 ? 'request' : 'requests'}, {formatUsd(spent)} recorded so far
          {metric === 'tokens' ? ' (no token counts reported yet)' : ''}.
        </p>
      )}
    </>
  )
}
