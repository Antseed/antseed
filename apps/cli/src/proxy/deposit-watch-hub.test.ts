import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadOrCreateIdentity, type Identity } from '@antseed/node'
import { BuyerChainReads } from './buyer-chain-reader.js'
import { ChainRpcProvider } from './chain-rpc.js'
import { startFakeChainRpc } from './chain-rpc-test-support.js'
import { DepositWatchHub } from './deposit-watch-hub.js'
import {
  DEPOSIT_WATCH_ACTIVE_INTERVAL_MS,
  DEPOSIT_WATCH_BACKGROUND_INTERVAL_MS,
  DEPOSIT_WATCH_IDLE_INTERVAL_MS,
  DepositWatcher,
  type DepositWatcherDepositsReader,
  type DepositWatcherRelayReader,
} from './deposit-watcher.js'

const RELAY = '0x' + '11'.repeat(20)
const USDC = '0x' + 'a1'.repeat(20)
const DEPOSITS = '0x' + 'd1'.repeat(20)
const wallets = Array.from({ length: 10 }, (_, index) => '0x' + String(index + 30).repeat(20))

const relay: DepositWatcherRelayReader = {
  fee: async () => 50_000n,
  verifyUsdcDomain: async () => true,
  getSweepConfirmation: async () => null,
  isAuthorizationUsed: async () => false,
}

async function identity(t: test.TestContext): Promise<Identity> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-watch-hub-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return loadOrCreateIdentity(dir)
}

function watcher(id: Identity, address: string, hub: DepositWatchHub, deposits: DepositWatcherDepositsReader, idleIntervalMs?: number | null): DepositWatcher {
  return new DepositWatcher({
    wallet: id.wallet,
    address,
    depositsClient: deposits,
    relayClient: relay,
    usdcAddress: USDC,
    evmChainId: 8453,
    depositRelayAddress: RELAY,
    dispatch: async () => ({ offered: 0, accepted: false }),
    connectRelayers: async () => {},
    getReceipt: async () => null,
    scheduler: hub,
    ...(idleIntervalMs !== undefined ? { idleIntervalMs } : {}),
  })
}

test('ten watched wallets cost one RPC request per tick', async (t) => {
  const rpc = await startFakeChainRpc()
  t.after(() => rpc.close())
  const provider = new ChainRpcProvider([rpc.url], 8453)
  t.after(() => provider.destroy())
  const reads = new BuyerChainReads({ provider, depositsAddress: DEPOSITS, usdcAddress: USDC })
  const hub = new DepositWatchHub({ readBalances: (addresses) => reads.getUSDCBalances(addresses), debounceMs: 20 })
  t.after(() => hub.stop())
  const id = await identity(t)
  const watchers = wallets.map((address) => watcher(id, address, hub, reads))
  for (const entry of watchers) entry.startIdle() // the startup burst
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(hub.ticks, 1)
  assert.deepEqual(rpc.byMethod, { eth_getCode: 1, eth_call: 1 }, 'one Multicall3 probe, then one call for all ten wallets')
  assert.equal(rpc.batchedCalls, 10)

  rpc.reset()
  await hub.tick() // nothing due yet
  assert.equal(rpc.requests, 0)
  for (const entry of watchers) entry.stop()
  assert.equal(hub.size, 0)
})

test('cadence: idle wallets poll together once a minute, a watched wallet every few seconds, no polling without auto-sweep', async (t) => {
  const id = await identity(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const batches: string[][] = []
  const hub = new DepositWatchHub({ readBalances: async (addresses) => { batches.push(addresses); return new Map(addresses.map((address) => [address, 0n])) } })
  t.after(() => hub.stop())
  const deposits: DepositWatcherDepositsReader = { getUSDCBalance: async () => 0n, getBuyerBalance: async () => ({ available: 0n, reserved: 0n }), getBuyerCreditLimit: async () => 0n }
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
  const advance = async (ms: number, step = 1_000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed))
      await flush()
    }
  }

  const idle = wallets.slice(0, 8).map((address) => watcher(id, address, hub, deposits))
  // Auto-sweep off: the daemon never calls startIdle, and after a deposit flow it rests.
  const manual = wallets.slice(8).map((address) => watcher(id, address, hub, deposits, null))
  for (const entry of idle) entry.startIdle()
  await advance(1_000)
  assert.equal(batches.length, 1)
  assert.equal(batches[0]!.length, 8)

  await advance(10 * 60_000)
  assert.equal(batches.length, 1 + 10 * 60_000 / DEPOSIT_WATCH_IDLE_INTERVAL_MS, 'one batch per idle interval for all wallets')
  assert.ok(batches.every((batch) => batch.length === 8))

  batches.length = 0
  manual[0]!.promote()
  await advance(60_000)
  const activeBatches = batches.length
  assert.equal(DEPOSIT_WATCH_ACTIVE_INTERVAL_MS, 6_000, 'active deposit watch polls the chain every 6 s')
  assert.ok(activeBatches >= 60_000 / DEPOSIT_WATCH_ACTIVE_INTERVAL_MS - 1 && activeBatches <= 60_000 / DEPOSIT_WATCH_ACTIVE_INTERVAL_MS + 1, `active polls: ${activeBatches}`)
  assert.ok(batches.every((batch) => batch.includes(wallets[8]!.toLowerCase())))
  assert.ok(!batches.flat().includes(wallets[9]!.toLowerCase()), 'the other auto-sweep-off wallet is never polled')

  manual[0]!.demote()
  batches.length = 0
  await advance(10 * 60_000, 5_000)
  const backgroundPolls = batches.filter((batch) => batch.includes(wallets[8]!.toLowerCase())).length
  assert.ok(backgroundPolls <= 10 * 60_000 / DEPOSIT_WATCH_BACKGROUND_INTERVAL_MS + 1, `background polls: ${backgroundPolls}`)
  assert.ok(batches.length <= 10 * 60_000 / DEPOSIT_WATCH_BACKGROUND_INTERVAL_MS + 1, 'background polls ride with the idle batch')

  // Past the 30 min linger with an empty wallet it rests: no more polls for it.
  await advance(25 * 60_000, 30_000)
  batches.length = 0
  await advance(5 * 60_000, 30_000)
  assert.equal(manual[0]!.mode, 'off')
  assert.ok(!batches.flat().includes(wallets[8]!.toLowerCase()))
  for (const entry of [...idle, ...manual]) entry.stop()
})

test('a failed read backs the loop off instead of retrying every tick', async (t) => {
  const id = await identity(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  let reads = 0
  const hub = new DepositWatchHub({ readBalances: async () => { reads++; throw new Error('rate limited') }, errorBackoffMs: 15_000 })
  t.after(() => hub.stop())
  const deposits: DepositWatcherDepositsReader = { getUSDCBalance: async () => 0n, getBuyerBalance: async () => ({ available: 0n, reserved: 0n }), getBuyerCreditLimit: async () => 0n }
  const active = watcher(id, wallets[0]!, hub, deposits)
  active.promote()
  for (let i = 0; i < 60; i++) {
    t.mock.timers.tick(1_000)
    for (let j = 0; j < 5; j++) await new Promise((resolve) => setImmediate(resolve))
  }
  // Without back-off an active wallet would read 15 times a minute; with it: t=0, ~15 s, ~45 s.
  assert.ok(reads <= 4, `reads: ${reads}`)
  active.stop()
})
