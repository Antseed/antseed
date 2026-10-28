import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AntsChainConfig } from '@antseed/ants'
import type { SettlementRead } from '../../services/statements.js'
import { GatewayStore } from '../../store.js'
import { ConsoleRouter } from '../router.js'
import type { BillingProfile, PurchaseStatement, StatementSummary } from '../types.js'
import { call, fakeDeps, fakeRequireWorkspaceAccess, memberPrincipal, rejectsWith, startFakeBuyer, type FakeBuyer } from './network-test-helpers.js'
import { registerWalletRoutes } from './wallet.js'

// Obvious fakes: fixed test addresses and hashes, never real ones.
const WALLET = `0x${'11'.repeat(20)}`
const SELLER_A = '1a'.repeat(20)
const SELLER_B = '2b'.repeat(20)
const ROUTER = '3c'.repeat(20)
const OCT = Date.UTC(2026, 9, 1)
const NOV = Date.UTC(2026, 10, 1)
const MID_OCT = Date.UTC(2026, 9, 15)
const DEC = Date.UTC(2026, 11, 5)
const CHAIN = { chainId: 'base-sepolia', evmChainId: 84532, rpcUrl: 'http://127.0.0.1:1', explorerApiUrl: 'https://explorer.test' } as AntsChainConfig

let dir: string
let store: GatewayStore
let buyer: FakeBuyer
let workspaceId: string
let ownerId: string
let now = MID_OCT
let explorerDown = false
/** How far the explorer has indexed (block time, epoch ms). */
let indexedAt = Date.UTC(2027, 0, 1)
let rate = 1.115
let ecbDown = false
/** Deposits the buyer recorded for the wallet. */
let history: string[] = []
const LATE_DEPOSIT = `0x${'e4'.repeat(32)}`
const vatChecks: string[] = []
let ledgerSeq = 0

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'antseed-statements-'))
  store = new GatewayStore(dir, () => now)
  ownerId = store.createOwner({ label: 'Dana', email: 'dana@example.com' }).id
  workspaceId = store.defaultWorkspace().id
  buyer = await startFakeBuyer({
    'GET /_antseed/deposits/history': () => ({ body: { ok: true, address: WALLET, deposits: history.map((txHash) => ({ txHash })) } }),
  })
  spend(SELLER_A, 'qwen3-coder', 1_500_000, 'r1', OCT + 1000, { input: 1000, cached: 400, output: 200 })
  spend(SELLER_A, 'qwen3-coder', 500_000, 'r1', OCT + 2000, { input: 0, cached: 0, output: 0 }) // a second charge of the same request
  spend(SELLER_A, 'qwen3-coder', 2_000_000, 'r2', OCT + 3000, { input: 2000, cached: 0, output: 300 })
  spend(SELLER_B, 'deepseek-v3', 3_000_000, 'r3', OCT + 4000, { input: 500, cached: 0, output: 100 })
  spend(ROUTER, 'router-svc', 10_000, 'r3', OCT + 4000, { input: 0, cached: 0, output: 0 }, true)
  spend(SELLER_B, 'deepseek-v3', 9_000_000, 'r4', NOV + 1000, { input: 1, cached: 0, output: 1 }) // November: not on October's statement
  store.insertDeposit({ txHash: `0x${'e1'.repeat(32)}`, workspaceId, wallet: WALLET, kind: 'transfer', creditedUsdc: 100_000_000, feeUsdc: 0, blockNumber: 1, blockTime: OCT + 500, sources: [] })
  store.insertDeposit({ txHash: `0x${'e2'.repeat(32)}`, workspaceId, wallet: WALLET, kind: 'relay', creditedUsdc: 99_990_000, feeUsdc: 10_000, blockNumber: 2, blockTime: OCT + 600, sources: [] })
  store.insertDeposit({ txHash: `0x${'e3'.repeat(32)}`, workspaceId, wallet: WALLET, kind: 'transfer', creditedUsdc: 5_000_000, feeUsdc: 0, blockNumber: 3, blockTime: OCT - 1000, sources: [] })
})

after(async () => {
  await buyer.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function spend(seller: string, model: string, amountUsdc: number, tag: string, at: number, tokens: { input: number; cached: number; output: number }, routingFee = false): void {
  store.recordLedgerEntry({
    kind: 'spend', keyId: 'key-1', buyerIdentity: 'default', amountUsdc, externalRef: `spend:test:${ledgerSeq++}`, requestTag: tag,
    sellerPeerId: seller, inputTokens: tokens.input, cachedInputTokens: tokens.cached, outputTokens: tokens.output, createdAt: at,
    workspaceId, memberId: ownerId, model, routingFee,
  })
}

function setup(): ConsoleRouter {
  const router = new ConsoleRouter()
  registerWalletRoutes(router, fakeDeps(store, () => now), {
    buyer: buyer.client,
    requireWorkspaceAccess: fakeRequireWorkspaceAccess,
    walletAddress: async () => WALLET,
    resolveChain: async () => CHAIN,
    verifyDeposit: async (_chain, txHash, wallet) => {
      return txHash === LATE_DEPOSIT ? { txHash, wallet, kind: 'transfer', creditedUsdc: 20_000_000, feeUsdc: 0, blockNumber: 4, blockTime: OCT + 50_000, sources: [] } : null
    },
    statements: {
      fetchEurRate: async (date) => { if (ecbDown) throw new Error('ECB unreachable'); return { usdPerEur: rate, date } },
      checkVatNumber: async (vatNumber) => { vatChecks.push(vatNumber); return vatNumber.startsWith('NL') ? true : null },
      fetchSettlements: async (url, buyerAddress, from, to): Promise<SettlementRead> => {
        if (explorerDown) throw new Error('explorer unreachable')
        assert.equal(url, 'https://explorer.test')
        assert.equal(buyerAddress, WALLET)
        assert.deepEqual([from, to], [OCT, NOV])
        return {
          settlements: [
            { seller: `0x${SELLER_A}`, txHash: `0x${'f1'.repeat(32)}`, time: OCT + 10_000, amountUsdc: 4_000_000 },
            { seller: `0x${SELLER_B}`, txHash: `0x${'f2'.repeat(32)}`, time: OCT + 20_000, amountUsdc: 3_000_000 },
          ].filter((settlement) => settlement.time <= indexedAt),
          indexed: [{ chainId: CHAIN.evmChainId, at: indexedAt }, { chainId: 1, at: Date.UTC(2030, 0, 1) }],
        }
      },
      peers: async () => new Map([[SELLER_A, { name: 'Northwind', verificationLinks: [{ kind: 'domain' as const, label: 'northwind.example', href: 'https://northwind.example' }] }]]),
    },
  })
  return router
}

const admin = () => memberPrincipal(ownerId, { [workspaceId]: 'admin' }, 'owner')
const plainMember = () => memberPrincipal(ownerId, { [workspaceId]: 'member' })
const PROFILE = { companyName: 'Voorbeeld B.V.', address: 'Keizersgracht 1\n1015 CJ Amsterdam', country: 'nl', vatNumber: 'nl 0000.00000 B01', registrationNumber: '12345678' }

test('a month in progress is an open draft: purchases per seller and model, settlements, money in', async () => {
  now = MID_OCT
  const statement = await call(setup(), 'GET', `/workspaces/${workspaceId}/statements/2026-10`, admin()) as PurchaseStatement
  assert.equal(statement.status, 'open')
  assert.equal(statement.issuedAt, null)
  assert.equal(statement.buyer, null)
  assert.equal(statement.total, '7.010000')
  assert.equal(statement.requests, 3, 'r1 counts once although it was charged twice; the routing fee is not a request')
  assert.deepEqual(statement.eurRate, { usdPerEur: 1.115, date: '2026-10-15' })

  const [first, second, third] = statement.suppliers
  assert.equal(first!.peerId, `0x${SELLER_A}`)
  assert.equal(first!.name, 'Northwind')
  assert.equal(first!.verificationLinks[0]!.label, 'northwind.example')
  assert.deepEqual(first!.lines, [{ service: 'qwen3-coder', kind: 'inference', requests: 2, inputTokens: 3000, cachedInputTokens: 400, outputTokens: 500, amount: '4.000000' }])
  assert.deepEqual(first!.settlements, [{ txHash: `0x${'f1'.repeat(32)}`, time: OCT + 10_000, amount: '4.000000' }])
  assert.equal(second!.peerId, `0x${SELLER_B}`)
  assert.equal(second!.name, null)
  assert.equal(second!.total, '3.000000')
  assert.equal(third!.lines[0]!.kind, 'routing')
  assert.deepEqual(third!.settlements, [], 'the explorer listed no settlement with the router this month')

  assert.deepEqual(statement.funding.deposits.map((deposit) => deposit.txHash), [`0x${'e1'.repeat(32)}`], 'September\'s transfer and the sweep are not money in')
  assert.equal(statement.funding.total, '100.000000')
  assert.equal(statement.funding.relayFees, '0.010000')
  assert.equal(statement.settlementsSource, 'https://explorer.test')
  assert.equal(store.getStatement(workspaceId, '2026-10'), null, 'a draft is not kept')
})

test('billing details: the VAT number is normalized and checked with VIES once; members cannot see them', async () => {
  const router = setup()
  await rejectsWith(call(router, 'GET', `/workspaces/${workspaceId}/billing-profile`, plainMember()), 403)
  assert.equal(await call(router, 'GET', `/workspaces/${workspaceId}/billing-profile`, admin()), null)
  await rejectsWith(call(router, 'PUT', `/workspaces/${workspaceId}/billing-profile`, admin(), { ...PROFILE, companyName: ' ' }), 400, 'invalid_billing_profile')
  await rejectsWith(call(router, 'PUT', `/workspaces/${workspaceId}/billing-profile`, admin(), { ...PROFILE, country: 'Netherlands' }), 400, 'invalid_billing_profile')

  const saved = await call(router, 'PUT', `/workspaces/${workspaceId}/billing-profile`, admin(), PROFILE) as BillingProfile
  assert.equal(saved.country, 'NL')
  assert.equal(saved.vatNumber, 'NL000000000B01')
  assert.deepEqual(saved.vatCheck, { valid: true, at: now })
  await call(router, 'PUT', `/workspaces/${workspaceId}/billing-profile`, admin(), { ...PROFILE, companyName: 'Voorbeeld Software B.V.' })
  assert.deepEqual(vatChecks, ['NL000000000B01'], 'an unchanged number is not checked again')
  assert.equal(store.listAudit({ action: 'billing.update' }).entries.length, 2)
})

test('a month is not final without billing details, or while the explorer cannot be read', async () => {
  now = NOV + 2 * 24 * 60 * 60 * 1000
  const router = setup()
  store.deleteBillingProfile(workspaceId)
  assert.equal((await call(router, 'GET', `/workspaces/${workspaceId}/statements/2026-10`, admin()) as PurchaseStatement).status, 'open')

  await call(router, 'PUT', `/workspaces/${workspaceId}/billing-profile`, admin(), PROFILE)
  explorerDown = true
  const unread = await call(setup(), 'GET', `/workspaces/${workspaceId}/statements/2026-10`, admin()) as PurchaseStatement
  assert.equal(unread.status, 'open')
  assert.equal(unread.settlementsSource, null)
  assert.equal(unread.suppliers[0]!.settlements, null)
  explorerDown = false
})

test('a month is not final while the explorer has not indexed past its end', async () => {
  now = NOV + 2 * 24 * 60 * 60 * 1000
  const path = `/workspaces/${workspaceId}/statements/2026-10`
  indexedAt = OCT + 15_000 // behind: the second settlement is not indexed yet
  const lagging = await call(setup(), 'GET', path, admin()) as PurchaseStatement
  assert.equal(lagging.status, 'open', 'another chain indexed further does not count')
  assert.equal(lagging.suppliers.find((supplier) => supplier.peerId === `0x${SELLER_B}`)!.settlements!.length, 0)
  assert.equal(store.getStatement(workspaceId, '2026-10'), null)
  indexedAt = Date.UTC(2027, 0, 1)
})

test('a month is not final on a settlement list cached before the explorer went down', async () => {
  const router = setup()
  const path = `/workspaces/${workspaceId}/statements/2026-10`
  now = NOV + 24 * 60 * 60 * 1000 - 10 * 60 * 1000 // ten minutes before the grace period ends: a draft, settlements cached
  assert.equal((await call(router, 'GET', path, admin()) as PurchaseStatement).status, 'open')
  now += 20 * 60 * 1000
  explorerDown = true
  const stale = await call(router, 'GET', path, admin()) as PurchaseStatement
  assert.equal(stale.status, 'open')
  assert.equal(store.getStatement(workspaceId, '2026-10'), null)
  explorerDown = false

  // The same with the exchange rate: one cached before a failed refresh is shown in the draft, never issued.
  const ratesRouter = setup()
  now = NOV + 24 * 60 * 60 * 1000 - 7 * 60 * 60 * 1000
  assert.equal((await call(ratesRouter, 'GET', path, admin()) as PurchaseStatement).status, 'open')
  now += 8 * 60 * 60 * 1000 // past the grace period and the rate's six-hour cache
  ecbDown = true
  const staleRate = await call(ratesRouter, 'GET', path, admin()) as PurchaseStatement
  assert.equal(staleRate.status, 'open')
  assert.equal(staleRate.eurRate?.usdPerEur, 1.115, 'the draft still shows the cached rate')
  assert.equal(store.getStatement(workspaceId, '2026-10'), null)
  ecbDown = false
})

test('a month a day after its end is final: kept as issued, unchanged by later spend or rates; its money in is read again', async () => {
  now = NOV + 2 * 24 * 60 * 60 * 1000
  const router = setup()
  const path = `/workspaces/${workspaceId}/statements/2026-10`
  const issued = await call(router, 'GET', path, admin()) as PurchaseStatement
  assert.equal(issued.status, 'final')
  assert.equal(issued.issuedAt, now)
  assert.equal(issued.buyer?.companyName, 'Voorbeeld B.V.')
  assert.equal(issued.eurRate?.date, '2026-10-31')
  assert.match(issued.reference, /^PS-2026-10-[A-Z0-9]{1,6}$/)
  assert.equal(issued.funding.total, '100.000000')
  assert.equal(issued.suppliers.find((supplier) => supplier.peerId === `0x${SELLER_B}`)!.settlements!.length, 1, 'issued once the explorer caught up')

  spend(SELLER_A, 'qwen3-coder', 1_000_000, 'late', OCT + 5000, { input: 1, cached: 0, output: 1 })
  rate = 1.2
  // An October transfer the buyer records only now (its sweep waited for credit headroom), checked on-chain when the statement is next read.
  history = [LATE_DEPOSIT]
  now += 60_000
  const again = await call(setup(), 'GET', path, admin()) as PurchaseStatement
  const { funding, ...rest } = again
  const { funding: issuedFunding, ...issuedRest } = issued
  assert.deepEqual(rest, issuedRest, 'purchases, buyer and rate are as issued')
  assert.ok(funding.deposits.some((deposit) => deposit.txHash === LATE_DEPOSIT), 'the transfer recorded after issue is listed')
  assert.equal(funding.total, '120.000000')
  assert.equal(funding.asOf, now)
  assert.equal(issuedFunding.asOf, now - 60_000)
  assert.equal(store.listAudit({ action: 'statement.issue' }).entries.length, 1)

  const list = await call(router, 'GET', `/workspaces/${workspaceId}/statements`, admin()) as StatementSummary[]
  assert.deepEqual(list.map((entry) => [entry.period, entry.status, entry.purchases]), [['2026-11', 'open', '9.000000'], ['2026-10', 'final', '7.010000']])
})

test('a routed purchase is listed under the model the seller served, even when spend arrives before the response names it', () => {
  const { key } = store.createKey({ label: 'routed', workspaceId, ownerMemberId: ownerId, limits: { daily: null, weekly: null, monthly: null, total: null }, expiresAt: null })
  store.startRequest({ tag: 'routed-1', keyId: key.id, buyerIdentity: 'default', method: 'POST', path: '/v1/chat/completions', model: 'alpha-route', startedAt: DEC })
  const charge = (amountUsdc: number, routingFee: boolean, seller: string) => store.recordLedgerEntry({
    kind: 'spend', keyId: key.id, buyerIdentity: 'default', amountUsdc, externalRef: `spend:test:${ledgerSeq++}`, requestTag: 'routed-1',
    sellerPeerId: seller, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, createdAt: DEC + 1, routingFee,
  })
  charge(10_000, true, ROUTER)
  charge(2_000_000, false, SELLER_A)
  store.recordRequestOutcome('routed-1', { sellerPeerId: SELLER_A, servedModel: 'gpt-5', router: { peerId: `0x${ROUTER}`, service: 'alpha-route', rank: 1 } })
  charge(1_000_000, false, SELLER_A) // a later charge of the same request, after the response named the model
  const lines = store.statementLines(workspaceId, DEC, DEC + 1000).map((line) => [line.sellerPeerId, line.model, line.routingFee, line.spentUsdc])
  assert.deepEqual(lines.sort(), [[ROUTER, 'alpha-route', true, 10_000], [SELLER_A, 'gpt-5', false, 3_000_000]].sort())
})

test('a wallet shared with another workspace: its settlements are shown as the wallet\'s, and a seller only the other one bought from is left out', async () => {
  const other = store.createWorkspace({ name: 'Research', buyerIdentity: 'default' })
  const SELLER_C = '5e'.repeat(20)
  const at = Date.UTC(2026, 8, 10)
  store.recordLedgerEntry({
    kind: 'spend', keyId: 'key-2', buyerIdentity: 'default', amountUsdc: 1_000_000, externalRef: `spend:test:${ledgerSeq++}`, requestTag: 'other-1',
    sellerPeerId: SELLER_C, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, createdAt: at, workspaceId: other.id, memberId: ownerId, model: 'glm-5', routingFee: false,
  })
  spend(SELLER_A, 'qwen3-coder', 500_000, 'mine-1', at, { input: 1, cached: 0, output: 1 })
  const settled = (txHash: string, seller: string) => ({ seller: `0x${seller}`, txHash, time: at + 1000, amountUsdc: 1_500_000 })
  const router = new ConsoleRouter()
  registerWalletRoutes(router, fakeDeps(store, () => now), {
    buyer: buyer.client, requireWorkspaceAccess: fakeRequireWorkspaceAccess, walletAddress: async () => WALLET, resolveChain: async () => CHAIN,
    statements: {
      fetchEurRate: async (date) => ({ usdPerEur: rate, date }),
      fetchSettlements: async () => ({ settlements: [settled(`0x${'c1'.repeat(32)}`, SELLER_A), settled(`0x${'c2'.repeat(32)}`, SELLER_C)], indexed: [{ chainId: CHAIN.evmChainId, at: indexedAt }] }),
      peers: async () => new Map(),
    },
  })
  const statement = await call(router, 'GET', `/workspaces/${workspaceId}/statements/2026-09`, admin()) as PurchaseStatement
  assert.deepEqual(statement.sharedWallet, ['Research'])
  assert.deepEqual(statement.suppliers.map((supplier) => supplier.peerId), [`0x${SELLER_A}`], 'the seller only Research bought from is not on this statement')
  assert.equal(statement.suppliers[0]!.settlements!.length, 1)
})

test('periods: malformed is a 400, a month not started yet a 404', async () => {
  const router = setup()
  await rejectsWith(call(router, 'GET', `/workspaces/${workspaceId}/statements/2026-13`, admin()), 400, 'invalid_period')
  await rejectsWith(call(router, 'GET', `/workspaces/${workspaceId}/statements/2099-01`, admin()), 404, 'not_found')
})
