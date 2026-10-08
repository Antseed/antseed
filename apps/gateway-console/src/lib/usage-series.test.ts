import { describe, expect, it } from 'vitest'
import type { UsageReport } from '../api/types'
import {
  COST_PENDING_MS, OTHER_SERIES, bucketReports, chartGrouping, columnRequests, costStatus, groupStart, rangeBuckets, stackSeries, tokenSeries,
} from './usage'

const NOW = Date.UTC(2026, 9, 8, 15, 30)

function report(groups: Array<[string, string, number]>): UsageReport {
  const zero = { requests: 0, failedRequests: 0, spent: '0', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  return {
    from: 0, to: 0, totals: zero,
    groups: groups.map(([group, spent, requests]) => ({ ...zero, group, label: group, spent, requests, inputTokens: requests * 10, outputTokens: requests })),
  }
}

describe('rangeBuckets', () => {
  it('uses 24 hourly buckets ending in the current hour', () => {
    const buckets = rangeBuckets('24h', NOW)
    expect(buckets).toHaveLength(24)
    expect(buckets.at(-1)!.from).toBe(Date.UTC(2026, 9, 8, 15))
    expect(buckets.at(-1)!.to).toBe(NOW + 1)
  })
  it('uses days for 7 and 30 days and weeks for 90 days', () => {
    expect(rangeBuckets('7d', NOW)).toHaveLength(7)
    expect(rangeBuckets('30d', NOW)).toHaveLength(30)
    const weeks = rangeBuckets('90d', NOW)
    expect(weeks.length).toBeGreaterThanOrEqual(13)
    expect(weeks.length).toBeLessThanOrEqual(14)
    expect(weeks.at(-1)!.to).toBe(NOW + 1)
  })
  it('buckets are contiguous', () => {
    const days = rangeBuckets('30d', NOW)
    for (let i = 1; i < days.length; i++) expect(days[i]!.from).toBe(days[i - 1]!.to)
  })
})

describe('stackSeries', () => {
  it('keeps the top groups and folds the rest into Other', () => {
    const reports = [report([['a', '3', 1], ['b', '2', 1], ['c', '1', 1]]), undefined, report([['a', '1', 1], ['c', '0.5', 1]])]
    const { series, columns } = stackSeries(reports, 'spend', 1)
    expect(series.map((entry) => entry.key)).toEqual(['a', OTHER_SERIES])
    expect(series[1]!.total).toBeCloseTo(3.5)
    expect(columns[0]).toEqual({ a: 3, [OTHER_SERIES]: 3 })
    expect(columns[1]).toEqual({})
    expect(columns[2]).toEqual({ a: 1, [OTHER_SERIES]: 0.5 })
  })
  it('ranks by the chosen metric and drops empty groups', () => {
    const { series } = stackSeries([report([['cheap', '0.1', 9], ['dear', '5', 1], ['idle', '0', 0]])], 'requests')
    expect(series.map((entry) => entry.key)).toEqual(['cheap', 'dear'])
    expect(stackSeries([report([['x', '1', 2]])], 'tokens').series[0]!.total).toBe(22)
  })
})

type Split = NonNullable<UsageReport['groups'][number]['splits']>[number]

function split(group: string, spent: string, requests: number, tokens: [number, number, number] = [0, 0, 0]): Split {
  return { group, label: group, spent, requests, failedRequests: 0, inputTokens: tokens[0], cachedInputTokens: tokens[1], outputTokens: tokens[2] }
}

function dayReport(groups: Array<[string, Split[]]>): UsageReport {
  const zero = { requests: 0, failedRequests: 0, spent: '0', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  return { from: 0, to: 0, totals: zero, groups: groups.map(([group, splits]) => ({ ...zero, group, label: group, splits })) }
}

describe('one-request chart data', () => {
  it('reads hours for 24 hours and days otherwise', () => {
    expect(chartGrouping('24h')).toBe('hour')
    expect(chartGrouping('7d')).toBe('day')
    expect(chartGrouping('90d')).toBe('day')
    expect(groupStart('2026-10-08T15')).toBe(Date.UTC(2026, 9, 8, 15))
    expect(groupStart('2026-10-08')).toBe(Date.UTC(2026, 9, 8))
    expect(groupStart('model-x')).toBeNaN()
  })

  it('folds day groups into the range buckets, summing models', () => {
    const buckets = rangeBuckets('7d', NOW)
    const report = dayReport([
      ['2026-10-02', [split('a', '1', 1)]],
      ['2026-10-08', [split('a', '0.5', 2), split('b', '0.25', 1)]],
      ['2026-09-01', [split('a', '9', 9)]],
    ])
    const columns = bucketReports(report, buckets)
    expect(columns).toHaveLength(7)
    expect(columns[0]!.groups.map((group) => group.group)).toEqual(['a'])
    expect(columns[6]!.groups.map((group) => [group.group, group.requests])).toEqual([['a', 2], ['b', 1]])
    expect(columnRequests(columns)).toBe(4)
    const { series } = stackSeries(columns, 'spend')
    expect(series.map((entry) => [entry.key, entry.total])).toEqual([['a', 1.5], ['b', 0.25]])
  })

  it('folds days into weeks for 90 days', () => {
    const buckets = rangeBuckets('90d', NOW)
    const last = buckets.at(-1)!
    const day = new Date(last.from).toISOString().slice(0, 10)
    const next = new Date(last.from + 86_400_000).toISOString().slice(0, 10)
    const columns = bucketReports(dayReport([[day, [split('a', '1', 1)]], [next, [split('a', '2', 3)]]]), buckets)
    expect(columns.at(-1)!.groups).toEqual([expect.objectContaining({ group: 'a', requests: 4, spent: '3.000000' })])
  })

  it('stacks tokens by type: uncached input, cached input, output, summed across models', () => {
    const columns = [
      { groups: [split('a', '0', 1, [100, 40, 10]), split('b', '0', 1, [50, 0, 5])] },
      { groups: [] },
      undefined,
    ]
    const { series, columns: stacked } = tokenSeries(columns)
    expect(series.map((entry) => [entry.key, entry.label, entry.total])).toEqual([['input', 'Input', 110], ['cached', 'Cached input', 40], ['output', 'Output', 15]])
    expect(stacked).toEqual([{ input: 110, cached: 40, output: 15 }, { input: 0, cached: 0, output: 0 }, { input: 0, cached: 0, output: 0 }])
  })

  it('counts a $0 request so the chart is not empty', () => {
    const columns = bucketReports(dayReport([['2026-10-08', [split('a', '0', 1)]]]), rangeBuckets('7d', NOW))
    expect(columnRequests(columns)).toBe(1)
    expect(stackSeries(columns, 'spend').series).toEqual([])
  })
})

describe('costStatus', () => {
  const base = { startedAt: NOW - 2000, finishedAt: NOW - 1000 }
  it('shows spend once recorded', () => {
    expect(costStatus({ ...base, spent: '0.000000' }, NOW)).toBe('spent')
  })
  it('is pending for a while, then not recorded', () => {
    expect(costStatus({ ...base, spent: null, costPending: true }, NOW)).toBe('pending')
    expect(costStatus({ ...base, spent: null, costPending: true }, NOW - 1000 + COST_PENDING_MS)).toBe('not-recorded')
    expect(costStatus({ startedAt: NOW - COST_PENDING_MS * 2, finishedAt: null, spent: null, costPending: true }, NOW)).toBe('not-recorded')
  })
  it('has nothing to show for a failed request', () => {
    expect(costStatus({ ...base, spent: null }, NOW)).toBeNull()
  })
})
