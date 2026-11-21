import { describe, expect, it } from 'vitest'
import {
  decodeRelayClose, decodeRelayData, decodeRelayOpen, decodeRelayStreamId,
  encodeRelayClose, encodeRelayData, encodeRelayOpen, encodeRelayStreamId, isBlindRelayOffer,
} from './blind-relay.js'

describe('blind relay codecs', () => {
  it('round-trip every frame', () => {
    expect(decodeRelayOpen(encodeRelayOpen({ streamId: 's1', credentialId: 'c-é' }))).toEqual({ streamId: 's1', credentialId: 'c-é' })
    expect(decodeRelayStreamId(encodeRelayStreamId('s2'))).toBe('s2')
    const data = new Uint8Array([0, 1, 2, 255])
    expect(decodeRelayData(encodeRelayData({ streamId: 's3', data }))).toEqual({ streamId: 's3', data })
    expect(decodeRelayClose(encodeRelayClose({ streamId: 's4', reason: 'upstream closed' }))).toEqual({ streamId: 's4', reason: 'upstream closed' })
  })

  it('refuses a truncated frame', () => {
    expect(() => decodeRelayOpen(encodeRelayOpen({ streamId: 'abc', credentialId: 'def' }).slice(0, 6))).toThrow(/truncated/)
  })

  it('reads the seller-blind category', () => {
    expect(isBlindRelayOffer({ categories: ['chat', 'Seller-Blind'] })).toBe(true)
    expect(isBlindRelayOffer({ categories: ['chat'] })).toBe(false)
  })
})
