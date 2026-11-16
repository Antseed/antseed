import { describe, expect, it } from 'vitest'
import type { Channel } from '../api/types'
import {
  CHANNEL_CLOSE_GRACE_MS, channelAction, channelStatusLabel, cooperativeCloseError, formatCountdown, isEntireBalanceLocked, pendingSpend,
  walletUsdcMessage, withdrawableSummary,
} from './channels'

const NOW = 1_700_000_000_000

function channel(extra: Partial<Channel>): Channel {
  return {
    channelId: '0xc', peerId: 'aa'.repeat(20), sellerName: 'Fake Seller', status: 'active', reserved: '2.000000', spent: '0.500000',
    openedAt: NOW, canCooperativeClose: true, closeRequestedAt: null, settled: '0.200000', ...extra,
  }
}

describe('channelAction', () => {
  it('asks the seller first, then falls back to the on-chain close', () => {
    expect(channelAction(channel({}), false)).toBe('cooperative')
    expect(channelAction(channel({}), true)).toBe('on-chain')
    expect(channelAction(channel({ canCooperativeClose: false }), false)).toBe('on-chain')
  })
  it('offers nothing while closing and the withdrawal once the grace period ends', () => {
    expect(channelAction(channel({ status: 'closing', closeRequestedAt: NOW }), false)).toBe('none')
    expect(channelAction(channel({ status: 'withdrawable', closeRequestedAt: NOW }), false)).toBe('withdraw')
    expect(channelAction(channel({ status: 'settled' }), false)).toBe('none')
  })
})

describe('status and countdown', () => {
  it('counts down to the withdrawal', () => {
    const closing = channel({ status: 'closing', closeRequestedAt: NOW })
    expect(channelStatusLabel(closing, NOW + 60_000)).toBe('closing · 14 min left')
    expect(channelStatusLabel(closing, NOW + CHANNEL_CLOSE_GRACE_MS - 30_000)).toBe('closing · 30 s left')
    expect(channelStatusLabel(channel({ status: 'withdrawable' }))).toBe('ready to withdraw')
    expect(formatCountdown(NOW - 1, NOW)).toBe('0 s')
  })
})

describe('balances', () => {
  it('sums unsettled spend over open channels only', () => {
    expect(pendingSpend([channel({}), channel({ status: 'settled', spent: '9.000000', settled: '0.000000' }), channel({ settled: null, spent: '0.100000' })])).toBeCloseTo(0.4)
  })
  it('sums what withdrawable channels return', () => {
    expect(withdrawableSummary([channel({ status: 'withdrawable' }), channel({})])).toEqual({ count: 1, amount: 1.5 })
  })
  it('flags a balance that sits entirely in channels', () => {
    expect(isEntireBalanceLocked({ available: '0.000000', reserved: '3.000000', walletUsdc: '0.000000' })).toBe(true)
    expect(isEntireBalanceLocked({ available: '0.000000', reserved: '3.000000', walletUsdc: '1.000000' })).toBe(false)
  })
  it('explains wallet USDC held back by the credit limit', () => {
    expect(walletUsdcMessage({ available: '9.000000', reserved: '1.000000', walletUsdc: '5.000000', creditLimit: '10.000000' })).toMatch(/credit limit/)
    expect(walletUsdcMessage({ available: '1.000000', reserved: '0.000000', walletUsdc: '5.000000', creditLimit: null })).toMatch(/automatically/)
  })
})

describe('cooperativeCloseError', () => {
  it('turns daemon errors into a next step', () => {
    expect(cooperativeCloseError('A channel close request is already in flight for 2060d7466034...')).toMatch(/Close on chain instead/)
    expect(cooperativeCloseError('Seller x did not answer the channel close request within 60000ms.')).toMatch(/does not need the seller/)
    expect(cooperativeCloseError('Something odd')).toMatch(/^Something odd .*close on chain/)
  })
})
