import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { Wallet } from 'ethers'
import { GatewayStore, DEFAULT_WORKSPACE_ID } from '../store.js'
import { BUYER_NOT_RUNNING, resolveIdentityAddress, syncWalletCache } from './wallet-address.js'
import { resolveWorkspaceWallet, withWallet } from './workspaces.js'

// The variable must not leak in from the shell running the tests.
delete process.env['ANTSEED_IDENTITY_HEX']

// Obvious fakes: fixed test keys.
const DISK_KEY = '33'.repeat(32)
const DISK_WALLET = new Wallet(`0x${DISK_KEY}`).address
const BUYER_WALLET = new Wallet(`0x${'44'.repeat(32)}`).address
const OTHER_WALLET = new Wallet(`0x${'55'.repeat(32)}`).address

let dataDir: string
let store: GatewayStore
let warnings: string[]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-wallet-address-'))
  store = new GatewayStore(dataDir)
  warnings = []
})

afterEach(() => {
  store.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const ctx = (book: Map<string, string> | null) => ({
  store,
  dataDir,
  buyerAddresses: async () => book,
  warn: (message: string) => { warnings.push(message) },
})

test('the running buyer wins over the key on disk and corrects a stale cache, warning once', async () => {
  writeFileSync(join(dataDir, 'identity.key'), DISK_KEY)
  store.setWalletAddress('default', DISK_WALLET)
  const live = new Map([['default', BUYER_WALLET]])

  const resolved = await resolveIdentityAddress(dataDir, async () => live, 'default')
  assert.deepEqual(resolved, { address: BUYER_WALLET, source: 'live' })

  const first = await withWallet(ctx(live), store.defaultWorkspace())
  assert.equal(first.walletAddress, BUYER_WALLET)
  assert.equal(store.defaultWorkspace().walletAddress, BUYER_WALLET)
  assert.deepEqual(warnings, [`workspace Default (${DEFAULT_WORKSPACE_ID}) wallet changed from ${DISK_WALLET} to ${BUYER_WALLET}`])

  // The same change is not warned about again.
  store.setWalletAddress('default', DISK_WALLET)
  await withWallet(ctx(live), store.defaultWorkspace())
  assert.equal(warnings.length, 1)
})

test('buyer down: the key on disk is used, but only fills an empty cache', async () => {
  writeFileSync(join(dataDir, 'identity.key'), DISK_KEY)
  const resolved = await resolveWorkspaceWallet(ctx(null), store.defaultWorkspace())
  assert.deepEqual(resolved, { address: DISK_WALLET, source: 'disk' })
  assert.equal(store.defaultWorkspace().walletAddress, DISK_WALLET)

  // A value the buyer reported earlier is not overwritten by a guess from disk.
  store.setWalletAddress('default', OTHER_WALLET)
  const again = await withWallet(ctx(null), store.defaultWorkspace())
  assert.equal(again.walletAddress, DISK_WALLET)
  assert.equal(store.defaultWorkspace().walletAddress, OTHER_WALLET)
  assert.deepEqual(warnings, [])
})

test('desktop-style data dir without ANTSEED_IDENTITY_HEX and no buyer: unknown, nothing cached', async () => {
  // identity.enc next to a stale identity.key: the buyer runs with the desktop's key, which this process cannot see.
  writeFileSync(join(dataDir, 'identity.key'), DISK_KEY)
  writeFileSync(join(dataDir, 'identity.enc'), 'encrypted')
  const shown = await withWallet(ctx(null), store.defaultWorkspace())
  assert.equal(shown.walletAddress, null)
  assert.equal(shown.walletNote, BUYER_NOT_RUNNING)
  assert.equal(store.defaultWorkspace().walletAddress, null)

  // With the buyer up, its answer is taken.
  const live = await withWallet(ctx(new Map([['default', BUYER_WALLET]])), store.defaultWorkspace())
  assert.equal(live.walletAddress, BUYER_WALLET)
  assert.equal(store.defaultWorkspace().walletAddress, BUYER_WALLET)
})

test('a buyer that is up but does not list the identity falls back to its key here', async () => {
  const resolved = await resolveIdentityAddress(dataDir, async () => new Map(), 'ws-missing')
  assert.equal(resolved.address, null)
  assert.equal(resolved.source, 'unknown')
})

test('syncWalletCache ignores unknown results', () => {
  syncWalletCache(store, store.defaultWorkspace(), { address: null, source: 'unknown' }, (message) => warnings.push(message))
  assert.equal(store.defaultWorkspace().walletAddress, null)
})
