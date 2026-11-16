import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createKeyWalletReader } from './key-wallet.js'

const NOW = 1_800_000_000
const channel = (overrides: Record<string, unknown>) => ({ channelId: 'c1', status: 'active', cumulativeSigned: '500000', settledAmount: null, ...overrides })
const BALANCES = { address: '0x00000000000000000000000000000000000000aa', available: '5.000000', reserved: '1.000000', walletUsdc: '0.000000' }

/** A buyer daemon as the gateway sees it, recording each path it is asked for. */
async function withBuyer(
  answer: (path: string) => unknown | null,
  run: (reader: ReturnType<typeof createKeyWalletReader>, paths: string[]) => Promise<void>,
): Promise<void> {
  const paths: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    paths.push(url.pathname)
    const body = answer(url.pathname)
    if (body === null) {
      res.writeHead(503).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const reader = createKeyWalletReader({
    buyerPort: (server.address() as AddressInfo).port,
    secret: 's',
    configPath: '/nonexistent',
    fetchRetailPrices: async () => null,
    now: () => NOW * 1000,
  })
  try {
    await run(reader, paths)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('the key balance reports the pending spend the buyer works out from its stored chain records, and reads no channel history (#1463)', async () => {
  const history = { channels: Array.from({ length: 500 }, (_, index) => channel({ channelId: `c${index}`, status: 'ghost', cumulativeSigned: '1000000' })) }
  await withBuyer(
    (path) => (path === '/_antseed/balances'
      ? { ...BALANCES, channels: { pending: '0.400000', held: '1.000000', unaccountedReserved: '0.000000', stale: false } }
      : history),
    async (reader, paths) => {
      const balance = await reader.balance('team-a')
      assert.equal(balance?.pending, '0.400000')
      assert.equal(balance?.stale, false)
      assert.deepEqual(paths, ['/_antseed/balances'])
    },
  )
})

test('the key balance is stale when the buyer says no current chain read confirms its figures', async () => {
  await withBuyer(
    () => ({ ...BALANCES, channels: { pending: '0.100000', held: '0.000000', unaccountedReserved: null, stale: true } }),
    async (reader) => {
      const balance = await reader.balance('team-a')
      assert.deepEqual([balance?.pending, balance?.stale], ['0.100000', true])
    },
  )
})

test('for a buyer that predates reporting pending spend, the rows its store calls open count', async () => {
  let channelsUp = true
  await withBuyer(
    (path) => (path === '/_antseed/balances' ? BALANCES : channelsUp ? { channels: [
      channel({ cumulativeSigned: '400000' }),
      channel({ channelId: 'c2', cumulativeSigned: '300000', settledAmount: '300000' }),
      channel({ channelId: 'c3', status: 'ghost' }),
    ] } : null),
    async (reader, paths) => {
      const first = await reader.balance('team-a')
      assert.deepEqual([first?.pending, first?.stale], ['0.400000', false])
      assert.deepEqual(paths, ['/_antseed/balances', '/_antseed/channels'])
      // Its channel list fails: the last known pending, not zero, marked stale.
      channelsUp = false
      const second = await reader.balance('team-a')
      assert.deepEqual([second?.pending, second?.stale], ['0.400000', true])
      assert.equal(await reader.balance('team-b'), null, 'never read for this wallet: unknown')
    },
  )
})
