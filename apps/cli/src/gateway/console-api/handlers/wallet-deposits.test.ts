import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AntsChainConfig } from '@antseed/ants'
import type { VerifiedDeposit as Verified } from '../../services/deposits.js'
import { GatewayStore } from '../../store.js'
import { ConsoleRouter } from '../router.js'
import type { DepositConfirmation } from '../types.js'
import { call, fakeDeps, fakeRequireWorkspaceAccess, memberPrincipal, rejectsWith, startFakeBuyer, type FakeBuyer } from './network-test-helpers.js'
import { registerWalletRoutes } from './wallet.js'

// Obvious fakes: fixed test addresses and hashes, never real ones.
const WALLET = `0x${'11'.repeat(20)}`
const PAYER = `0x${'22'.repeat(20)}`
const MINTED_FROM = '0x0000000000000000000000000000000000000000'
const RECORDED = `0x${'a1'.repeat(32)}` // a sweep the buyer recorded…
const RECORDED_LATER = `0x${'a2'.repeat(32)}` // …and a later sweep of the same transfer (held back at the credit limit)
const SENT = `0x${'e5'.repeat(32)}` // the exchange withdrawal that funded the first sweep
const PAST = `0x${'b2'.repeat(32)}`
const NOT_OURS = `0x${'c3'.repeat(32)}`
const SENT_EARLIER = `0x${'f6'.repeat(32)}`
const FUNDED_APPROVED = `0x${'d7'.repeat(32)}`
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
    'GET /_antseed/deposits/history': () => ({ body: { ok: true, address: WALLET, deposits: [
      { txHash: RECORDED, creditedBaseUnits: '1000000', at: 1 },
      { txHash: RECORDED_LATER, creditedBaseUnits: '1000000', at: 2 },
    ] } }),
  })
})

after(async () => {
  await buyer.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const transfer = (txHash: string, wallet: string, from: string, amountUsdc: number, blockNumber: number): Verified =>
  ({ txHash, wallet, kind: 'transfer', creditedUsdc: amountUsdc, feeUsdc: 0, blockNumber, blockTime: blockNumber * 1000, sources: [{ from, amountUsdc, txHash }] })
const sweep = (txHash: string, wallet: string, sources: Verified['sources']): Verified =>
  ({ txHash, wallet, kind: 'relay', creditedUsdc: 1_000_000, feeUsdc: 50_000, blockNumber: 10, blockTime: 10_000, sources })

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
      switch (txHash) {
        case RECORDED: return sweep(txHash, wallet, [{ from: MINTED_FROM, amountUsdc: 500_000_000, txHash: SENT }])
        case RECORDED_LATER: return sweep(txHash, wallet, []) // its funding transfer was outside the lookback
        case SENT: return transfer(txHash, wallet, MINTED_FROM, 500_000_000, 9)
        case SENT_EARLIER: return transfer(txHash, wallet, PAYER, 7_000_000, 3)
        case FUNDED_APPROVED: return transfer(txHash, wallet, PAYER, 40_000_000, 4)
        case PAST: return { txHash, wallet, kind: 'direct', creditedUsdc: 1_000_000, feeUsdc: 0, blockNumber: 10, blockTime: 1_699_000_000_000, sources: [{ from: PAYER, amountUsdc: 1_000_000, txHash }] }
        default: return null
      }
    },
  })
  return router
}

const admin = () => memberPrincipal(ownerId, { [workspaceId]: 'admin' }, 'owner')
const plainMember = () => memberPrincipal(ownerId, { [workspaceId]: 'member' })

test('listing shows the transfer that funded the sweeps, once, and not the sweeps', async () => {
  const router = setup()
  const first = await call(router, 'GET', `/workspaces/${workspaceId}/deposits`, admin()) as DepositConfirmation[]
  assert.equal(store.getDeposit(RECORDED)?.kind, 'relay')
  assert.equal(store.getDeposit(RECORDED_LATER)?.kind, 'relay')
  assert.deepEqual(first.map((deposit) => deposit.txHash), [SENT])
  assert.equal(first[0]!.kind, 'transfer')
  assert.equal(first[0]!.sent, '500.000000')
  assert.equal(first[0]!.credited, '500.000000')
  assert.equal(first[0]!.fee, '0.000000')
  assert.equal(first[0]!.sources[0]!.minted, true)
  assert.match(first[0]!.reference, /^DEP-E5E5E5E5$/)

  await call(router, 'GET', `/workspaces/${workspaceId}/deposits`, admin())
  for (const hash of [RECORDED, RECORDED_LATER, SENT]) {
    assert.equal(verified.filter((entry) => entry === hash).length, 1, `${hash} is checked on-chain once`)
  }
})

test('a sweep approved before transfers were listed hands its approval to the transfer that funded it', async () => {
  const approvedSweep = { ...sweep(`0x${'a9'.repeat(32)}`, WALLET, [{ from: PAYER, amountUsdc: 40_000_000, txHash: FUNDED_APPROVED }]), workspaceId }
  store.insertDeposit(approvedSweep)
  store.setDepositApproval(approvedSweep.txHash, { byId: null, byLabel: 'Owner', note: 'October' })
  const list = await call(setup(), 'GET', `/workspaces/${workspaceId}/deposits`, admin()) as DepositConfirmation[]
  const funded = list.find((deposit) => deposit.txHash === FUNDED_APPROVED)
  assert.equal(funded?.approval?.by, 'Owner')
  assert.equal(funded?.approval?.note, 'October')
  assert.ok(!list.some((deposit) => deposit.kind === 'relay'), 'sweeps are not listed')
})

test('members cannot see deposits', async () => {
  await rejectsWith(call(setup(), 'GET', `/workspaces/${workspaceId}/deposits`, plainMember()), 403)
})

test('a past deposit is added by its transaction, and only if it credited this wallet', async () => {
  const router = setup()
  const added = await call(router, 'POST', `/workspaces/${workspaceId}/deposits`, admin(), { txHash: PAST }) as DepositConfirmation
  assert.equal(added.kind, 'direct')
  assert.equal(added.sources[0]!.from, PAYER)
  const sent = await call(router, 'POST', `/workspaces/${workspaceId}/deposits`, admin(), { txHash: SENT_EARLIER }) as DepositConfirmation
  assert.equal(sent.kind, 'transfer')
  assert.equal(sent.sent, '7.000000')
  await rejectsWith(call(router, 'POST', `/workspaces/${workspaceId}/deposits`, admin(), { txHash: NOT_OURS }), 404)
  await rejectsWith(call(router, 'POST', `/workspaces/${workspaceId}/deposits`, admin(), { txHash: 'nope' }), 400)
  // A sweep is a move inside the workspace: the transfer that funded it is what to add.
  await rejectsWith(call(router, 'POST', `/workspaces/${workspaceId}/deposits`, admin(), { txHash: RECORDED }), 422)
})

test('approving records who approved, with a note, and can be undone', async () => {
  const router = setup()
  const approved = await call(router, 'PUT', `/workspaces/${workspaceId}/deposits/${SENT}/approval`, admin(), { note: ' PO 1042 ' }) as DepositConfirmation
  assert.equal(approved.approval?.by, 'Dana (dana@example.com)')
  assert.equal(approved.approval?.note, 'PO 1042')
  const audit = store.listAudit({ limit: 5 }).entries.find((entry) => entry.action === 'deposit.approve')
  assert.ok(audit, 'the approval is in the audit log')
  const cleared = await call(router, 'DELETE', `/workspaces/${workspaceId}/deposits/${SENT}/approval`, admin()) as DepositConfirmation
  assert.equal(cleared.approval, null)
  await rejectsWith(call(router, 'PUT', `/workspaces/${workspaceId}/deposits/${NOT_OURS}/approval`, admin(), {}), 404)
})
