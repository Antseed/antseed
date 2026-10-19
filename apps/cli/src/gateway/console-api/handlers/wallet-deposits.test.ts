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
const SENT = `0x${'e5'.repeat(32)}`
const SENT_EARLIER = `0x${'f6'.repeat(32)}`
const CHAIN = { chainId: 'base-sepolia', evmChainId: 84532, rpcUrl: 'http://127.0.0.1:1', usdcContractAddress: `0x${'f0'.repeat(20)}` } as AntsChainConfig

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
const scanned: Array<[number, number]> = []
let head = 5_000
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
      if (txHash === SENT_EARLIER) {
        return { txHash, wallet, kind: 'transfer', creditedUsdc: 7_000_000, feeUsdc: 0, blockNumber: 3, blockTime: 1_698_000_000_000, sources: [{ from: PAYER, amountUsdc: 7_000_000, txHash }] }
      }
      return {
        txHash, wallet, kind: txHash === PAST ? 'direct' : 'relay',
        creditedUsdc: 1_000_000, feeUsdc: txHash === PAST ? 0 : 50_000, blockNumber: 10, blockTime: 1_699_000_000_000,
        sources: [{ from: txHash === PAST ? PAYER : '0x0000000000000000000000000000000000000000', amountUsdc: 1_050_000, txHash: `0x${'d4'.repeat(32)}` }],
      }
    },
    headBlock: async () => head,
    scanTransfers: async (_chain, wallet, fromBlock, toBlock) => {
      scanned.push([fromBlock, toBlock])
      if (wallet !== WALLET.toLowerCase() || fromBlock > 9 || toBlock < 9) return []
      return [{ txHash: SENT, wallet, kind: 'transfer', creditedUsdc: 25_000_000, feeUsdc: 0, blockNumber: 9, blockTime: 1_698_900_000_000, sources: [{ from: PAYER, amountUsdc: 25_000_000, txHash: SENT }] }]
    },
  })
  return router
}

const admin = () => memberPrincipal(ownerId, { [workspaceId]: 'admin' }, 'owner')
const plainMember = () => memberPrincipal(ownerId, { [workspaceId]: 'member' })

test('listing shows the USDC sent to the wallet, found by scanning from just before the first sweep; sweeps stay internal', async () => {
  const router = setup()
  const first = await call(router, 'GET', `/workspaces/${workspaceId}/deposits`, admin()) as DepositConfirmation[]
  // The buyer's sweep (block 10) is verified and kept, the scan starts a lookback before it, and only the transfer is listed.
  assert.equal(store.getDeposit(RECORDED)?.kind, 'relay')
  assert.equal(scanned[0]![0], 0)
  assert.equal(scanned.at(-1)![1], head - 2, 'the newest blocks wait for the next scan')
  assert.deepEqual(first.map((deposit) => deposit.txHash), [SENT])
  assert.equal(first[0]!.kind, 'transfer')
  assert.equal(first[0]!.sent, '25.000000')
  assert.equal(first[0]!.credited, '25.000000')
  assert.equal(first[0]!.fee, '0.000000')
  assert.equal(first[0]!.sources[0]!.from, PAYER)
  assert.match(first[0]!.reference, /^DEP-E5E5E5E5$/)

  // The next listing scans only the new blocks, and verifies the sweep no more.
  scanned.length = 0
  head += 1_500
  await call(router, 'GET', `/workspaces/${workspaceId}/deposits`, admin())
  assert.deepEqual(scanned, [[4_999, 5_998], [5_999, 6_498]])
  assert.equal(verified.filter((hash) => hash === RECORDED).length, 1, 'a stored deposit is not verified again')
})

test('a sweep approved before transfers were listed hands its approval to the transfer that funded it', async () => {
  const FUNDED = `0x${'d4'.repeat(32)}` // the fake sweep's source
  const approvedSweep = { txHash: `0x${'a9'.repeat(32)}`, wallet: WALLET, kind: 'relay' as const, creditedUsdc: 1, feeUsdc: 0, blockNumber: 1, blockTime: 1,
    sources: [{ from: PAYER, amountUsdc: 1, txHash: FUNDED }], workspaceId }
  store.insertDeposit(approvedSweep)
  store.setDepositApproval(approvedSweep.txHash, { byId: null, byLabel: 'Owner', note: 'October' })
  const router = new ConsoleRouter()
  registerWalletRoutes(router, fakeDeps(store), {
    buyer: buyer.client, requireWorkspaceAccess: fakeRequireWorkspaceAccess, walletAddress: async () => WALLET, resolveChain: async () => CHAIN,
    verifyDeposit: async () => null, headBlock: async () => head + 10,
    scanTransfers: async (_chain, wallet, fromBlock) => fromBlock > head ? [] : [{ txHash: FUNDED, wallet, kind: 'transfer', creditedUsdc: 500_000_000, feeUsdc: 0, blockNumber: head, blockTime: 2, sources: [{ from: PAYER, amountUsdc: 500_000_000, txHash: FUNDED }] }],
  })
  const list = await call(router, 'GET', `/workspaces/${workspaceId}/deposits`, admin()) as DepositConfirmation[]
  const transfer = list.find((deposit) => deposit.txHash === FUNDED)
  assert.equal(transfer?.approval?.by, 'Owner')
  assert.equal(transfer?.approval?.note, 'October')
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
  const approved = await call(router, 'PUT', `/workspaces/${workspaceId}/deposits/${RECORDED}/approval`, admin(), { note: ' PO 1042 ' }) as DepositConfirmation
  assert.equal(approved.approval?.by, 'Dana (dana@example.com)')
  assert.equal(approved.approval?.note, 'PO 1042')
  const audit = store.listAudit({ limit: 5 }).entries.find((entry) => entry.action === 'deposit.approve')
  assert.ok(audit, 'the approval is in the audit log')
  const cleared = await call(router, 'DELETE', `/workspaces/${workspaceId}/deposits/${RECORDED}/approval`, admin()) as DepositConfirmation
  assert.equal(cleared.approval, null)
  await rejectsWith(call(router, 'PUT', `/workspaces/${workspaceId}/deposits/${NOT_OURS}/approval`, admin(), {}), 404)
})
