/**
 * The buyer runs with ANTSEED_IDENTITY_HEX (the desktop app's wallet) while
 * the data dir's identity.key is another wallet. Its own file: the node's
 * loader takes the variable once per process.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Wallet, verifyMessage } from 'ethers'
import { buyerIdentityAddress, loadDefaultBuyerIdentity } from '../../buyer-identities/store.js'
import { exportGatewayBundle } from '../bundle.js'
import { ConsoleRouter } from '../console-api/router.js'
import { call, fakeDeps, fakeRequireWorkspaceAccess, memberPrincipal, rejectsWith } from '../console-api/handlers/network-test-helpers.js'
import { registerWalletRoutes } from '../console-api/handlers/wallet.js'
import { cardLinkMessage } from '../console-api/handlers/wallet-card-link.js'
import { GatewayStore } from '../store.js'
import { resolveIdentityAddress } from './wallet-address.js'
import { withWallet } from './workspaces.js'

// Obvious fakes: fixed test keys.
const DISK_KEY = '77'.repeat(32)
const ENV_KEY = '88'.repeat(32)
const DISK_WALLET = new Wallet(`0x${DISK_KEY}`).address
const ENV_WALLET = new Wallet(`0x${ENV_KEY}`).address
const OTHER_WALLET = new Wallet(`0x${'99'.repeat(32)}`).address

process.env['ANTSEED_IDENTITY_HEX'] = `0x${ENV_KEY}`

let dataDir: string

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-wallet-env-'))
  writeFileSync(join(dataDir, 'identity.key'), DISK_KEY)
})

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

test('the default identity is loaded as the buyer loads it: ANTSEED_IDENTITY_HEX over identity.key', async () => {
  const loaded = await loadDefaultBuyerIdentity(dataDir)
  assert.equal(loaded.identity?.wallet.address, ENV_WALLET)
  assert.equal(loaded.fromEnv, true)
  // Still the same key once the node's loader has taken the variable out of the environment.
  assert.equal(process.env['ANTSEED_IDENTITY_HEX'], undefined)
  assert.equal(await buyerIdentityAddress(dataDir, 'default'), ENV_WALLET)
})

test('buyer unreachable: the fallback honours the env key and caches it, not identity.key', async () => {
  const resolved = await resolveIdentityAddress(dataDir, async () => null, 'default')
  assert.deepEqual(resolved, { address: ENV_WALLET, source: 'disk' })
  const store = new GatewayStore(dataDir)
  try {
    const workspace = await withWallet({ store, dataDir, buyerAddresses: async () => null }, store.defaultWorkspace())
    assert.equal(workspace.walletAddress, ENV_WALLET)
    assert.equal(store.defaultWorkspace().walletAddress, ENV_WALLET)
  } finally {
    store.close()
  }
})

test('console signing loads the env key and refuses when the buyer pays from another wallet', async () => {
  const workspaces: Record<string, { id: string; buyerIdentity: string; walletAddress: string | null }> = {
    ws_default: { id: 'ws_default', buyerIdentity: 'default', walletAddress: DISK_WALLET },
  }
  const store = {
    getWorkspace: (id: string) => workspaces[id] ?? null,
    getMember: () => null,
    getKey: () => null,
    getAdminToken: () => null,
    recordAudit: () => {},
    setWalletAddress: () => {},
  }
  const member = memberPrincipal('m_member', { ws_default: 'member' })
  const router = (live: string) => {
    const r = new ConsoleRouter()
    registerWalletRoutes(r, { ...fakeDeps(store), dataDir }, {
      requireWorkspaceAccess: fakeRequireWorkspaceAccess,
      buyerAddresses: async () => new Map([['default', live]]),
      payBaseUrl: () => 'https://pay.example.test',
    })
    return r
  }
  const { url } = await call(router(ENV_WALLET), 'POST', '/workspaces/ws_default/wallet/card-link', member, { amountUsd: 10, provider: 'crossmint' }) as { url: string }
  const params = new URL(url).searchParams
  assert.equal(params.get('address'), ENV_WALLET)
  assert.equal(verifyMessage(cardLinkMessage(ENV_WALLET, '10'), params.get('sig')!), ENV_WALLET)
  await rejectsWith(call(router(OTHER_WALLET), 'POST', '/workspaces/ws_default/wallet/card-link', member, { amountUsd: 10, provider: 'crossmint' }), 409, 'wallet_mismatch')
})

test('the export bundle carries the env key and refuses a key the buyer does not use', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'antseed-wallet-env-out-'))
  try {
    new GatewayStore(dataDir).close()
    const options = {
      dataDir,
      configPath: join(dataDir, 'config.json'),
      password: 'correct horse battery staple',
      cliVersion: 'test',
      scryptParams: { N: 1024, r: 8, p: 1 },
    }
    const result = await exportGatewayBundle({ ...options, outFile: join(outDir, 'ok.bundle'), buyerAddresses: async () => new Map([['default', ENV_WALLET]]) })
    assert.equal(result.summary.wallets.find((wallet) => wallet.name === 'default')?.address, ENV_WALLET)
    assert.ok(result.warnings.some((warning) => warning.includes('ANTSEED_IDENTITY_HEX')))
    await assert.rejects(
      exportGatewayBundle({ ...options, outFile: join(outDir, 'bad.bundle'), buyerAddresses: async () => new Map([['default', OTHER_WALLET]]) }),
      new RegExp(`${ENV_WALLET}.*${OTHER_WALLET}`),
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
