import { describe, expect, it } from 'vitest'
import type { RoutePreview, RouteSelection, ServedSelection } from '../api/types'
import { healthWarning, neverReason, previewListsSellers, routingPlaces, orderingSummary, pickSummary, previewSort, rankCandidates, recordSummary, selectionFacts, selectionHeadline } from './selection'

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

  it('starts from the seller-reported figures when the buyer has no record', () => {
    const reported = { requests: 312, successRate: 0.99, firstTokenMsP50: 420, tokensPerSecondP50: 78 }
    const fresh = { ...base, record: 'none' as const, observations: 0, successRate: 0.95, firstTokenMs: null, tokensPerSecond: null, reported }
    expect(recordSummary(fresh)).toBe("No requests yet: the seller reports 99% success over its last hour's 312 requests, so routing starts from 95%.")
    expect(selectionHeadline(fresh)).toMatch(/^seller reports 99% success \(312 last hour\) · 420 ms first token · 78\u00a0tok\/s/)
    // Too few requests to start from: the default prior stands.
    expect(recordSummary({ ...fresh, reported: { ...reported, requests: 3 } })).toMatch(/^No requests yet: assumed 80%/)
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

  it('fits the numbers that set a seller\'s place on one line', () => {
    expect(selectionHeadline(base)).toBe('96% success (12 recent) · 420 ms first token · 80\u00a0tok/s · 60% of traffic · $0.0021 per answer')
    expect(selectionHeadline({ ...base, record: 'none', firstTokenMs: null, tokensPerSecond: null, sharesTraffic: false, ordering: 'trust' })).toBe('no requests yet')
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

describe('ranking a preview', () => {
  const candidate = (peerId: string, patch: Partial<RoutePreview['candidates'][number]>): RoutePreview['candidates'][number] => ({
    peerId, displayName: null, rank: null, eligible: false, reasons: [], inputUsdPerMillion: 1, outputUsdPerMillion: 2, trustScore: 50, selection: null, ...patch,
  })
  const preview = (sort: RoutePreview['policy']['sort'], candidates: RoutePreview['candidates']): RoutePreview =>
    ({ model: 'm', policy: sort ? { sort } : {}, sources: [], modelAllowed: true, candidates })
  const peers = [
    candidate('a', { eligible: true, rank: 2, selection: base }),
    candidate('b', { eligible: true, rank: 1, selection: base }),
    candidate('cheap', { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2, trustScore: 10, reasons: ['trust 10 below 70'] }),
    candidate('trusted', { inputUsdPerMillion: 3, outputUsdPerMillion: 9, trustScore: 90, reasons: ['over input price cap'] }),
    candidate('unpriced', { inputUsdPerMillion: null, outputUsdPerMillion: null, trustScore: null }),
  ]

  it('keeps sellers in range in the order they are tried', () => {
    expect(rankCandidates(preview(undefined, peers)).inRange.map((c) => c.peerId)).toEqual(['b', 'a'])
  })

  it('orders the sellers it never selects by the same sort', () => {
    expect(rankCandidates(preview(undefined, peers)).never.map((c) => c.peerId)).toEqual(['cheap', 'trusted', 'unpriced'])
    expect(rankCandidates(preview('trust', peers)).never.map((c) => c.peerId)).toEqual(['trusted', 'cheap', 'unpriced'])
    const latency = rankCandidates(preview('latency', peers), (id) => (id === 'unpriced' ? 100 : id === 'trusted' ? 900 : null))
    expect(latency.never.map((c) => c.peerId)).toEqual(['unpriced', 'trusted', 'cheap'])
  })

  it('takes the sort from the buyer when the policy sets none', () => {
    expect(previewSort(preview(undefined, [candidate('x', { eligible: true, rank: 1, selection: { ...base, ordering: 'trust' } })]))).toBe('trust')
    expect(previewSort(preview(undefined, peers))).toBe('balanced')
  })

  it('falls back to the catalog when a refused model comes back without sellers', () => {
    expect(previewListsSellers(undefined)).toBe(false)
    expect(previewListsSellers({ ...preview(undefined, []), modelAllowed: false })).toBe(false)
    expect(previewListsSellers(preview(undefined, peers))).toBe(true)
  })

  it('places each seller for the Providers routing column', () => {
    const places = routingPlaces(preview(undefined, peers), [{ peerId: 'A', firstTokenMsP50: null }])
    expect(places.get('b')).toEqual({ order: 0, rank: 1, reason: null })
    expect(places.get('a')).toEqual({ order: 1, rank: 2, reason: null })
    expect(places.get('cheap')).toEqual({ order: 10_000, rank: null, reason: 'trust 10 below 70' })
  })

  it('filters out every seller of a model the policy refuses', () => {
    const places = routingPlaces({ ...preview(undefined, []), modelAllowed: false }, [{ peerId: 'X', firstTokenMsP50: null }, { peerId: 'y', firstTokenMsP50: 5 }])
    expect(places.get('x')).toEqual({ order: 10_000, rank: null, reason: 'your routing policy does not allow this model' })
    expect(places.get('y')?.reason).toBe('your routing policy does not allow this model')
  })

  it('says why a seller is never selected', () => {
    expect(neverReason(peers[2]!)).toBe('trust 10 below 70')
    expect(neverReason(peers[4]!)).toBe('outside your routing settings')
    expect(neverReason(peers[2]!, false)).toBe('your routing policy does not allow this model')
  })
})
