import assert from 'node:assert/strict'
import test from 'node:test'
import { ACCOUNT_SETTINGS_TTL_MS, BALANCE_TTL_MS, CachedBuyerChainReader, constantRelayReads } from './buyer-chain-reader.js'
import { ChainReadCache } from './chain-read-cache.js'
import { ChainRpcProvider } from './chain-rpc.js'
import { startFakeChainRpc } from './chain-rpc-test-support.js'
import type { DepositWatcherRelayReader } from './deposit-watcher.js'

const DEPOSITS = '0x' + 'd1'.repeat(20)
const USDC = '0x' + 'a1'.repeat(20)
const BUYER = '0x' + '11'.repeat(20)

async function setup(t: test.TestContext) {
  const rpc = await startFakeChainRpc()
  t.after(() => rpc.close())
  let now = 1_000_000
  const provider = new ChainRpcProvider([rpc.url], 8453)
  t.after(() => provider.destroy())
  const reader = new CachedBuyerChainReader({ provider, depositsAddress: DEPOSITS, usdcAddress: USDC, cache: new ChainReadCache({ now: () => now }) })
  return { rpc, reader, advance: (ms: number) => { now += ms } }
}

const all = (reader: CachedBuyerChainReader) => Promise.all([
  reader.getBuyerBalance(BUYER), reader.getUSDCBalance(BUYER), reader.getBuyerCreditLimit(BUYER), reader.getOperator(BUYER),
])

test('the four balance reads of a wallet leave as one eth_call, then come from the cache', async (t) => {
  const { rpc, reader, advance } = await setup(t)
  rpc.usdc.set(BUYER, 3_000_000n)
  rpc.deposits.set(BUYER, { available: 1_500_000n, reserved: 250_000n })
  const [balance, usdc, limit, operator] = await all(reader)
  assert.deepEqual(balance, { available: 1_500_000n, reserved: 250_000n })
  assert.equal(usdc, 3_000_000n)
  assert.equal(limit, 100_000_000n)
  assert.equal(operator, '0x' + '0'.repeat(40))
  assert.equal(rpc.byMethod['eth_call'], 1)
  assert.equal(rpc.batchedCalls, 4)

  rpc.reset()
  advance(BALANCE_TTL_MS - 1)
  await all(reader)
  assert.equal(rpc.requests, 0, 'everything cached')

  advance(1)
  await all(reader)
  assert.equal(rpc.byMethod['eth_call'], 1)
  assert.equal(rpc.batchedCalls, 2, 'operator and credit limit stay cached for 5 minutes')

  rpc.reset()
  advance(ACCOUNT_SETTINGS_TTL_MS)
  await all(reader)
  assert.equal(rpc.batchedCalls, 4)
})

test('USDC balances of many wallets are one request, and are shared with balance reads', async (t) => {
  const { rpc, reader } = await setup(t)
  const wallets = Array.from({ length: 10 }, (_, index) => '0x' + String(index + 20).repeat(20))
  wallets.forEach((wallet, index) => rpc.usdc.set(wallet, BigInt(index)))
  const balances = await reader.reads.getUSDCBalances(wallets)
  assert.equal(balances.size, 10)
  assert.equal(balances.get(wallets[3]!), 3n)
  assert.equal(rpc.byMethod['eth_call'], 1)
  reader.noteUsdcBalances(balances)
  rpc.reset()
  assert.equal(await reader.getUSDCBalance(wallets[3]!), 3n)
  assert.equal(rpc.requests, 0)
})

test('a failed refresh serves the last balances and flags the wallet stale', async (t) => {
  const { rpc, reader, advance } = await setup(t)
  rpc.deposits.set(BUYER, { available: 7n, reserved: 0n })
  await all(reader)
  assert.equal(reader.isStale(BUYER), false)
  rpc.rateLimit(Number.POSITIVE_INFINITY)
  advance(BALANCE_TTL_MS)
  const [balance] = await all(reader)
  assert.deepEqual(balance, { available: 7n, reserved: 0n })
  assert.equal(reader.isStale(BUYER), true)
})

test('relay constants (fee, USDC domain) are read once', async () => {
  let fees = 0
  let domains = 0
  const relay: DepositWatcherRelayReader = {
    fee: async () => { fees++; return 50_000n },
    verifyUsdcDomain: async () => { domains++; return true },
    getSweepConfirmation: async () => null,
    isAuthorizationUsed: async () => false,
  }
  const cached = constantRelayReads(relay)
  const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC }
  await Promise.all([cached.fee(), cached.fee(), cached.verifyUsdcDomain(USDC, domain), cached.verifyUsdcDomain(USDC, domain)])
  assert.equal(await cached.fee(), 50_000n)
  assert.equal(fees, 1)
  assert.equal(domains, 1)
  assert.equal(await cached.isAuthorizationUsed(USDC, BUYER, '0x00'), false)
})

test('the watchers reuse a balance read a moment ago and batch the rest', async (t) => {
  const { rpc, reader } = await setup(t)
  const other = '0x' + '22'.repeat(20)
  rpc.usdc.set(BUYER, 5n)
  rpc.usdc.set(other, 6n)
  await reader.getUSDCBalance(BUYER)
  rpc.reset()
  const balances = await reader.usdcBalancesForWatch([BUYER, other], 2_000)
  assert.deepEqual([...balances.entries()], [[BUYER, 5n], [other, 6n]])
  assert.equal(rpc.byMethod['eth_call'], 1)
  assert.equal(rpc.batchedCalls, 0, 'only the stale wallet is read (a single call needs no batch)')
  rpc.reset()
  await reader.usdcBalancesForWatch([BUYER, other], 2_000)
  assert.equal(rpc.requests, 0)
})
