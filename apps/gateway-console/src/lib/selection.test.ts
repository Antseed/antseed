import { describe, expect, it } from 'vitest'
import type { RouteSelection, ServedSelection } from '../api/types'
import { healthWarning, orderingSummary, pickSummary, recordSummary, selectionFacts } from './selection'

const NOW = 1_700_000_000_000

const base: RouteSelection = {
  expectedCostUsd: 0.0021, expectedPriceUsd: 0.002, expectedSeconds: 3, successRate: 0.96, observations: 12.4, record: 'model',
  firstTokenMs: 420, tokensPerSecond: 80, lastSuccessAt: NOW, lastFailureAt: null, lastFailureReason: null,
  failing: false, coolingDown: false, stale: false, ordering: 'expected-cost', sharesTraffic: true, trafficShare: 0.6, poolSize: 2,
  channel: 'open', inFlight: 1, maxConcurrency: 8, routeChainPosition: null,
}

const served = (patch: Partial<ServedSelection>): ServedSelection => ({ ...base, rank: 1, of: 3, attempt: 0, pick: 'spread', ...patch })

describe('seller selection explanations', () => {
  it('says how the sellers are ordered', () => {
    expect(orderingSummary('expected-cost', 2)).toMatch(/The 2 sellers within 30% of the best share the traffic/)
    expect(orderingSummary('expected-cost', 1)).toMatch(/no other is close enough/)
    expect(orderingSummary('trust', 0)).toMatch(/^Ranked by trust score/)
    expect(orderingSummary('price', 0)).toMatch(/sorts by price/)
  })

  it('says what the record is based on, borrowed or none', () => {
    expect(recordSummary(base)).toBe('96% success over 12 recent requests')
    expect(recordSummary({ ...base, record: 'other-models', observations: 1 })).toBe('96% success over 1 recent request on its other models (counted at half weight)')
    expect(recordSummary({ ...base, record: 'none', observations: 0 })).toMatch(/^No requests yet: assumed 80%/)
  })

  it('lists the facts routing used, with the expected cost only when it ranks by it', () => {
    expect(selectionFacts(base)).toEqual([
      '$0.0021 expected per good answer', '96% success over 12 recent requests', '420 ms first token', '80 tok/s',
      'takes ~60% of the traffic', 'payment channel open', '1/8 in flight',
    ])
    const trust = selectionFacts({ ...base, ordering: 'trust', sharesTraffic: false, trafficShare: null, channel: 'new', inFlight: 8 })
    expect(trust[0]).toBe('96% success over 12 recent requests')
    expect(trust).toContain('first request opens a payment channel (~5 s)')
    expect(trust).toContain('at capacity (8/8 in flight): tried after sellers with room')
  })

  it('warns about failing and cooling-down sellers with the last failure', () => {
    expect(healthWarning(base, NOW)).toBeNull()
    expect(healthWarning({ ...base, failing: true, lastFailureReason: 'seller 503', lastFailureAt: NOW - 3 * 60_000 }, NOW))
      .toBe('Failing lately: seller 503, 3 min ago. Tried after the healthy sellers.')
    expect(healthWarning({ ...base, failing: true, coolingDown: true }, NOW)).toMatch(/^Cooling down after failures in a row\. Tried last\./)
  })

  it('explains how a served request got its seller', () => {
    expect(pickSummary(served({}))).toBe('Drawn from the 2 sellers sharing this model\'s traffic (#1 of 3 eligible sellers).')
    expect(pickSummary(served({ pick: 'best', of: 1 }))).toBe('The best seller for this model on its own (#1 of 1 eligible seller).')
    expect(pickSummary(served({ pick: 'failover', rank: 3, attempt: 2 }))).toMatch(/^The 2 sellers before it failed this request/)
    expect(pickSummary(served({ pick: 'order', ordering: 'trust' }))).toMatch(/^The most trusted healthy seller/)
    expect(pickSummary(served({ pick: 'order', routeChainPosition: 1 }))).toMatch(/^Seller #1 in your routing policy's route/)
    expect(pickSummary(served({ pick: 'conversation' }))).toMatch(/prompt cache/)
    expect(pickSummary(served({ pick: 'exploration', rank: 3 }))).toMatch(/^A probe/)
  })
})
