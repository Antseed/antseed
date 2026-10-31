import { describe, expect, it } from 'vitest'
import type { NetworkModelOffer, Peer } from '../api/types'
import { boostOptions, summarizeModelBoost, type BoostOption } from './boost'
import { isPaidPeer } from './peers'

const option = (peerId: string, boost: number | null, free = false): BoostOption => ({ peerId, key: `${peerId}:m`, name: peerId, boost, free })

describe('model boost summary', () => {
  it('offers the best paid seller over automatic routing’s pick', () => {
    const summary = summarizeModelBoost([option('aa', 2), option('bb', 15.9), option('cc', 40, true)], { peerId: 'aa' })
    expect(summary).toMatchObject({ current: { peerId: 'aa' }, best: { peerId: 'bb' }, better: true })
  })
  it('a free current seller earns nothing, so a paid one with points is better', () => {
    expect(summarizeModelBoost([option('aa', 40, true), option('bb', 0.5)], { key: 'aa:m' })).toMatchObject({ best: { peerId: 'bb' }, better: true })
  })
  it('nothing better when the current seller is the best; no best when none earns', () => {
    expect(summarizeModelBoost([option('aa', 15.9), option('bb', 2)], { peerId: 'aa' })?.better).toBe(false)
    expect(summarizeModelBoost([option('aa', 9, true), option('bb', 0)], null)).toMatchObject({ current: null, best: null, better: false })
  })
  it('is null when no boost is known', () => {
    expect(summarizeModelBoost([option('aa', null)], null)).toBeNull()
  })
  it('reads each offer’s boost from the peer list', () => {
    const offers = [{ peerId: 'AA', serviceId: 'm', displayName: 'Alpha', free: false }] as NetworkModelOffer[]
    const peers = [{ peerId: 'aa', boost: 3 }] as Peer[]
    expect(boostOptions(offers, peers)).toEqual([{ peerId: 'AA', key: 'AA:m', name: 'Alpha', boost: 3, free: false }])
  })
})

describe('paid providers', () => {
  const peer = (prices: Array<[number | null, number | null]>) => ({
    services: prices.map(([input, output], index) => ({ service: `m${index}`, inputUsdPerMillion: input, outputUsdPerMillion: output })),
  }) as unknown as Peer
  it('only a provider that charges for something can earn points', () => {
    expect(isPaidPeer(peer([[0, 0]]))).toBe(false)
    expect(isPaidPeer(peer([[0, 0], [1, 2]]))).toBe(true)
    expect(isPaidPeer(peer([[0, 0], [1, 2]]), 'm0')).toBe(false)
  })
})
