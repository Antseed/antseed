import { describe, it, expect } from 'vitest'
import type { PeerInfo } from '@antseed/node'
import { scoreCandidates, DEFAULT_WEIGHTS } from './peer-scorer.js'
import type { PeerMetrics, TokenPricingUsdPerMillion } from './peer-scorer.js'

function makePeerId(char: string): PeerInfo['peerId'] {
  return char.repeat(40) as PeerInfo['peerId']
}

function makePeer(overrides?: Partial<PeerInfo>): PeerInfo {
  return {
    peerId: makePeerId('a'),
    lastSeen: 1_000_000,
    providers: ['anthropic'],
    reputationScore: 80,
    maxConcurrency: 10,
    currentLoad: 1,
    ...overrides,
  }
}

const defaultMetrics: PeerMetrics = {
  latencyEma: undefined,
  failureStreak: 0,
  totalFailures: 0,
  totalAttempts: 0,
  cooldownUntil: undefined,
}

const defaultOffer: TokenPricingUsdPerMillion = {
  inputUsdPerMillion: 10,
  outputUsdPerMillion: 10,
}

const defaultContext = {
  now: 1_000_000,
  medianLatency: 500,
  maxPeerStalenessMs: 300_000,
  maxFailures: 3,
}

describe('scoreCandidates', () => {
  it('returns correct score ordering — cheaper peer ranks higher', () => {
    const cheapPeer = makePeer({ peerId: makePeerId('1') })
    const expensivePeer = makePeer({ peerId: makePeerId('2') })

    const result = scoreCandidates(
      [
        {
          peer: expensivePeer,
          provider: 'anthropic',
          providerRank: 0,
          offer: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 },
          metrics: defaultMetrics,
        },
        {
          peer: cheapPeer,
          provider: 'anthropic',
          providerRank: 0,
          offer: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 },
          metrics: defaultMetrics,
        },
      ],
      defaultContext,
    )

    expect(result).toHaveLength(2)
    expect(result[0]!.peer.peerId).toBe(cheapPeer.peerId)
    expect(result[1]!.peer.peerId).toBe(expensivePeer.peerId)
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score)
  })

  it('custom weights change ranking — zero out price, maximize latency', () => {
    const cheapButSlow = makePeer({ peerId: makePeerId('1') })
    const expensiveButFast = makePeer({ peerId: makePeerId('2') })

    const result = scoreCandidates(
      [
        {
          peer: cheapButSlow,
          provider: 'anthropic',
          providerRank: 0,
          offer: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          metrics: { ...defaultMetrics, latencyEma: 1000 },
        },
        {
          peer: expensiveButFast,
          provider: 'anthropic',
          providerRank: 0,
          offer: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 },
          metrics: { ...defaultMetrics, latencyEma: 50 },
        },
      ],
      {
        ...defaultContext,
        weights: {
          price: 0,
          latency: 1.0,
          capacity: 0,
          reputation: 0,
          freshness: 0,
          reliability: 0,
        },
      },
    )

    expect(result[0]!.peer.peerId).toBe(expensiveButFast.peerId)
  })

  it('handles single candidate', () => {
    const peer = makePeer({ peerId: makePeerId('1') })

    const result = scoreCandidates(
      [
        {
          peer,
          provider: 'anthropic',
          providerRank: 0,
          offer: defaultOffer,
          metrics: defaultMetrics,
        },
      ],
      defaultContext,
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.peer.peerId).toBe(peer.peerId)
    expect(result[0]!.score).toBeGreaterThan(0)
  })

  it('handles all equal scores — tie-broken by peerId', () => {
    const peerA = makePeer({ peerId: makePeerId('a') })
    const peerB = makePeer({ peerId: makePeerId('b') })

    const result = scoreCandidates(
      [
        {
          peer: peerB,
          provider: 'anthropic',
          providerRank: 0,
          offer: defaultOffer,
          metrics: defaultMetrics,
        },
        {
          peer: peerA,
          provider: 'anthropic',
          providerRank: 0,
          offer: defaultOffer,
          metrics: defaultMetrics,
        },
      ],
      defaultContext,
    )

    expect(result).toHaveLength(2)
    const again = scoreCandidates(
      [
        { peer: peerB, provider: 'anthropic', providerRank: 0, offer: defaultOffer, metrics: defaultMetrics },
        { peer: peerA, provider: 'anthropic', providerRank: 0, offer: defaultOffer, metrics: defaultMetrics },
      ],
      defaultContext,
    )
    // Identical scores take turns. A single call no longer pins the lower peer id.
    expect(new Set([result[0]!.peer.peerId, again[0]!.peer.peerId])).toEqual(new Set([peerA.peerId, peerB.peerId]))
    expect(result.map((row) => row.peer.peerId).sort()).toEqual([peerA.peerId, peerB.peerId].sort())
  })

  it('rotates each tied score pool on its own', () => {
    const score = (seed: string) => ({
      peer: makePeer({ peerId: makePeerId(seed) }),
      provider: 'anthropic' as const,
      providerRank: 0,
      offer: defaultOffer,
      metrics: defaultMetrics,
    })
    const first = [score('a'), score('b')]
    const second = [score('c'), score('d')]
    const firstPicks: string[] = []
    const secondPicks: string[] = []
    for (let i = 0; i < 4; i += 1) {
      firstPicks.push(scoreCandidates(first, defaultContext)[0]!.peer.peerId)
      secondPicks.push(scoreCandidates(second, defaultContext)[0]!.peer.peerId)
    }
    expect(new Set(firstPicks).size).toBe(2)
    expect(new Set(secondPicks).size).toBe(2)
    for (let i = 1; i < firstPicks.length; i += 1) {
      expect(firstPicks[i]).not.toBe(firstPicks[i - 1])
      expect(secondPicks[i]).not.toBe(secondPicks[i - 1])
    }
  })

  it('rotates two models that share sellers on their own', () => {
    const shared = ['a', 'b'].map((seed) => ({
      peer: makePeer({ peerId: makePeerId(seed) }),
      provider: 'anthropic' as const,
      providerRank: 0,
      offer: defaultOffer,
      metrics: defaultMetrics,
    }))
    const modelA: string[] = []
    const modelB: string[] = []
    for (let i = 0; i < 4; i += 1) {
      modelA.push(scoreCandidates(shared, { ...defaultContext, rotationKey: 'model-a' })[0]!.peer.peerId)
      modelB.push(scoreCandidates(shared, { ...defaultContext, rotationKey: 'model-b' })[0]!.peer.peerId)
    }
    expect(new Set(modelA).size).toBe(2)
    expect(new Set(modelB).size).toBe(2)
    for (let i = 1; i < modelA.length; i += 1) {
      expect(modelA[i]).not.toBe(modelA[i - 1])
      expect(modelB[i]).not.toBe(modelB[i - 1])
    }
  })

  it('returns empty array for empty candidates', () => {
    const result = scoreCandidates([], defaultContext)
    expect(result).toHaveLength(0)
  })

  it('uses default weights when none provided', () => {
    const peer = makePeer({ peerId: makePeerId('1') })

    const result = scoreCandidates(
      [
        {
          peer,
          provider: 'anthropic',
          providerRank: 0,
          offer: defaultOffer,
          metrics: defaultMetrics,
        },
      ],
      defaultContext,
    )

    // With a single candidate, all normalized-inverted factors are 1.0
    // Score = sum of all weights = 1.0 (minus any freshness/reputation adjustments)
    expect(result[0]!.score).toBeGreaterThan(0)
    expect(result[0]!.score).toBeLessThanOrEqual(
      DEFAULT_WEIGHTS.price +
      DEFAULT_WEIGHTS.latency +
      DEFAULT_WEIGHTS.capacity +
      DEFAULT_WEIGHTS.reputation +
      DEFAULT_WEIGHTS.freshness +
      DEFAULT_WEIGHTS.reliability,
    )
  })
})
