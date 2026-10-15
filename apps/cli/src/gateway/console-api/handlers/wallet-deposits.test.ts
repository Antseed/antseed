import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AntsChainConfig } from '@antseed/ants'
import { GatewayStore } from '../../store.js'
import { ConsoleRouter } from '../router.js'
import type { DepositConfirmation } from '../types.js'
import { call, fakeDeps, fakeRequireWorkspaceAccess, memberPrincipal, rejectsWith, startFakeBuyer, type FakeBuyer } from './network-test-helpers.js'
import { registerWalletRoutes } from './wallet.js'

// Obvious fakes: fixed test addresses and hashes, never real ones.
const WALLET = `0x${'11'.repeat(20)}`
const PAYER = `0x${'22'.repeat(20)}`
const RECORDED = `0x${'a1'.repeat(32)}`
const PAST = `0x${'b2'.repeat(32)}`
const NOT_OURS = `0x${'c3'.repeat(32)}`
const CHAIN = { chainId: 'base-sepolia', evmChainId: 84532, rpcUrl: 'http://127.0.0.1:1' } as AntsChainConfig

let dir: string
let store: GatewayStore
let buyer: FakeBuyer
let workspaceId: string
let ownerId: string

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'antseed-deposits-'))
  store = new GatewayStore(dir, () => 1_700_000_000_000)
  ownerId = store.createOwner({ label: 'Dana', email: 'dana@example.com' }).id
  workspaceId = store.defaultWorkspace().id
  buyer = await startFakeBuyer({
    'GET /_antseed/deposits/history': () => ({ body: { ok: true, address: WALLET, deposits: [{ txHash: RECORDED, creditedBaseUnits: '1000000', at: 1 }] } }),
  })
})

after(async () => {
  await buyer.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const verified: string[] = []
function setup(): ConsoleRouter {
  const router = new ConsoleRouter()
  registerWalletRoutes(router, fakeDeps(store), {
    buyer: buyer.client,
    requireWorkspaceAccess: fakeRequireWorkspaceAccess,
    walletAddress: async () => WALLET,
    resolveChain: async () => CHAIN,
    verifyDeposit: async (_chain, txHash, wallet) => {
      verified.push(txHash)
      if (txHash === NOT_OURS || wallet !== WALLET) return null
      return {
        txHash, wallet, kind: txHash === PAST ? 'direct' : 'relay',
        creditedUsdc: 1_000_000, feeUsdc: txHash === PAST ? 0 : 50_000, blockNumber: 10, blockTime: 1_699_000_000_000,
        sources: [{ from: txHash === PAST ? PAYER : '0x0000000000000000000000000000000000000000', amountUsdc: 1_050_000, txHash: `0x${'d4'.repeat(32)}` }],
      }
    },
  })
  return router
}

const admin = () => memberPrincipal(ownerId, { [workspaceId]: 'admin' }, 'owner')
const plainMember = () => memberPrincipal(ownerId, { [workspaceId]: 'member' })

test('listing verifies the deposits the buyer recorded, once', async () => {
  const router = setup()
  const first = await call(router, 'GET', `/workspaces/${workspaceId}/deposits`, admin()) as DepositConfirmation[]
  assert.equal(first.length, 1)
  assert.equal(first[0]!.txHash, RECORDED)
  assert.equal(first[0]!.sent, '1.050000')
  assert.equal(first[0]!.credited, '1.000000')
  assert.equal(first[0]!.fee, '0.050000')
  assert.equal(first[0]!.sources[0]!.minted, true)
  assert.match(first[0]!.reference, /^DEP-A1A1A1A1$/)
  await call(router, 'GET', `/workspaces/${workspaceId}/deposits`, admin())
  assert.equal(verified.filter((hash) => hash === RECORDED).length, 1, 'a stored deposit is not verified again')
})

test('members cannot see deposits', async () => {
  await rejectsWith(call(setup(), 'GET', `/workspaces/${workspaceId}/deposits`, plainMember()), 403)
})

test('a past deposit is added by its transaction, and only if it credited this wallet', async () => {
  const router = setup()
  const added = await call(router, 'POST', `/workspaces/${workspaceId}/deposits`, admin(), { txHash: PAST }) as DepositConfirmation
  assert.equal(added.kind, 'direct')
  assert.equal(added.sources[0]!.from, PAYER)
  await rejectsWith(call(router, 'POST', `/workspaces/${workspaceId}/deposits`, admin(), { txHash: NOT_OURS }), 404)
  await rejectsWith(call(router, 'POST', `/workspaces/${workspaceId}/deposits`, admin(), { txHash: 'nope' }), 400)
})

test('approving records who approved, with a note, and can be undone', async () => {
  const router = setup()
  const approved = await call(router, 'PUT', `/workspaces/${workspaceId}/deposits/${RECORDED}/approval`, admin(), { note: ' PO 1042 ' }) as DepositConfirmation
  assert.equal(approved.approval?.by, 'Dana (dana@example.com)')
  assert.equal(approved.approval?.note, 'PO 1042')
  const audit = store.listAudit({ limit: 5 }).entries.find((entry) => entry.action === 'deposit.approve')
  assert.ok(audit, 'the approval is in the audit log')
  const cleared = await call(router, 'DELETE', `/workspaces/${workspaceId}/deposits/${RECORDED}/approval`, admin()) as DepositConfirmation
  assert.equal(cleared.approval, null)
  await rejectsWith(call(router, 'PUT', `/workspaces/${workspaceId}/deposits/${NOT_OURS}/approval`, admin(), {}), 404)
})
