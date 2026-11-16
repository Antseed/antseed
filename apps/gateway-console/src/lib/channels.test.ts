import { describe, expect, it } from 'vitest'
import type { Channel } from '../api/types'
import {
  CHANNEL_CLOSE_GRACE_MS, authorizedNotCharged, channelAction, channelStatusLabel, cooperativeCloseError, formatCountdown, formatHeld, formatReturns, isEntireBalanceLocked, pendingSpend,
  returnsOnClose, unaccountedReserveNote, unspent, walletUsdcMessage, withdrawableSummary,
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
  it('shows the buyer\'s own pending figure, the one the desktop balance uses, over its own sum (#1463)', () => {
    const listed = [channel({ spent: '0.500000', settled: '0.200000' })]
    expect(authorizedNotCharged({ pending: '0.400000' }, listed)).toBeCloseTo(0.4)
    // An older gateway sends no figure: the listed channels are summed.
    expect(authorizedNotCharged({}, listed)).toBeCloseTo(0.3)
    expect(authorizedNotCharged({}, undefined)).toBeNull()
  })
  it('takes what the seller can still settle from the gateway, as the desktop balance does (#1463)', () => {
    // Signed past the deposit, and no top-up can land: the gateway caps it at 0.75; spent − settled would say 1.75.
    expect(pendingSpend([channel({ reserved: '1.000000', spent: '2.000000', settled: '0.250000', held: '0.750000', unsettled: '0.750000' })])).toBeCloseTo(0.75)
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

describe('what a channel holds and returns (#1463)', () => {
  it('says a channel signed in full holds its reserve unsettled, and returns up to it, not about $0', () => {
    // The seller answered channel_exhausted: 1.00 signed, 0.25 settled, 0.75 still held on chain.
    const exhausted = channel({ reserved: '1.000000', spent: '1.000000', settled: '0.250000', held: '0.750000', unsettled: '0.750000', canCooperativeClose: false })
    expect(formatHeld(exhausted)).toBe('$0.75 unsettled')
    expect(returnsOnClose(exhausted)).toEqual({ min: 0, max: 0.75 })
    expect(formatReturns(exhausted)).toBe('up to $0.75')
    expect(unspent(exhausted)).toBe(0)
  })
  it('gives the range a withdraw returns: all of what is held if the seller settles nothing more', () => {
    const partly = channel({ reserved: '1.000000', spent: '0.300000', settled: '0.000000', held: '1.000000', unsettled: '0.300000' })
    expect(formatHeld(partly)).toBe('$1.00')
    expect(formatReturns(partly)).toBe('$0.70–$1.00')
    expect(unspent(partly)).toBeCloseTo(0.7)
    const settledUp = channel({ held: '0.880000', unsettled: '0.000000' })
    expect(formatReturns(settledUp)).toBe('$0.88')
  })
  it('the withdraw notice offers what the chain holds for a channel signed in full, not $0', () => {
    const exhausted = channel({ status: 'withdrawable', reserved: '1.000000', spent: '1.000000', settled: '0.250000', held: '0.750000', unsettled: '0.750000', canCooperativeClose: false })
    expect(withdrawableSummary([exhausted])).toEqual({ count: 1, amount: 0.75 })
  })
  it('falls back to reserved minus spent before the chain is read, or from an older gateway', () => {
    expect(formatHeld(channel({ held: null }))).toBe('—')
    expect(formatReturns(channel({}))).toBe('$1.50')
  })
})

describe('unaccountedReserveNote', () => {
  it('names reserve no listed channel explains, with the next step for whoever can sign it', () => {
    // The gateway's wallet is its own authorized wallet: the CLI on the gateway host can sign the close.
    expect(unaccountedReserveNote({ unaccounted: '4.690000' }, { gatewaySigns: true })).toBe("$4.69 of the reserve is held by a channel this workspace's buyer has no record of. With its channel id (a block explorer lists it), run on the gateway host: antseed buyer channels request-close <channelId>, then withdraw 15 minutes later.")
    // Another wallet is authorized (or none is known yet): only it can close the channel.
    expect(unaccountedReserveNote({ unaccounted: '4.690000' })).toBe("$4.69 of the reserve is held by a channel this workspace's buyer has no record of. With its channel id (a block explorer lists it), the authorized wallet closes it on chain: requestClose on the payment channels contract, then withdraw 15 minutes later.")
  })
  it('says nothing when everything is explained, or nothing was judged', () => {
    expect(unaccountedReserveNote({ unaccounted: '0.000000' })).toBeNull()
    expect(unaccountedReserveNote({ unaccounted: null })).toBeNull()
    expect(unaccountedReserveNote(undefined)).toBeNull()
  })
})

describe('cooperativeCloseError', () => {
  it('turns daemon errors into a next step', () => {
    expect(cooperativeCloseError('A channel close request is already in flight for 2060d7466034...')).toMatch(/Close on chain instead/)
    expect(cooperativeCloseError('Seller x did not answer the channel close request within 60000ms.')).toMatch(/does not need the seller/)
    expect(cooperativeCloseError('Something odd')).toMatch(/^Something odd .*close on chain/)
  })
})
