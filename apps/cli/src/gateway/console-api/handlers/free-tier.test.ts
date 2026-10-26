import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Wallet } from 'ethers'
import type { AntsChainConfig } from '@antseed/ants'
import {
  FREE_TIER_DELEGATION_TYPES,
  encodeFreeTierDelegationCode,
  freeTierDelegationMessage,
  makeFreeTierDelegationDomain,
} from '@antseed/node'
import type { FreeTierSharing } from '../free-tier-types.js'
import { ConsoleRouter } from '../router.js'
import { registerFreeTierRoutes } from './free-tier.js'
import { call, fakeDeps, fakeRequireWorkspaceAccess, memberPrincipal, rejectsWith } from './network-test-helpers.js'

// Obvious fakes only.
const TEAM_BUYER = `0x${'11'.repeat(20)}`
const OTHER_BUYER = `0x${'22'.repeat(20)}`
const NOW = 1_700_000_000_000
const LATER = NOW / 1000 + 86_400
const CHAIN = { chainId: 'base-mainnet', evmChainId: 8453 } as AntsChainConfig

const admin = memberPrincipal('m_admin', { ws_team: 'admin' })
const member = memberPrincipal('m_sam', { ws_team: 'member' })

async function codeFor(staker: Pick<Wallet, 'address' | 'signTypedData'>, buyer: string, expiresAt = LATER): Promise<string> {
  const unsigned = { staker: staker.address, buyer, expiresAt }
  const signature = await staker.signTypedData(makeFreeTierDelegationDomain(CHAIN.evmChainId), FREE_TIER_DELEGATION_TYPES, freeTierDelegationMessage(unsigned))
  return encodeFreeTierDelegationCode({ ...unsigned, signature })
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-free-tier-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({ buyer: { maxPricing: { defaults: { inputUsdPerMillion: 5 } } } }))
  const audits: string[] = []
  const store = {
    getWorkspace: (id: string) => (id === 'ws_team' ? { id, name: 'Team', buyerIdentity: 'team-a' } : null),
    getMember: () => null,
    getKey: () => null,
    getAdminToken: () => null,
    recordAudit: (entry: { action: string }) => { audits.push(entry.action) },
  }
  const router = new ConsoleRouter()
  registerFreeTierRoutes(router, { ...fakeDeps(store, () => NOW), configPath }, {
    access: fakeRequireWorkspaceAccess,
    walletAddress: async (name) => (name === 'team-a' ? TEAM_BUYER : null),
    resolveChain: async () => CHAIN,
  })
  const config = async () => JSON.parse(await readFile(configPath, 'utf8'))
  return { router, audits, config, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('a workspace admin adds a staker code; the config keeps other keys and members can list it', async () => {
  const { router, audits, config, cleanup } = await fixture()
  try {
    const staker = Wallet.createRandom()
    const added = await call(router, 'POST', '/workspaces/ws_team/free-tier', admin, { code: await codeFor(staker, TEAM_BUYER) }) as FreeTierSharing
    assert.deepEqual(added, { buyer: TEAM_BUYER, stakers: [{ staker: staker.address, expiresAt: LATER, expired: false }] })
    const saved = await config()
    assert.equal(saved.buyer.maxPricing.defaults.inputUsdPerMillion, 5)
    assert.equal(saved.buyer.freeTierDelegations[0].buyer.toLowerCase(), TEAM_BUYER)
    assert.deepEqual(await call(router, 'GET', '/workspaces/ws_team/free-tier', member), added)
    assert.deepEqual(audits, ['free_tier.add'])

    const removed = await call(router, 'DELETE', `/workspaces/ws_team/free-tier/${staker.address}`, admin) as FreeTierSharing
    assert.deepEqual(removed.stakers, [])
  } finally {
    await cleanup()
  }
})

test('codes for another buyer, expired or malformed are refused, and members cannot add', async () => {
  const { router, config, cleanup } = await fixture()
  try {
    const staker = Wallet.createRandom()
    await rejectsWith(call(router, 'POST', '/workspaces/ws_team/free-tier', admin, { code: await codeFor(staker, OTHER_BUYER) }), 400, 'invalid_code')
    await rejectsWith(call(router, 'POST', '/workspaces/ws_team/free-tier', admin, { code: await codeFor(staker, TEAM_BUYER, NOW / 1000 - 1) }), 400, 'invalid_code')
    await rejectsWith(call(router, 'POST', '/workspaces/ws_team/free-tier', admin, { code: 'hello' }), 400, 'invalid_code')
    await assert.rejects(call(router, 'POST', '/workspaces/ws_team/free-tier', member, { code: await codeFor(staker, TEAM_BUYER) }))
    assert.equal((await config()).buyer.freeTierDelegations, undefined)
  } finally {
    await cleanup()
  }
})

async function signedFor(staker: Pick<Wallet, 'address' | 'signTypedData'>, buyer: string, expiresAt: number, chainId: number) {
  const unsigned = { staker: staker.address, buyer, expiresAt }
  const signature = await staker.signTypedData(makeFreeTierDelegationDomain(chainId), FREE_TIER_DELEGATION_TYPES, freeTierDelegationMessage(unsigned))
  return { ...unsigned, signature }
}

test('members read the stake each pool counts, from the buyer and every staker with a code sellers accept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-free-tier-stake-'))
  const configPath = join(dir, 'config.json')
  const liveWallet = Wallet.createRandom()
  const live = liveWallet.address.toLowerCase()
  // Left out: an expired code, and one signed for another network (say, saved before switching chains).
  await writeFile(configPath, JSON.stringify({ buyer: { freeTierDelegations: [
    await signedFor(liveWallet, TEAM_BUYER, LATER, CHAIN.evmChainId),
    await signedFor(Wallet.createRandom(), TEAM_BUYER, NOW / 1000 - 1, CHAIN.evmChainId),
    await signedFor(Wallet.createRandom(), TEAM_BUYER, LATER, 84532),
  ] } }))
  const store = {
    getWorkspace: (id: string) => (id === 'ws_team' ? { id, name: 'Team', buyerIdentity: 'team-a' } : null),
    getMember: () => null, getKey: () => null, getAdminToken: () => null, recordAudit: () => {},
  }
  const reads: unknown[] = []
  const view = { currentEpoch: 10, genesis: 1000, epochDuration: 604_800, pools: [] }
  let chain = { ...CHAIN, rpcUrl: 'https://rpc-one.example' }
  const router = new ConsoleRouter()
  registerFreeTierRoutes(router, { ...fakeDeps(store, () => NOW), configPath }, {
    access: fakeRequireWorkspaceAccess,
    walletAddress: async () => TEAM_BUYER,
    resolveChain: async () => chain,
    readStake: async (on, buyer, stakers) => { reads.push([on.rpcUrl, buyer, stakers]); return view },
  })
  try {
    assert.deepEqual(await call(router, 'GET', '/workspaces/ws_team/free-tier/stake', member), { buyer: TEAM_BUYER, ...view })
    await call(router, 'GET', '/workspaces/ws_team/free-tier/stake', member)
    // Only the live code for this chain counts, and the second read is served from the cache.
    assert.deepEqual(reads, [['https://rpc-one.example', TEAM_BUYER, [{ staker: live, expiresAt: LATER }]]])
    // New RPC settings while the gateway runs: the next read uses them, not the cached result.
    chain = { ...CHAIN, rpcUrl: 'https://rpc-two.example' }
    await call(router, 'GET', '/workspaces/ws_team/free-tier/stake', member)
    assert.deepEqual(reads.map((entry) => (entry as unknown[])[0]), ['https://rpc-one.example', 'https://rpc-two.example'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
