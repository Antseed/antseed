import { describe, expect, it } from 'vitest'
import type { ServiceHealthView } from '../api/types'
import { serviceHealthSummary, servicePerformanceSummary } from './service-health'

const NOW = 1_793_328_300_000
const empty: ServiceHealthView = { status: 'healthy', checkedAt: null, source: null, failingSince: null, consecutiveFailures: null, reason: null, httpStatus: null }

describe('seller self health summary', () => {
  it('says when a healthy model last succeeded and how', () => {
    expect(serviceHealthSummary({ ...empty, checkedAt: NOW - 3 * 60_000, source: 'traffic' }, NOW)).toBe('Self check: served a buyer 3 min ago')
    expect(serviceHealthSummary({ ...empty, checkedAt: NOW - 2 * 3_600_000, source: 'probe' }, NOW)).toBe('Self check: passed 2 h ago')
    expect(serviceHealthSummary(empty, NOW)).toBe('Self check: passed')
    expect(serviceHealthSummary({ ...empty, status: 'unknown' }, NOW)).toBe('Self check: not run yet')
  })

  it('says since when a failing model fails and why', () => {
    const summary = serviceHealthSummary({
      ...empty, status: 'failing', checkedAt: NOW - 60_000, source: 'probe', failingSince: NOW - 10 * 60_000, consecutiveFailures: 3, reason: 'out_of_credit', httpStatus: 402,
    }, NOW)
    expect(summary).toMatch(/^Self check failing since .+: upstream out of credit, HTTP 402, 3 failed checks in a row, last 1 min ago$/)
    expect(serviceHealthSummary({ ...empty, status: 'failing', reason: 'new_code' }, NOW)).toBe('Self check failing: new_code')
    expect(serviceHealthSummary({ ...empty, status: 'failing' }, NOW)).toBe('Self check failing')
  })
})

describe('seller performance summary', () => {
  it('says how the model served buyers in the last hour', () => {
    expect(servicePerformanceSummary({ requests: 312, successRate: 0.971, firstTokenMsP50: 420, firstTokenMsP90: 1250, tokensPerSecondP50: 78 }))
      .toBe('Last hour: 312 requests, 97% ok · 420 ms first token (p90 1.3 s) · 78\u00a0tok/s')
    expect(servicePerformanceSummary({ requests: 1, successRate: 1, firstTokenMsP50: null, firstTokenMsP90: null, tokensPerSecondP50: null }))
      .toBe('Last hour: 1 request, 100% ok')
  })
})
