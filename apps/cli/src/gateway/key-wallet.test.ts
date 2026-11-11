import assert from 'node:assert/strict'
import test from 'node:test'
import { pendingSpend } from './key-wallet.js'

const channel = (overrides: Record<string, unknown>) => ({ channelId: 'c1', status: 'active', cumulativeSigned: '500000', settledAmount: null, ...overrides })

test('pending spend is what open channels hold signed but unsettled, the chain settlement winning', () => {
  const body = { channels: [channel({}), channel({ channelId: 'c2', cumulativeSigned: '300000' }), channel({ channelId: 'c3', status: 'settled' })] }
  const states = new Map([['c2', { status: 1, deposit: 1_000_000n, settled: 200_000n, closeRequestedAt: 0n }]])
  // c1: nothing read from the chain, so all of it counts; c2: 300000 - 200000; c3: not open.
  assert.equal(pendingSpend(body, states), 600_000n)
})

test('a channel the chain has closed holds nothing pending', () => {
  const states = new Map([['c1', { status: 2, deposit: 0n, settled: 500_000n, closeRequestedAt: 0n }]])
  assert.equal(pendingSpend({ channels: [channel({})] }, states), 0n)
  assert.equal(pendingSpend({}, new Map()), 0n)
})
