import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Wallet, type AbstractSigner } from 'ethers'
import type { AntsChainConfig, AntsContext } from '@antseed/ants'
import { decodeInvite, encodeInvite, readReferralState, recoverInviter, referralStateMtimeMs, signInvite, type InvitePreview } from '@antseed/node'
import { buyerIdentityDir } from '../../../buyer-identities/store.js'
import { ConsoleError, ConsoleRouter } from '../router.js'
import { addActiveMember, memberPrincipal, tempDataDir, testDeps } from '../test-support.js'
import type { Builders, CreatedInvite, Referrals } from '../types.js'
import { call, startFakeBuyer, type FakeBuyer } from './network-test-helpers.js'
import { registerReferralRoutes } from './referrals.js'

// Obvious fakes: fixed test keys and addresses, never real ones.
const TEAM_WALLET = new Wallet(`0x${'22'.repeat(32)}`)
const SOLO_WALLET = new Wallet(`0x${'44'.repeat(32)}`)
const INVITER = new Wallet(`0x${'33'.repeat(32)}`)
const OWNER = `0x${'0a'.repeat(20)}`
const REFERRED = `0x${'0c'.repeat(20)}`
const CHAIN = {
  chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:8545',
  referralsAddress: `0x${'a1'.repeat(20)}`, clientRewardsAddress: `0x${'b2'.repeat(20)}`,
  clientAgentIds: { cli: 1 }, explorerApiUrl: 'https://explorer.example.test',
} as unknown as AntsChainConfig
const DOMAIN = { chainId: 31337, referralsAddress: CHAIN.referralsAddress! }
const TEAM_SCOPE = { ...DOMAIN, wallet: TEAM_WALLET.address }
/** The same referrals contract and RPC, but no explorer to index it. */
const NO_EXPLORER_CHAIN = { ...CHAIN, explorerApiUrl: undefined } as unknown as AntsChainConfig

let preview: InvitePreview = { referrer: INVITER.address, failure: null }
const registered = new Set([1, 7])
let explorerDown = false

/** A context whose indexer, referrals client and identity registry are in-memory fakes. */
function fakeContext(chain: AntsChainConfig, address: string, signer?: AbstractSigner): AntsContext {
  return {
    chain,
    address,
    buyerAddress: address,
    signer,
    requireSigner: () => { if (!signer) throw new Error('no signer'); return signer },
    indexer: () => ({
      referrer: async () => {
        if (explorerDown) throw new Error('Explorer unreachable: fetch failed')
        return {
        available: true, currentEpoch: 20, referredCount: 1, payable: '2500000000000000000', claimableEpochs: [17, 18],
        invites: { epoch: 20, quota: 3, used: 0, usedIndices: [] },
        buyers: [{ buyer: REFERRED, boundEpoch: 12, points: '9000', ants: '1000000000000000000', pendingPoints: '0' }],
        }
      },
      referralBinding: async () => {
        if (explorerDown) throw new Error('Explorer unreachable: fetch failed')
        return {
          available: true, referrer: null, boundEpoch: null, refereeWindowEnd: null, refereePayable: '0', refereeClaimableEpochs: [], currentEpoch: 20, canBind: true,
        }
      },
      builders: async (ids: number[]) => {
        if (explorerDown) throw new Error('Explorer unreachable: fetch failed')
        return {
          available: true,
          agents: ids.map((agentId) => ({ agentId, points: '10', pendingPoints: '0', claimed: '0', payable: '4000000000000000000', claimableEpochs: [18] })),
        }
      },
    }),
    referrals: () => ({
      currentEpoch: async () => 20,
      inviteQuota: async () => 3,
      inviteUsed: async () => false,
      referredCount: async () => 1,
      previewInvite: async () => preview,
    }),
    clientRewards: () => ({}),
    identity: () => ({
      getAgentWallet: async (id: number) => {
        if (!registered.has(id)) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' })
        return OWNER
      },
    }),
  } as unknown as AntsContext
}

const env = tempDataDir()
const { store, dir } = env
const team = store.createWorkspace({ name: 'Team', buyerIdentity: 'team-a', walletAddress: TEAM_WALLET.address })
const wsAdmin = addActiveMember(store, 'Workspace admin', { workspaces: [{ workspaceId: team.id, role: 'admin' }] })
const plainMember = addActiveMember(store, 'Member', { workspaces: [{ workspaceId: team.id, role: 'member' }] })
const orgAdmin = addActiveMember(store, 'Org admin', { orgRole: 'admin' })
const solo = store.createWorkspace({ name: 'Solo', buyerIdentity: 'solo', walletAddress: SOLO_WALLET.address })
const soloAdmin = addActiveMember(store, 'Solo admin', { workspaces: [{ workspaceId: solo.id, role: 'admin' }] })
const configPath = join(dir, 'config.json')
writeFileSync(configPath, JSON.stringify({ buyer: { proxyPort: 8377 } }))
const restarts: string[] = []
let buyer: FakeBuyer
const router = new ConsoleRouter()
const noExplorerRouter = new ConsoleRouter()

before(async () => {
  buyer = await startFakeBuyer({ 'POST /_antseed/restart': () => { restarts.push('restart'); return { body: { ok: true } } } })
  registerReferralRoutes(router, testDeps(store, dir, { configPath }), {
    buyer: buyer.client,
    resolveChain: async () => CHAIN,
    context: fakeContext,
    walletAddress: async (name) => (name === 'team-a' ? TEAM_WALLET.address : null),
    loadSigner: async (name) => (name === 'team-a' ? TEAM_WALLET : null),
    env: {},
  })
  registerReferralRoutes(noExplorerRouter, testDeps(store, dir, { configPath }), {
    buyer: buyer.client,
    resolveChain: async () => NO_EXPLORER_CHAIN,
    context: (chain, address, signer) => ({ ...fakeContext(chain, address, signer), indexer: () => null }) as AntsContext,
    walletAddress: async (name) => (name === 'solo' ? SOLO_WALLET.address : null),
    loadSigner: async (name) => (name === 'solo' ? SOLO_WALLET : null),
    env: {},
  })
})

after(async () => {
  await buyer.close()
  env.cleanup()
})

const asAdmin = () => memberPrincipal(store, wsAdmin.id)

async function rejects(promise: Promise<unknown>, status: number, code: string): Promise<ConsoleError> {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof ConsoleError, `expected ConsoleError, got ${String(err)}`)
    assert.equal(err.status, status)
    assert.equal(err.code, code)
    return err
  }
  assert.fail(`expected ${status} ${code}`)
}

test('workspace admins read referrals with ANTS in display units; plain members cannot', async () => {
  const view = await call(router, 'GET', `/workspaces/${team.id}/referrals`, asAdmin()) as Referrals
  assert.equal(view.available, true)
  assert.equal(view.invitesAvailable, true)
  assert.equal(view.address, TEAM_WALLET.address)
  assert.equal(view.payableAnts, '2.5')
  assert.deepEqual(view.claimableEpochs, [17, 18])
  assert.deepEqual(view.invites, { epoch: 20, quota: 3, used: 0, left: 3 })
  assert.equal(view.buyers[0]!.ants, '1')
  assert.equal(view.referee.state, 'none')
  assert.equal(view.referee.canRedeem, true)
  await rejects(call(router, 'GET', `/workspaces/${team.id}/referrals`, memberPrincipal(store, plainMember.id)), 403, 'forbidden')
})

test('an invite is signed by the workspace wallet and remembered in its own referral.json', async () => {
  const created = await call(router, 'POST', `/workspaces/${team.id}/referrals/invites`, asAdmin()) as CreatedInvite
  assert.equal(recoverInviter(decodeInvite(created.invite), DOMAIN), TEAM_WALLET.address)
  assert.equal(created.epoch, 20)
  assert.equal(created.expiresEpoch, 24)
  const state = await readReferralState(buyerIdentityDir(dir, 'team-a'), TEAM_SCOPE)
  assert.deepEqual(state?.issued, { epoch: 20, indices: [created.index] })
  // Nothing was written to the default wallet's file.
  assert.equal(await referralStateMtimeMs(dir), null)
  const view = await call(router, 'GET', `/workspaces/${team.id}/referrals`, asAdmin()) as Referrals
  assert.equal(view.invites?.left, 2)
})

test('redeeming checks the contract preview, then the workspace wallet carries the invite until cleared', async () => {
  const invite = encodeInvite(await signInvite(INVITER, DOMAIN, 20, 1))
  preview = { referrer: INVITER.address, failure: 'NotNewBuyer' }
  const refused = await rejects(call(router, 'POST', `/workspaces/${team.id}/referrals/redeem`, asAdmin(), { invite }), 400, 'invalid_invite')
  assert.match(refused.message, /new/i)

  preview = { referrer: INVITER.address, failure: null }
  const view = await call(router, 'POST', `/workspaces/${team.id}/referrals/redeem`, asAdmin(), { invite: `https://antseed.com/invite/${invite}` }) as Referrals
  assert.equal(view.referee.state, 'invited')
  assert.equal(view.referee.pendingInvite, invite)
  assert.equal(view.referee.referrer, INVITER.address)
  assert.equal(view.referee.inviteExpiresEpoch, 24)
  assert.equal((await readReferralState(buyerIdentityDir(dir, 'team-a'), TEAM_SCOPE))?.state, 'invited')

  const cleared = await call(router, 'DELETE', `/workspaces/${team.id}/referrals/redeem`, asAdmin()) as Referrals
  assert.equal(cleared.referee.state, 'none')
  await rejects(call(router, 'POST', `/workspaces/${team.id}/referrals/redeem`, asAdmin(), { invite: 'nonsense' }), 400, 'invalid_invite')
})

test('without an explorer, invites are still created, redeemed and removed; only the indexed statistics are unknown', async () => {
  const principal = memberPrincipal(store, soloAdmin.id)
  const view = await call(noExplorerRouter, 'GET', `/workspaces/${solo.id}/referrals`, principal) as Referrals
  assert.equal(view.available, false)
  assert.equal(view.invitesAvailable, true)
  // This week's allowance is read from the referrals contract.
  assert.deepEqual(view.invites, { epoch: 20, quota: 3, used: 0, left: 3 })
  assert.deepEqual(view.buyers, [])
  assert.equal(view.referee.state, 'none')
  assert.equal(view.referee.canRedeem, null)

  // Epoch and quota come from the referrals contract over RPC.
  const created = await call(noExplorerRouter, 'POST', `/workspaces/${solo.id}/referrals/invites`, principal) as CreatedInvite
  assert.equal(recoverInviter(decodeInvite(created.invite), DOMAIN), SOLO_WALLET.address)
  assert.equal(created.epoch, 20)
  assert.equal(created.quota, 3)

  preview = { referrer: INVITER.address, failure: null }
  const invite = encodeInvite(await signInvite(INVITER, DOMAIN, 20, 2))
  const redeemed = await call(noExplorerRouter, 'POST', `/workspaces/${solo.id}/referrals/redeem`, principal, { invite }) as Referrals
  assert.equal(redeemed.referee.state, 'invited')
  assert.equal(redeemed.referee.referrer, INVITER.address)

  const cleared = await call(noExplorerRouter, 'DELETE', `/workspaces/${solo.id}/referrals/redeem`, principal) as Referrals
  assert.equal(cleared.referee.state, 'none')
})

test('an unreachable explorer degrades the view; invites and their changes still succeed', async () => {
  explorerDown = true
  try {
    const view = await call(router, 'GET', `/workspaces/${team.id}/referrals?fresh=1`, asAdmin()) as Referrals
    assert.equal(view.available, false)
    assert.equal(view.invitesAvailable, true)
    assert.deepEqual(view.buyers, [])

    const created = await call(router, 'POST', `/workspaces/${team.id}/referrals/invites`, asAdmin()) as CreatedInvite
    assert.equal(created.epoch, 20)

    preview = { referrer: INVITER.address, failure: null }
    const invite = encodeInvite(await signInvite(INVITER, DOMAIN, 20, 2))
    const redeemed = await call(router, 'POST', `/workspaces/${team.id}/referrals/redeem`, asAdmin(), { invite }) as Referrals
    assert.equal(redeemed.referee.state, 'invited')
    const cleared = await call(router, 'DELETE', `/workspaces/${team.id}/referrals/redeem`, asAdmin()) as Referrals
    assert.equal(cleared.referee.state, 'none')
  } finally {
    explorerDown = false
  }
})

test('builders: org admins see the effective agent, set their own (restarting the buyer) and cannot set an unregistered one', async () => {
  await rejects(call(router, 'GET', '/builders', asAdmin()), 403, 'forbidden')
  const principal = memberPrincipal(store, orgAdmin.id)

  const initial = await call(router, 'GET', '/builders', principal) as Builders
  assert.equal(initial.agentId, null)
  assert.deepEqual(initial.effective, { agentId: 1, source: 'default' })
  assert.equal(initial.agent?.owner, OWNER)
  assert.equal(initial.agent?.payableAnts, '4')

  await rejects(call(router, 'PUT', '/builders', principal, { agentId: 42 }), 400, 'agent_not_registered')
  await rejects(call(router, 'PUT', '/builders', principal, { agentId: -3 }), 400, 'invalid_agent')

  const saved = await call(router, 'PUT', '/builders', principal, { agentId: 7 }) as Builders
  assert.deepEqual(saved.effective, { agentId: 7, source: 'config' })
  assert.equal(saved.restartRequired, undefined)
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).buyer.clientAgentId, 7)
  assert.equal(restarts.length, 1)

  // Unchanged: no config write, no restart.
  await call(router, 'PUT', '/builders', principal, { agentId: 7 })
  assert.equal(restarts.length, 1)

  const cleared = await call(router, 'PUT', '/builders', principal, { agentId: null }) as Builders
  assert.equal(cleared.agentId, null)
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).buyer.clientAgentId, undefined)
  assert.equal(restarts.length, 2)
})

test('builders: saving an agent succeeds while the explorer is down, with its rewards unknown', async () => {
  const principal = memberPrincipal(store, orgAdmin.id)
  explorerDown = true
  try {
    const saved = await call(router, 'PUT', '/builders', principal, { agentId: 7 }) as Builders
    assert.deepEqual(saved.effective, { agentId: 7, source: 'config' })
    assert.equal(saved.available, false)
    assert.equal(saved.agent, null)
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).buyer.clientAgentId, 7)
    await rejects(call(router, 'GET', '/builders', principal), 502, 'builders_unavailable')
  } finally {
    explorerDown = false
  }
})
