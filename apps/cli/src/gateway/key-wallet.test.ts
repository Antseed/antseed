import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createKeyWalletReader, pendingSpend } from './key-wallet.js'

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

test('a failed channel read keeps the last pending spend, marked stale, instead of zero', async () => {
  let channelsUp = true
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/_antseed/balances') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ address: '0x00000000000000000000000000000000000000aa', available: '5.000000', reserved: '1.000000', walletUsdc: '0.000000' }))
    } else if (path === '/_antseed/channels' && channelsUp) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ channels: [channel({ cumulativeSigned: '400000' })] }))
    } else {
      res.writeHead(503).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const reader = createKeyWalletReader({
    buyerPort: (server.address() as AddressInfo).port,
    secret: 's',
    configPath: '/nonexistent',
    fetchRetailPrices: async () => null,
    readStates: async () => new Map(),
  })
  try {
    const first = await reader.balance('team-a')
    assert.equal(first?.pending, '0.400000')
    assert.equal(first?.stale, false)
    channelsUp = false
    const second = await reader.balance('team-a')
    assert.equal(second?.pending, '0.400000', 'the last known pending, not zero')
    assert.equal(second?.stale, true)
    assert.equal(await reader.balance('team-b'), null, 'never read for this wallet: unknown')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
