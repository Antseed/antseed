import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadOrCreateIdentity } from '@antseed/node'
import type { SweepRequestPayload } from '@antseed/node'
import {
  DEPOSIT_WATCH_ACTIVE_TTL_MS,
  DepositWatcher,
  type DepositWatchEvent,
  type DepositWatcherDeps,
  type DepositWatcherDepositsReader,
  type DepositWatcherRelayReader,
} from './deposit-watcher.js'

const RELAY_ADDRESS = '0x' + '11'.repeat(20)
const USDC_ADDRESS = '0x' + '22'.repeat(20)
const FEE = 50_000n // $0.05

interface FakeChain {
  walletBalance: bigint
  depositsAvailable: bigint
  depositsReserved: bigint
  creditLimit: bigint
  authorizationUsed: boolean
}

function makeDepositsReader(chain: FakeChain): DepositWatcherDepositsReader {
  return {
    getUSDCBalance: async () => chain.walletBalance,
    getBuyerBalance: async () => ({ available: chain.depositsAvailable, reserved: chain.depositsReserved }),
    getBuyerCreditLimit: async () => chain.creditLimit,
  }
}

function makeRelayReader(chain: FakeChain): DepositWatcherRelayReader {
  return {
    fee: async () => FEE,
    verifyUsdcDomain: async () => true,
    getSweepConfirmation: async () => null,
    isAuthorizationUsed: async () => chain.authorizationUsed,
  }
}

async function makeWatcher(
  chain: FakeChain,
  overrides: Partial<DepositWatcherDeps> = {},
): Promise<{ watcher: DepositWatcher; events: DepositWatchEvent[]; dispatched: SweepRequestPayload[]; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-deposit-watcher-'))
  const identity = await loadOrCreateIdentity(dir)
  const events: DepositWatchEvent[] = []
  const dispatched: SweepRequestPayload[] = []
  const watcher = new DepositWatcher({
    wallet: identity.wallet,
    address: identity.wallet.address,
    depositsClient: makeDepositsReader(chain),
    relayClient: makeRelayReader(chain),
    usdcAddress: USDC_ADDRESS,
    evmChainId: 8453,
    depositRelayAddress: RELAY_ADDRESS,
    dispatch: async (payload) => {
      dispatched.push(payload)
      // The relayer submits on-chain: the wallet drains and the deposit lands.
      chain.authorizationUsed = true
      chain.walletBalance = 0n
      return { offered: 1, accepted: true }
    },
    connectRelayers: async () => {},
    getReceipt: async () => null,
    onEvent: (event) => events.push(event),
    idleIntervalMs: null,
    ...overrides,
  })
  return { watcher, events, dispatched, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('deposit watcher sweeps incoming USDC and reports received → sweeping → credited', async (t) => {
  const chain: FakeChain = {
    walletBalance: 5_000_000n, // 5 USDC waiting in the hot wallet
    depositsAvailable: 0n,
    depositsReserved: 0n,
    creditLimit: 100_000_000n,
    authorizationUsed: false,
  }
  const { watcher, events, dispatched, cleanup } = await makeWatcher(chain)
  t.after(async () => { watcher.stop(); await cleanup() })

  watcher.promote()
  await waitFor(() => events.some((e) => e.phase === 'credited'))

  assert.deepEqual(events.map((e) => e.phase), ['received', 'sweeping', 'credited'])
  assert.equal(dispatched.length, 1)
  const payload = dispatched[0]!
  assert.equal(payload.amount, '5000000')
  assert.equal(payload.relayAddress, RELAY_ADDRESS)
  assert.equal(payload.evmChainId, 8453)
  assert.match(payload.sig3009, /^0x[0-9a-fA-F]+$/)
  // Credited amount is net of the fixed relay fee.
  const credited = events.find((e) => e.phase === 'credited')!
  assert.equal(credited.amountBaseUnits, (5_000_000n - FEE).toString())
  // Sequence numbers are monotonic so pollers can dedupe.
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3])
})

test('deposit watcher clamps the sweep to credit-limit headroom', async (t) => {
  const chain: FakeChain = {
    walletBalance: 10_000_000n, // 10 USDC in the wallet…
    depositsAvailable: 6_000_000n,
    depositsReserved: 0n,
    creditLimit: 8_000_000n, // …but only 2 USDC of headroom left
    authorizationUsed: false,
  }
  const { watcher, events, dispatched, cleanup } = await makeWatcher(chain)
  t.after(async () => { watcher.stop(); await cleanup() })

  watcher.promote()
  await waitFor(() => events.some((e) => e.phase === 'credited'))

  assert.equal(dispatched.length, 1)
  // headroom (2 USDC) + fee, leaving the rest in the wallet for later.
  assert.equal(dispatched[0]!.amount, (2_000_000n + FEE).toString())
})

test('deposit watcher defers when the deposits balance is at its credit limit', async (t) => {
  const chain: FakeChain = {
    walletBalance: 5_000_000n,
    depositsAvailable: 8_000_000n,
    depositsReserved: 0n,
    creditLimit: 8_000_000n,
    authorizationUsed: false,
  }
  const { watcher, events, dispatched, cleanup } = await makeWatcher(chain)
  t.after(async () => { watcher.stop(); await cleanup() })

  watcher.promote()
  await waitFor(() => events.some((e) => e.phase === 'deferred'))

  assert.equal(dispatched.length, 0)
  assert.deepEqual(events.map((e) => e.phase), ['received', 'deferred'])
})

test('deposit watcher waits below the 1 USDC first-deposit floor', async (t) => {
  const chain: FakeChain = {
    walletBalance: 500_000n, // $0.50 — below the first-deposit minimum + fee
    depositsAvailable: 0n,
    depositsReserved: 0n,
    creditLimit: 100_000_000n,
    authorizationUsed: false,
  }
  const { watcher, events, dispatched, cleanup } = await makeWatcher(chain)
  t.after(async () => { watcher.stop(); await cleanup() })

  watcher.promote()
  await waitFor(() => events.some((e) => e.phase === 'received'))
  // Give the sweep attempt a moment to (not) dispatch.
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(dispatched.length, 0)
  assert.deepEqual(events.map((e) => e.phase), ['received'])
})

test('deposit watcher fails fast when no relayer accepts, and reports the error', async (t) => {
  const chain: FakeChain = {
    walletBalance: 5_000_000n,
    depositsAvailable: 0n,
    depositsReserved: 0n,
    creditLimit: 100_000_000n,
    authorizationUsed: false,
  }
  const { watcher, events, cleanup } = await makeWatcher(chain, {
    dispatch: async () => ({ offered: 2, accepted: false }),
  })
  t.after(async () => { watcher.stop(); await cleanup() })

  watcher.promote()
  await waitFor(() => events.some((e) => e.phase === 'error'))

  const error = events.find((e) => e.phase === 'error')!
  assert.match(error.error ?? '', /No deposit relayer accepted/)
})

test('deposit watcher status exposes mode transitions and the last event', async (t) => {
  const chain: FakeChain = {
    walletBalance: 0n,
    depositsAvailable: 0n,
    depositsReserved: 0n,
    creditLimit: 100_000_000n,
    authorizationUsed: false,
  }
  const { watcher, cleanup } = await makeWatcher(chain)
  t.after(async () => { watcher.stop(); await cleanup() })

  assert.equal(watcher.status().mode, 'off')
  watcher.promote()
  assert.equal(watcher.status().mode, 'active')
  watcher.demote()
  assert.equal(watcher.status().mode, 'background')
  watcher.startIdle()
  assert.equal(watcher.status().mode, 'idle')
  watcher.stop()
  assert.equal(watcher.status().mode, 'off')
  assert.equal(watcher.status().address.length, 42)
})

test('active mode lapses to background without a heartbeat, and a heartbeat keeps it active', async (t) => {
  const chain: FakeChain = {
    walletBalance: 0n,
    depositsAvailable: 0n,
    depositsReserved: 0n,
    creditLimit: 100_000_000n,
    authorizationUsed: false,
  }
  // The identity is created before the clock is faked (key derivation is async I/O).
  const { watcher, cleanup } = await makeWatcher(chain)
  t.after(async () => { watcher.stop(); await cleanup() })
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })

  watcher.promote()
  t.mock.timers.tick(DEPOSIT_WATCH_ACTIVE_TTL_MS - 1)
  assert.equal(watcher.status().mode, 'active')
  // A console heartbeat every ~60 s re-arms the window.
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(60_000)
    watcher.promote()
  }
  t.mock.timers.tick(DEPOSIT_WATCH_ACTIVE_TTL_MS - 1)
  assert.equal(watcher.status().mode, 'active')
  t.mock.timers.tick(1)
  assert.equal(watcher.status().mode, 'background')

  // An explicit demote cancels the pending lapse; promote(null) never lapses.
  watcher.promote(null)
  t.mock.timers.tick(DEPOSIT_WATCH_ACTIVE_TTL_MS * 3)
  assert.equal(watcher.status().mode, 'active')
})
