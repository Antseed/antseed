import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Wallet, verifyTypedData } from 'ethers'
import type { AntsChainConfig } from '@antseed/ants'
import { makeDepositsDomain, SET_OPERATOR_TYPES } from '@antseed/node'
import { ConsoleRouter } from '../router.js'
import type { OperatorAuthorization, OperatorState } from '../operator-types.js'
import { call, fakeDeps, fakeRequireWorkspaceAccess, memberPrincipal, rejectsWith } from './network-test-helpers.js'
import { registerOperatorRoutes, type OperatorRouteSeams } from './wallet-operator.js'

// Obvious fakes only.
const TEAM_WALLET = new Wallet(`0x${'22'.repeat(32)}`)
const OWNER_WALLET = `0x${'0a'.repeat(20)}`
const ALI_WALLET = `0x${'0b'.repeat(20)}`
const STRANGER = `0x${'0c'.repeat(20)}`
const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60_000
const CHAIN = {
  chainId: 'base-mainnet',
  evmChainId: 8453,
  rpcUrl: 'https://rpc.example.test',
  depositsContractAddress: `0x${'d1'.repeat(20)}`,
  usdcContractAddress: `0x${'a1'.repeat(20)}`,
} as AntsChainConfig

const MEMBERS: Record<string, { id: string; label: string; orgRole: 'owner' | 'admin' | 'member'; status: 'active' }> = {
  m_owner: { id: 'm_owner', label: 'Owner', orgRole: 'owner', status: 'active' },
  m_ali: { id: 'm_ali', label: 'Ali', orgRole: 'admin', status: 'active' },
  m_sam: { id: 'm_sam', label: 'Sam', orgRole: 'member', status: 'active' },
}
const owner = memberPrincipal('m_owner', {}, 'owner')
const ali = memberPrincipal('m_ali', {}, 'admin')
const sam = memberPrincipal('m_sam', { ws_team: 'member' })

function fixture(chain: { operator: string | null; nonce: bigint }, extra: Partial<OperatorRouteSeams> = {}) {
  const audits: Array<{ action: string; details?: Record<string, unknown> }> = []
  const reads = { operator: 0, nonce: 0 }
  let now = NOW
  const store = {
    getWorkspace: (id: string) => (id === 'ws_team' ? { id, buyerIdentity: 'team-a', walletAddress: TEAM_WALLET.address } : null),
    getMember: (id: string) => MEMBERS[id] ?? null,
    listWorkspaces: () => [{ id: 'ws_team', buyerIdentity: 'team-a' }, { id: 'ws_other', buyerIdentity: 'other' }],
    memberWorkspaceRoles: (memberId: string) => new Map(memberId === 'm_sam' ? [['ws_team', 'member']] : []),
    getKey: () => null,
    getAdminToken: () => null,
    recordAudit: (entry: { action: string; details?: Record<string, unknown> }) => { audits.push(entry) },
  }
  const router = new ConsoleRouter()
  registerOperatorRoutes(router, fakeDeps(store, () => now), {
    access: fakeRequireWorkspaceAccess,
    loadWallet: async (name) => (name === 'team-a' ? TEAM_WALLET : null),
    walletAddress: async () => TEAM_WALLET.address,
    resolveChain: async () => CHAIN,
    readOperator: async () => { reads.operator += 1; return chain.operator },
    operatorNonce: async () => { reads.nonce += 1; return chain.nonce },
    sessionSignIn: (sessionId) => (sessionId === 'session-m_owner' ? { authenticatedAt: now - 60_000, credentialId: 'cred_passkey' } : null),
    memberWallets: (memberId) => (memberId === 'm_owner'
      ? { wallets: [{ id: 'cred_owner_wallet', address: OWNER_WALLET, createdAt: NOW - 2 * DAY }, { id: 'cred_new', address: STRANGER.replace('0c', '0d'), createdAt: NOW - 3_600_000 }], total: 3 }
      : { wallets: [], total: 0 }),
    walletOwner: (address) => {
      if (address.toLowerCase() === OWNER_WALLET) return { memberId: 'm_owner', label: 'Owner' }
      if (address.toLowerCase() === ALI_WALLET) return { memberId: 'm_ali', label: 'Ali' }
      return null
    },
    ...extra,
  })
  return { router, audits, reads, chain, advance: (ms: number) => { now += ms } }
}

const get = (router: ConsoleRouter, who = owner, query = '') => call(router, 'GET', `/workspaces/ws_team/wallet/operator${query}`, who) as Promise<OperatorState>

test('no operator: the owner may authorize, with each wallet\'s 24 h eligibility; others read only', async () => {
  const { router } = fixture({ operator: null, nonce: 0n })
  const state = await get(router)
  assert.equal(state.relation, 'none')
  assert.equal(state.operator, null)
  assert.equal(state.buyer, TEAM_WALLET.address)
  assert.equal(state.canAuthorize, true)
  assert.deepEqual(state.eligibleWallets.map((entry) => entry.eligibleAt), [NOW - DAY, NOW - 3_600_000 + DAY])
  const asMember = await get(router, sam)
  assert.equal(asMember.canAuthorize, false)
  assert.deepEqual(asMember.eligibleWallets, [])
  const asAdmin = await get(router, ali)
  assert.equal(asAdmin.canAuthorize, false)
})

test('operator states relative to the viewer: yours, another member\'s, unknown, self', async () => {
  const yours = await get(fixture({ operator: OWNER_WALLET, nonce: 1n }).router)
  assert.equal(yours.relation, 'yours')
  assert.equal(yours.canAuthorize, false)
  assert.equal(yours.operator?.toLowerCase(), OWNER_WALLET)

  const { router: aliRouter } = fixture({ operator: ALI_WALLET, nonce: 1n })
  const seenByOwner = await get(aliRouter)
  assert.equal(seenByOwner.relation, 'member')
  assert.equal(seenByOwner.memberLabel, 'Ali')
  const seenByAli = await get(aliRouter, ali)
  assert.equal(seenByAli.relation, 'yours')
  // Plain members learn it is a member's wallet, not whose.
  const seenBySam = await get(aliRouter, sam)
  assert.equal(seenBySam.relation, 'member')
  assert.equal(seenBySam.memberLabel, null)

  const unknown = await get(fixture({ operator: STRANGER, nonce: 1n }).router)
  assert.equal(unknown.relation, 'unknown')
  assert.equal(unknown.memberLabel, null)

  const self = await get(fixture({ operator: TEAM_WALLET.address.toLowerCase(), nonce: 1n }).router)
  assert.equal(self.relation, 'self')

  // The zero address reads as no operator.
  assert.equal((await get(fixture({ operator: `0x${'0'.repeat(40)}`, nonce: 2n }).router)).relation, 'none')
})

test('operator reads are cached; fresh=1 and sync re-read at most every 3 s', async () => {
  const f = fixture({ operator: null, nonce: 0n })
  await get(f.router)
  await get(f.router, sam)
  assert.equal(f.reads.operator, 1)
  await get(f.router, owner, '?fresh=1')
  assert.equal(f.reads.operator, 1, 'a fresh read right after a read reuses it')
  f.advance(3_000)
  await get(f.router, owner, '?fresh=1')
  assert.equal(f.reads.operator, 2)
  f.advance(30_000)
  await get(f.router)
  assert.equal(f.reads.operator, 2, 'within the 60 s TTL')
  f.advance(31_000)
  await get(f.router)
  assert.equal(f.reads.operator, 3)
})

test('sync after a transaction audits a change the chain confirms', async () => {
  const f = fixture({ operator: null, nonce: 0n })
  await get(f.router)
  f.chain.operator = OWNER_WALLET
  f.advance(5_000)
  const txHash = `0x${'ef'.repeat(32)}`
  const state = await call(f.router, 'POST', '/workspaces/ws_team/wallet/operator/sync', sam, { txHash }) as OperatorState
  assert.equal(state.relation, 'member')
  assert.deepEqual(f.audits.map((entry) => entry.action), ['wallet.operator.changed'])
  assert.equal(f.audits[0]!.details?.['before'], null)
  assert.equal((f.audits[0]!.details?.['after'] as string).toLowerCase(), OWNER_WALLET)
  assert.equal(f.audits[0]!.details?.['txHash'], txHash)
  // Nothing changed: nothing audited; a bogus hash is dropped.
  f.advance(5_000)
  await call(f.router, 'POST', '/workspaces/ws_team/wallet/operator/sync', sam, { txHash: 'nope' })
  assert.equal(f.audits.length, 1)
  // Cleared on chain (transferOperator to the zero address).
  f.chain.operator = `0x${'0'.repeat(40)}`
  f.advance(5_000)
  const cleared = await call(f.router, 'POST', '/workspaces/ws_team/wallet/operator/sync', owner, {}) as OperatorState
  assert.equal(cleared.relation, 'none')
  assert.equal(f.audits.at(-1)!.details?.['after'], null)
})

test('outsiders cannot read the operator; chain failures are 502', async () => {
  const { router } = fixture({ operator: null, nonce: 0n })
  await rejectsWith(get(router, memberPrincipal('m_sam', {})), 403, 'forbidden')
  const broken = fixture({ operator: null, nonce: 0n }, { readOperator: async () => { throw new Error('rpc down') } })
  await rejectsWith(get(broken.router), 502, 'chain_unavailable')
})

test('operator-auth reads the operator and the nonce live, right before each signature', async () => {
  const f = fixture({ operator: null, nonce: 4n })
  await get(f.router) // warms the display cache; signing must not use it
  const first = await call(f.router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: OWNER_WALLET }) as OperatorAuthorization
  assert.equal(first.nonce, '4')
  assert.equal(first.chainId, 8453)
  assert.equal(first.depositsContract?.toLowerCase(), CHAIN.depositsContractAddress)
  assert.equal(first.operator?.toLowerCase(), OWNER_WALLET)
  const signer = verifyTypedData(makeDepositsDomain(8453, CHAIN.depositsContractAddress!), SET_OPERATOR_TYPES, { operator: OWNER_WALLET, nonce: 4n }, first.signature)
  assert.equal(signer, TEAM_WALLET.address)
  // The nonce moved on chain (e.g. an operator was set and cleared meanwhile).
  f.chain.nonce = 6n
  const second = await call(f.router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: OWNER_WALLET }) as OperatorAuthorization
  assert.equal(second.nonce, '6')
  assert.equal(f.reads.operator, 3)
  assert.equal(f.reads.nonce, 2)
})

test('operator-auth refuses a wallet that already has an operator, without signing', async () => {
  const f = fixture({ operator: ALI_WALLET, nonce: 1n })
  await rejectsWith(call(f.router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: OWNER_WALLET }), 409, 'operator_already_set')
  assert.equal(f.reads.nonce, 1, 'the nonce is read with the operator, but nothing is signed')
  assert.deepEqual(f.audits.map((entry) => entry.action), ['wallet.operator_auth.denied'])
  assert.equal(f.audits[0]!.details?.['code'], 'operator_already_set')
})

test('operator-auth keeps the 24 h rule for a newly added wallet', async () => {
  const f = fixture({ operator: null, nonce: 0n })
  await rejectsWith(call(f.router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: STRANGER.replace('0c', '0d') }), 403, 'operator_too_new')
  await rejectsWith(call(f.router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: STRANGER }), 403, 'operator_not_yours')
  await rejectsWith(call(f.router, 'POST', '/workspaces/ws_team/wallet/operator-auth', ali, { operator: ALI_WALLET }), 403, 'forbidden')
  assert.equal(f.reads.nonce, 0)
})

test('GET /wallet/operators summarizes every workspace the caller can open, null where unreadable', async () => {
  const { router } = fixture({ operator: null, nonce: 0n }, {
    walletAddress: async (name) => { if (name === 'other') throw new Error('no key'); return TEAM_WALLET.address },
  })
  assert.deepEqual(await call(router, 'GET', '/wallet/operators', owner), [
    { workspaceId: 'ws_team', operator: null, relation: 'none', canAuthorize: true },
    { workspaceId: 'ws_other', operator: null, relation: null, canAuthorize: false },
  ])
  // A plain member sees only the workspaces they belong to, and cannot authorize.
  assert.deepEqual(await call(router, 'GET', '/wallet/operators', sam), [
    { workspaceId: 'ws_team', operator: null, relation: 'none', canAuthorize: false },
  ])
})
