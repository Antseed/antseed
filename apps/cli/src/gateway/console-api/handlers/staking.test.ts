import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAntsServer, type AntsChainConfig, type AntsServerOptions } from '@antseed/ants'
import { ConsoleRouter } from '../router.js'
import { call, fakeDeps, fakeRequireWorkspaceAccess, memberPrincipal, rejectsWith } from './network-test-helpers.js'
import { registerStakingRoutes } from './staking.js'

// Obvious fakes only; no test reaches the chain.
const TEAM_WALLET = `0x${'0a'.repeat(20)}`
const CHAIN = { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1' } as AntsChainConfig

const owner = memberPrincipal('m_owner', {}, 'owner')
const ali = memberPrincipal('m_ali', { ws_team: 'admin' })
const sam = memberPrincipal('m_sam', { ws_team: 'member' })

function fixture(options: { address?: string | null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'antseed-staking-'))
  const audits: Array<{ action: string; details?: Record<string, unknown> }> = []
  const created: AntsServerOptions[] = []
  let now = 1_700_000_000_000
  const store = {
    getWorkspace: (id: string) => (id === 'ws_team' ? { id, buyerIdentity: 'team-a' } : null),
    getMember: () => null,
    getKey: () => null,
    getAdminToken: () => null,
    recordAudit: (entry: { action: string; details?: Record<string, unknown> }) => { audits.push(entry) },
  }
  const router = new ConsoleRouter()
  registerStakingRoutes(router, { ...fakeDeps(store, () => now), dataDir }, {
    requireWorkspaceAccess: fakeRequireWorkspaceAccess,
    resolveChain: async () => CHAIN,
    workspaceAddress: async (identity) => (identity === 'team-a' && options.address !== null ? options.address ?? TEAM_WALLET : null),
    createServer: (serverOptions) => {
      created.push(serverOptions)
      return createAntsServer(serverOptions)
    },
  })
  return {
    router,
    audits,
    created,
    advance: (ms: number) => { now += ms },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

test('staking serves the dashboard API for the workspace buyer, unchanged', async () => {
  const f = fixture()
  try {
    const config = await call(f.router, 'GET', '/workspaces/ws_team/ants/config', owner) as { status: number; body: { ok: boolean; data: Record<string, unknown> } }
    assert.equal(config.status, 200)
    assert.equal(config.body.ok, true)
    assert.equal(config.body.data['buyerAddress'], TEAM_WALLET)
    assert.equal(config.body.data['browserWallet'], true)
    assert.equal(config.body.data['readOnly'], true, 'no wallet is connected yet')
    // The gateway's data directory stays on the gateway.
    assert.equal(config.body.data['dataDir'], null)
    const options = f.created[0]!
    assert.equal(options.serveWeb, false)
    assert.equal(options.selectRpc, false)
    assert.equal(options.stateKey, 'console-m_owner-ws_team')
  } finally {
    f.cleanup()
  }
})

test('staking keeps one dashboard session per console session and workspace', async () => {
  const f = fixture()
  try {
    await call(f.router, 'GET', '/workspaces/ws_team/ants/config', owner)
    await call(f.router, 'GET', '/workspaces/ws_team/ants/jobs', owner)
    assert.equal(f.created.length, 1)
    await call(f.router, 'GET', '/workspaces/ws_team/ants/config', ali)
    assert.equal(f.created.length, 2, 'another member gets their own wallet session')
  } finally {
    f.cleanup()
  }
})

test('staking is for workspace admins, like the Rewards page', async () => {
  const f = fixture()
  try {
    await rejectsWith(call(f.router, 'GET', '/workspaces/ws_team/ants/config', sam), 403)
    await rejectsWith(call(f.router, 'GET', '/workspaces/ws_team/ants/config', { kind: 'token', tokenId: 't1', scope: 'admin' }), 403, 'forbidden')
    await rejectsWith(call(f.router, 'GET', '/workspaces/ws_none/ants/config', owner), 404, 'not_found')
    assert.equal(f.created.length, 0)
  } finally {
    f.cleanup()
  }
})

test('staking explains a workspace without a wallet, and retries on the next call', async () => {
  const f = fixture({ address: null })
  try {
    await rejectsWith(call(f.router, 'GET', '/workspaces/ws_team/ants/config', owner), 409, 'wallet_unavailable')
    await rejectsWith(call(f.router, 'GET', '/workspaces/ws_team/ants/config', owner), 409, 'wallet_unavailable')
  } finally {
    f.cleanup()
  }
})

test('staking passes dashboard errors through and audits only started actions', async () => {
  const f = fixture()
  try {
    // No wallet connected: the dashboard refuses the action itself.
    const refused = await call(f.router, 'POST', '/workspaces/ws_team/ants/positions/stake', owner, { agentId: 1, amount: '1' }) as { status: number; body: { ok: boolean; error: string } }
    assert.equal(refused.status, 403)
    assert.equal(refused.body.ok, false)
    assert.match(refused.body.error, /read-only/)
    // A wallet on another chain is rejected with the dashboard's message.
    const wrongChain = await call(f.router, 'POST', '/workspaces/ws_team/ants/wallet', owner, { address: TEAM_WALLET, chainId: 1 }) as { status: number; body: { error: string } }
    assert.equal(wrongChain.status, 400)
    assert.match(wrongChain.body.error, /Switch your wallet/)
    assert.deepEqual(f.audits, [])
  } finally {
    f.cleanup()
  }
})

test('the console router matches a trailing wildcard on one or more segments', () => {
  const router = new ConsoleRouter()
  router.add('GET', '/workspaces/:id/ants/*', async () => null)
  assert.deepEqual(router.match('GET', '/workspaces/ws_1/ants/verification/proofs/0xab')?.params, { id: 'ws_1', '*': 'verification/proofs/0xab' })
  assert.equal(router.match('GET', '/workspaces/ws_1/ants'), null)
  assert.equal(router.match('GET', '/workspaces/ws_1/other/x'), null)
})
