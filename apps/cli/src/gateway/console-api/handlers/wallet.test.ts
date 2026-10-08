import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Wallet, verifyMessage, verifyTypedData } from 'ethers'
import { makeDepositsDomain, SET_OPERATOR_TYPES } from '@antseed/node'
import type { AntsChainConfig, RewardsView } from '@antseed/ants'
import { ConsoleError, ConsoleRouter, type Principal } from '../router.js'
import type { Channel, ChainInfo, DepositWatch, Rewards, Wallet as ConsoleWallet } from '../types.js'
import {
  call,
  fakeDeps,
  fakeRequireWorkspaceAccess,
  memberPrincipal,
  rejectsWith,
  startFakeBuyer,
  lastRequest,
  type FakeBuyer,
} from './network-test-helpers.js'
import { registerWalletRoutes, type WalletRouteOverrides } from './wallet.js'
import { buildCardLink, cardAmountString, cardLinkMessage, DEFAULT_ANTSEED_PAY_URL } from './wallet-card-link.js'
import { baseUnitsToUsdc, chainInfo, decimalUsdc, mapBalances, mapChannel, mapDepositWatch } from './wallet-mapping.js'

// Obvious fakes: fixed test keys and peer ids, never real ones.
const DEFAULT_WALLET = new Wallet(`0x${'11'.repeat(32)}`)
const TEAM_WALLET = new Wallet(`0x${'22'.repeat(32)}`)
const PEER_A = 'aa'.repeat(20)
const OPERATOR = `0x${'0b'.repeat(20)}`

/**
 * Verbatim copy of the desktop's link construction as it was before both
 * moved to the shared `@antseed/payments/card-link` builder
 * (`payments:open-card-provider`), kept as the frozen reference the shared
 * builder must match byte for byte.
 */
async function desktopReferenceLink(providerUrl: string, providerId: string, identity: { wallet: Wallet }, amountUsdc: string): Promise<string> {
  const payPageProvider = (id: string): 'crossmint' | 'stripe' | null => id === 'antseed-pay' ? 'crossmint' : id === 'antseed-pay-stripe' ? 'stripe' : null
  const amount = Number(amountUsdc)
  const hasAmount = Number.isFinite(amount) && amount > 0
  let template = providerUrl.split('{address}').join(identity.wallet.address)
  if (hasAmount) template = template.split('{amount}').join(String(amount))
  const parsed = new URL(template)
  const payPage = payPageProvider(providerId)
  if (payPage) {
    const cur = 'USD'
    const amountStr = hasAmount ? String(amount) : ''
    const message = [
      'AntSeed Pay',
      `address: ${identity.wallet.address.toLowerCase()}`,
      `currency: ${cur}`,
      `amount: ${amountStr}`,
    ].join('\n')
    parsed.searchParams.set('address', identity.wallet.address)
    parsed.searchParams.set('cur', cur)
    if (amountStr) parsed.searchParams.set('amount', amountStr)
    parsed.searchParams.set('sig', await identity.wallet.signMessage(message))
    parsed.searchParams.set('provider', payPage)
  }
  return parsed.toString()
}

const WORKSPACES: Record<string, { id: string; buyerIdentity: string; walletAddress: string | null }> = {
  ws_default: { id: 'ws_default', buyerIdentity: 'default', walletAddress: DEFAULT_WALLET.address },
  ws_team: { id: 'ws_team', buyerIdentity: 'team-a', walletAddress: TEAM_WALLET.address },
}
const MEMBERS: Record<string, { id: string; label: string; orgRole: 'owner' | 'admin' | 'member'; status: 'active' }> = {
  m_member: { id: 'm_member', label: 'Member', orgRole: 'member', status: 'active' },
  m_admin: { id: 'm_admin', label: 'Workspace admin', orgRole: 'member', status: 'active' },
  m_outsider: { id: 'm_outsider', label: 'Outsider', orgRole: 'member', status: 'active' },
  m_orgadmin: { id: 'm_orgadmin', label: 'Org admin', orgRole: 'admin', status: 'active' },
  m_owner: { id: 'm_owner', label: 'Owner', orgRole: 'owner', status: 'active' },
}
const audits: Array<{ action: string; details?: Record<string, unknown> }> = []
const store = {
  getWorkspace: (id: string) => WORKSPACES[id] ?? null,
  getMember: (id: string) => MEMBERS[id] ?? null,
  getKey: () => null,
  getAdminToken: () => null,
  recordAudit: (entry: { action: string; details?: Record<string, unknown> }) => { audits.push(entry) },
  setWalletAddress: (buyerIdentity: string, address: string | null) => { cacheWrites.push({ buyerIdentity, address }) },
}
const cacheWrites: Array<{ buyerIdentity: string; address: string | null }> = []

const member = memberPrincipal('m_member', { ws_default: 'member', ws_team: 'member' })
const wsAdmin = memberPrincipal('m_admin', { ws_default: 'admin', ws_team: 'admin' })
const outsider = memberPrincipal('m_outsider', {})
const orgAdmin = memberPrincipal('m_orgadmin', {}, 'admin')
const owner = memberPrincipal('m_owner', {}, 'owner')

let buyer: FakeBuyer
let closeResult: Record<string, unknown> = { version: 1, channelId: '0xchannel', status: 'closed' }

before(async () => {
  buyer = await startFakeBuyer({
    'GET /_antseed/balances': (req) => {
      const identity = new URL(req.url, 'http://x').searchParams.get('identity')
      const wallet = identity === 'team-a' ? TEAM_WALLET : DEFAULT_WALLET
      return { body: { address: wallet.address, available: '12.5', reserved: '1.25', walletUsdc: '0', creditLimit: '100', operator: OPERATOR } }
    },
    'GET /_antseed/deposits/status': () => ({
      body: {
        ok: true,
        watcher: true,
        reason: null,
        status: { mode: 'idle', address: DEFAULT_WALLET.address, usdcBalance: '0', sweepInFlight: false, lastEvent: { seq: 1, phase: 'credited', txHash: '0xfeed', at: 1 } },
      },
    }),
    'POST /_antseed/deposits/watch': (req) => ({
      body: { ok: true, status: { mode: (req.body as { mode: string }).mode, address: DEFAULT_WALLET.address, usdcBalance: '0', sweepInFlight: false, lastEvent: null } },
    }),
    'GET /_antseed/channels': () => ({
      body: {
        ok: true,
        channels: [
          { channelId: '0xchannel', peerId: PEER_A, seller: OPERATOR, reserveCeiling: '5000000', cumulativeSigned: '1250000', reservedAt: 1_700_000_000_000, status: 'active', sellerDisplayName: ' Fake Seller ', cooperativeCloseSupported: true },
          { channelId: '0xold', peerId: PEER_A, reserveCeiling: null, cumulativeSigned: '42', reservedAt: 0, status: 'settled', sellerDisplayName: null, cooperativeCloseSupported: true },
          { peerId: PEER_A },
        ],
      },
    }),
    'POST /_antseed/channels/close': () => ({ body: { ok: true, result: closeResult } }),
  })
})

after(async () => {
  await buyer.close()
})

function setup(extra: WalletRouteOverrides = {}, now: () => number = () => 1_700_000_000_000): ConsoleRouter {
  const router = new ConsoleRouter()
  registerWalletRoutes(router, fakeDeps(store, now), {
    buyer: buyer.client,
    requireWorkspaceAccess: fakeRequireWorkspaceAccess,
    loadWallet: async (name) => (name === 'default' ? DEFAULT_WALLET : name === 'team-a' ? TEAM_WALLET : null),
    walletAddress: async (name) => (name === 'default' ? DEFAULT_WALLET.address : name === 'team-a' ? TEAM_WALLET.address : null),
    payBaseUrl: () => DEFAULT_ANTSEED_PAY_URL,
    ...extra,
  })
  return router
}

// ── Card link ────────────────────────────────────────────────────────────

test('card link message is the pay page wire format', () => {
  assert.equal(
    cardLinkMessage('0xAbCdEf0000000000000000000000000000000001', '10.5'),
    'AntSeed Pay\naddress: 0xabcdef0000000000000000000000000000000001\ncurrency: USD\namount: 10.5',
  )
})

test('card link is byte-identical to the desktop link for both providers', async () => {
  for (const [provider, providerId] of [['crossmint', 'antseed-pay'], ['stripe', 'antseed-pay-stripe']] as const) {
    for (const amount of ['10', '10.50', '25', '1.5']) {
      for (const base of [DEFAULT_ANTSEED_PAY_URL, 'http://localhost:3120/', 'https://pay.example.test/checkout?ref=gateway']) {
        const ours = await buildCardLink({ baseUrl: base, wallet: DEFAULT_WALLET, amountUsd: amount, provider })
        const desktop = await desktopReferenceLink(base, providerId, { wallet: DEFAULT_WALLET }, amount)
        assert.equal(ours, desktop, `${provider} ${amount} ${base}`)
      }
    }
  }
})

test('card link signature recovers to the workspace wallet', async () => {
  const url = new URL(await buildCardLink({ baseUrl: DEFAULT_ANTSEED_PAY_URL, wallet: TEAM_WALLET, amountUsd: 20, provider: 'crossmint' }))
  assert.equal(url.searchParams.get('address'), TEAM_WALLET.address)
  assert.equal(url.searchParams.get('amount'), '20')
  const signer = verifyMessage(cardLinkMessage(TEAM_WALLET.address, '20'), url.searchParams.get('sig')!)
  assert.equal(signer, TEAM_WALLET.address)
})

test('card amount bounds', () => {
  assert.equal(cardAmountString('10.50'), '10.5')
  assert.equal(cardAmountString(1), '1')
  assert.equal(cardAmountString(10_000), '10000')
  for (const bad of [0, -5, 0.5, 10_001, 'abc', '', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => cardAmountString(bad), Error, String(bad))
  }
})

test('card link refuses plain http to a non-loopback host', async () => {
  await assert.rejects(buildCardLink({ baseUrl: 'http://pay.example.test/', wallet: DEFAULT_WALLET, amountUsd: 10, provider: 'crossmint' }), /https/)
})

test('POST card-link signs with the workspace identity', async () => {
  const router = setup()
  const { url } = await call(router, 'POST', '/workspaces/ws_team/wallet/card-link', member, { amountUsd: 25, provider: 'stripe' }) as { url: string }
  assert.equal(url, await desktopReferenceLink(DEFAULT_ANTSEED_PAY_URL, 'antseed-pay-stripe', { wallet: TEAM_WALLET }, '25'))
})

test('POST card-link validates input and access', async () => {
  const router = setup()
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/wallet/card-link', member, { amountUsd: 0.25, provider: 'crossmint' }), 400, 'invalid_amount')
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/wallet/card-link', member, { amountUsd: 10, provider: 'paypal' }), 400, 'invalid_provider')
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/wallet/card-link', outsider, { amountUsd: 10, provider: 'crossmint' }), 403)
  const noKey = setup({ loadWallet: async () => null })
  await rejectsWith(call(noKey, 'POST', '/workspaces/ws_team/wallet/card-link', member, { amountUsd: 10, provider: 'crossmint' }), 409, 'wallet_unavailable')
  const locked = setup({ loadWallet: async () => { throw new Error('encrypted by the AI VPN') } })
  await rejectsWith(call(locked, 'POST', '/workspaces/ws_default/wallet/card-link', member, { amountUsd: 10, provider: 'crossmint' }), 409, 'wallet_unavailable')
})

// ── Balances & deposit watcher ───────────────────────────────────────────

test('balance mapping normalizes decimals and drops a zero operator', () => {
  assert.equal(decimalUsdc('12.5'), '12.500000')
  assert.equal(decimalUsdc(3), '3.000000')
  assert.equal(decimalUsdc('0.1234567'), '0.123456')
  assert.equal(decimalUsdc('garbage'), '0.000000')
  assert.equal(baseUnitsToUsdc('1500000'), '1.500000')
  assert.equal(baseUnitsToUsdc('123456789012345678901'), '123456789012345.678901')
  const mapped = mapBalances({ address: DEFAULT_WALLET.address, available: '1', reserved: 0, walletUsdc: '2.25', creditLimit: null, operator: `0x${'0'.repeat(40)}` })
  assert.deepEqual(mapped, { address: DEFAULT_WALLET.address, available: '1.000000', reserved: '0.000000', walletUsdc: '2.250000', creditLimit: null, operator: null })
})

test('deposit watch mapping', () => {
  assert.deepEqual(mapDepositWatch({ watcher: false, reason: 'payments-disabled', status: null }, DEFAULT_WALLET.address), { mode: 'off', status: 'payments-disabled', lastTxHash: null })
  const active = { watcher: true, status: { mode: 'active', address: DEFAULT_WALLET.address, sweepInFlight: true, lastEvent: null } }
  assert.deepEqual(mapDepositWatch(active, DEFAULT_WALLET.address.toLowerCase()), { mode: 'active', status: 'sweeping', lastTxHash: null })
  assert.equal(mapDepositWatch(active, TEAM_WALLET.address).status, 'not-watched')
})

test('GET wallet merges balances and the deposit watcher', async () => {
  const router = setup()
  const wallet = await call(router, 'GET', '/workspaces/ws_default/wallet', member) as ConsoleWallet
  assert.deepEqual(wallet, {
    buyerIdentity: 'default',
    address: DEFAULT_WALLET.address,
    available: '12.500000',
    reserved: '1.250000',
    walletUsdc: '0.000000',
    creditLimit: '100.000000',
    operator: OPERATOR,
    deposit: { mode: 'background', status: 'credited', lastTxHash: '0xfeed' },
  })
  const team = await call(router, 'GET', '/workspaces/ws_team/wallet', member) as ConsoleWallet
  assert.equal(team.address, TEAM_WALLET.address)
  assert.deepEqual(team.deposit, { mode: 'off', status: 'not-watched', lastTxHash: null })
  assert.ok(buyer.requests.some((req) => req.url === '/_antseed/balances?identity=team-a'))
})

test('GET wallet checks workspace access and existence', async () => {
  const router = setup()
  await rejectsWith(call(router, 'GET', '/workspaces/ws_team/wallet', outsider), 403)
  await rejectsWith(call(router, 'GET', '/workspaces/ws_team/wallet', null), 401)
  await rejectsWith(call(router, 'GET', '/workspaces/ws_missing/wallet', memberPrincipal('m_owner', {}, 'owner')), 404, 'not_found')
})

test('GET wallet reports an unreachable buyer', async () => {
  const router = setup({ buyer: async () => { throw new Error('ECONNREFUSED') } })
  await rejectsWith(call(router, 'GET', '/workspaces/ws_default/wallet', member), 502, 'buyer_unreachable')
})

test('POST wallet/watch drives the default watcher and refuses other wallets', async () => {
  const router = setup()
  const watch = await call(router, 'POST', '/workspaces/ws_default/wallet/watch', member, { mode: 'active' }) as DepositWatch
  assert.deepEqual(watch, { mode: 'active', status: 'watching', lastTxHash: null })
  const sent = lastRequest(buyer, (url) => url === '/_antseed/deposits/watch')
  assert.deepEqual(sent?.body, { mode: 'active', identity: 'default' })
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/wallet/watch', member, { mode: 'active' }), 409, 'watch_unavailable')
  await rejectsWith(call(router, 'POST', '/workspaces/ws_default/wallet/watch', member, { mode: 'turbo' }), 400, 'invalid_mode')
  await rejectsWith(call(router, 'POST', '/workspaces/ws_default/wallet/watch', outsider, { mode: 'active' }), 403)
})

// ── Channels ─────────────────────────────────────────────────────────────

test('channel mapping', () => {
  assert.equal(mapChannel({ peerId: PEER_A }), null)
  const mapped = mapChannel({ sessionId: '0xs', sellerPeerId: PEER_A, latestCumulativeAmount: '10', status: 'open', cooperativeCloseSupported: true })
  assert.deepEqual(mapped, { channelId: '0xs', peerId: PEER_A, sellerName: null, status: 'open', reserved: '0.000000', spent: '0.000010', openedAt: null, canCooperativeClose: true })
})

test('GET channels passes all=1 and the identity', async () => {
  const router = setup()
  const channels = await call(router, 'GET', '/workspaces/ws_team/channels?all=1', member) as Channel[]
  assert.ok(buyer.requests.some((req) => req.url === '/_antseed/channels?all=1&identity=team-a'))
  assert.deepEqual(channels, [
    { channelId: '0xchannel', peerId: PEER_A, sellerName: 'Fake Seller', status: 'active', reserved: '5.000000', spent: '1.250000', openedAt: 1_700_000_000_000, canCooperativeClose: true },
    { channelId: '0xold', peerId: PEER_A, sellerName: null, status: 'settled', reserved: '0.000000', spent: '0.000042', openedAt: null, canCooperativeClose: false },
  ])
  await call(router, 'GET', '/workspaces/ws_default/channels', member)
  assert.ok(buyer.requests.some((req) => req.url === '/_antseed/channels?identity=default'))
  await rejectsWith(call(router, 'GET', '/workspaces/ws_team/channels', outsider), 403)
})

test('POST channels/close needs an org admin', async () => {
  const router = setup()
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/channels/close', member, { peerId: PEER_A }), 403)
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/channels/close', wsAdmin, { peerId: PEER_A }), 403)
  audits.length = 0
  assert.deepEqual(await call(router, 'POST', '/workspaces/ws_team/channels/close', orgAdmin, { peerId: `0x${PEER_A.toUpperCase()}` }), { ok: true })
  assert.deepEqual(audits.map((entry) => entry.action), ['channel.close'])
  const sent = lastRequest(buyer, (url) => url === '/_antseed/channels/close')
  assert.deepEqual(sent?.body, { peerId: PEER_A, includeAuth: true, identity: 'team-a' })
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/channels/close', orgAdmin, { peerId: 'nope' }), 400, 'invalid_peer')
  closeResult = { version: 1, channelId: '0xchannel', status: 'rejected', code: 'busy', reason: 'seller busy' }
  try {
    await rejectsWith(call(router, 'POST', '/workspaces/ws_team/channels/close', orgAdmin, { peerId: PEER_A }), 409, 'close_rejected')
  } finally {
    closeResult = { version: 1, channelId: '0xchannel', status: 'closed' }
  }
})

// ── Rewards & chain ──────────────────────────────────────────────────────

const CHAIN: AntsChainConfig = {
  chainId: 'base-mainnet',
  evmChainId: 8453,
  rpcUrl: 'https://base.example-rpc.test/v2/SECRET-API-KEY',
  depositsContractAddress: `0x${'d1'.repeat(20)}`,
  channelsContractAddress: `0x${'c1'.repeat(20)}`,
  usdcContractAddress: `0x${'a1'.repeat(20)}`,
  usageRewardsAddress: `0x${'e1'.repeat(20)}`,
  explorerApiUrl: 'https://explorer.example.test',
}

function rewardsView(buyerTotal: string): RewardsView {
  return {
    currentEpoch: 9,
    firstRewardedEpoch: 3,
    staker: { total: '0', positions: [] },
    sellerUsage: { total: '0', agentId: 0, epochs: [], claimable: false },
    buyerUsage: {
      total: buyerTotal,
      epochs: [{ epoch: 7, amount: buyerTotal, claimed: false }, { epoch: 6, amount: '0', claimed: true }],
      operator: OPERATOR,
      claimable: false,
      recipient: OPERATOR,
    },
    legacy: { seller: '0', buyer: '500000000000000000', contract: null, buyerClaimable: false },
    locked: { locked: '0', claimable: '0', policy: null, pool: null },
    total: buyerTotal,
  }
}

test('GET rewards maps buyer rewards and caches them for 5 min, then refreshes in the background', async () => {
  let now = 1_700_000_000_000
  const reads: string[] = []
  const router = setup({
    resolveChain: async () => CHAIN,
    readRewards: async (_chain, address) => { reads.push(address); return rewardsView('2000000000000000000') },
  }, () => now)
  const first = await call(router, 'GET', '/workspaces/ws_team/rewards', member) as Rewards
  assert.deepEqual(first, {
    address: TEAM_WALLET.address,
    pendingAnts: '2.5',
    claimedAnts: '0',
    epochs: [{ epoch: 7, pendingAnts: '2', claimed: false }, { epoch: 6, pendingAnts: '0', claimed: true }],
    operator: OPERATOR,
  })
  now += 299_000
  await call(router, 'GET', '/workspaces/ws_team/rewards', member)
  assert.equal(reads.length, 1)
  now += 2_000
  // Expired: answered from the cache at once while it re-reads.
  assert.deepEqual(await call(router, 'GET', '/workspaces/ws_team/rewards', member), first)
  assert.equal(reads.length, 2)
  await new Promise((resolve) => setImmediate(resolve))
  await call(router, 'GET', '/workspaces/ws_default/rewards', member)
  assert.deepEqual(reads, [TEAM_WALLET.address, TEAM_WALLET.address, DEFAULT_WALLET.address])
  await rejectsWith(call(router, 'GET', '/workspaces/ws_team/rewards', outsider), 403)
})

test('GET rewards backs off after a failed read instead of retrying the chain on every request', async () => {
  let now = 1_700_000_000_000
  let calls = 0
  const router = setup({
    resolveChain: async () => CHAIN,
    readRewards: async () => { calls += 1; if (calls === 1) throw new Error('rpc down'); return rewardsView('0') },
  }, () => now)
  await rejectsWith(call(router, 'GET', '/workspaces/ws_team/rewards', member), 502, 'rewards_unavailable')
  await rejectsWith(call(router, 'GET', '/workspaces/ws_team/rewards', member), 502, 'rewards_unavailable')
  assert.equal(calls, 1)
  now += 30_000
  const rewards = await call(router, 'GET', '/workspaces/ws_team/rewards', member) as Rewards
  assert.equal(rewards.pendingAnts, '0.5')
  assert.equal(calls, 2)
})

test('GET rewards serves the last value marked stale when the chain cannot be read', async () => {
  let now = 1_700_000_000_000
  let fail = false
  const router = setup({
    resolveChain: async () => CHAIN,
    readRewards: async () => { if (fail) throw new Error('429'); return rewardsView('1000000000000000000') },
  }, () => now)
  const first = await call(router, 'GET', '/workspaces/ws_team/rewards', member) as Rewards
  assert.equal(first.stale, undefined)
  fail = true
  now += 11 * 60_000
  const stale = await call(router, 'GET', '/workspaces/ws_team/rewards', member) as Rewards
  assert.equal(stale.stale, true)
  assert.equal(stale.pendingAnts, first.pendingAnts)
})

test('GET chain lists contracts and never leaks the configured RPC URL', async () => {
  const router = setup({ resolveChain: async () => CHAIN })
  const chain = await call(router, 'GET', '/chain', member) as ChainInfo
  assert.equal(chain.chainId, 8453)
  assert.equal(chain.name, 'base-mainnet')
  assert.equal(chain.explorerUrl, 'https://basescan.org')
  assert.ok(!chain.rpcUrl.includes('SECRET'), chain.rpcUrl)
  assert.equal(chain.contracts['deposits'], CHAIN.depositsContractAddress)
  assert.equal(chain.contracts['channels'], CHAIN.channelsContractAddress)
  assert.equal(chain.contracts['usdc'], CHAIN.usdcContractAddress)
  assert.equal(chain.contracts['usageRewards'], CHAIN.usageRewardsAddress)
  assert.equal(chain.contracts['explorerApiUrl'], undefined)
})

test('GET chain never passes on a keyed RPC URL for an unknown chain', () => {
  const custom = { chainId: 'custom-chain', evmChainId: 999_999, rpcUrl: 'https://rpc.example.test/v2/SECRET', fallbackRpcUrls: ['https://public-rpc.example.test'] }
  assert.equal(chainInfo(custom as AntsChainConfig).rpcUrl, 'https://public-rpc.example.test')
  assert.equal(chainInfo({ ...custom, fallbackRpcUrls: [] } as AntsChainConfig).rpcUrl, '')
  assert.equal(chainInfo({ ...custom, rpcUrl: 'http://127.0.0.1:8545', fallbackRpcUrls: [] } as AntsChainConfig).rpcUrl, 'http://127.0.0.1:8545')
})

// ── Operator authorization ───────────────────────────────────────────────

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60_000
/** Owner signed in a minute ago with a passkey; OPERATOR is one of their wallets, added two days ago. */
const freshOwner: WalletRouteOverrides = {
  resolveChain: async () => CHAIN,
  readOperator: async () => null,
  sessionSignIn: (sessionId) => (sessionId === 'session-m_owner' ? { authenticatedAt: NOW - 60_000, credentialId: 'cred_passkey' } : null),
  memberWallets: (memberId) => (memberId === 'm_owner'
    ? { wallets: [{ id: 'cred_operator', address: OPERATOR.toLowerCase(), createdAt: NOW - 2 * DAY }], total: 2 }
    : { wallets: [], total: 0 }),
}

test('POST wallet/operator-auth signs SetOperator with the workspace wallet', async () => {
  const nonces: string[] = []
  const router = setup({ ...freshOwner, operatorNonce: async (_chain, buyerAddress) => { nonces.push(buyerAddress); return 3n } })
  audits.length = 0
  const auth = await call(router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: OPERATOR.toUpperCase().replace('0X', '0x') }) as { buyer: string; nonce: string; signature: string }
  assert.equal(auth.buyer, TEAM_WALLET.address)
  assert.equal(auth.nonce, '3')
  assert.deepEqual(nonces, [TEAM_WALLET.address])
  const signer = verifyTypedData(makeDepositsDomain(CHAIN.evmChainId, CHAIN.depositsContractAddress!), SET_OPERATOR_TYPES, { operator: OPERATOR, nonce: 3n }, auth.signature)
  assert.equal(signer, TEAM_WALLET.address)
  assert.deepEqual(audits.map((entry) => entry.action), ['wallet.operator_auth'])
  assert.equal(audits[0]!.details?.['nonce'], '3')
})

test('POST wallet/operator-auth is for a freshly signed-in owner only', async () => {
  const router = setup({ ...freshOwner, operatorNonce: async () => 0n })
  const path = '/workspaces/ws_team/wallet/operator-auth'
  // Workspace admins (who used to be allowed), org admins, members, tokens and key sessions are refused.
  await rejectsWith(call(router, 'POST', path, wsAdmin, { operator: OPERATOR }), 403, 'forbidden')
  await rejectsWith(call(router, 'POST', path, orgAdmin, { operator: OPERATOR }), 403, 'forbidden')
  await rejectsWith(call(router, 'POST', path, member, { operator: OPERATOR }), 403, 'forbidden')
  await rejectsWith(call(router, 'POST', path, { kind: 'token', tokenId: 'tok_1', scope: 'admin' }, { operator: OPERATOR }), 403, 'forbidden')
  await rejectsWith(call(router, 'POST', path, { kind: 'key', keyId: 'key_1', sessionId: 's' }, { operator: OPERATOR }), 403, 'forbidden')
  // The operator must be one of the owner's own wallets.
  audits.length = 0
  await rejectsWith(call(router, 'POST', path, owner, { operator: `0x${'0c'.repeat(20)}` }), 403, 'operator_not_yours')
  assert.deepEqual(audits.map((entry) => entry.action), ['wallet.operator_auth.denied'])
  // A sign-in older than five minutes needs a re-auth.
  const stale = setup({ ...freshOwner, operatorNonce: async () => 0n, sessionSignIn: () => ({ authenticatedAt: NOW - 6 * 60_000, credentialId: 'cred_passkey' }) })
  await rejectsWith(call(stale, 'POST', path, owner, { operator: OPERATOR }), 403, 'reauth_required')
  const unknownSession = setup({ ...freshOwner, operatorNonce: async () => 0n, sessionSignIn: () => null })
  await rejectsWith(call(unknownSession, 'POST', path, owner, { operator: OPERATOR }), 403, 'reauth_required')
  // A session from before sign-ins recorded their credential.
  const unknownCredential = setup({ ...freshOwner, operatorNonce: async () => 0n, sessionSignIn: () => ({ authenticatedAt: NOW - 60_000, credentialId: null }) })
  await rejectsWith(call(unknownCredential, 'POST', path, owner, { operator: OPERATOR }), 403, 'reauth_required')
  // Cloudflare Access principals can't confirm: they need a passkey/wallet session.
  await rejectsWith(call(router, 'POST', path, { ...(owner as Extract<Principal, { kind: 'member' }>), sessionId: 'cf-access:0123456789abcdef' }, { operator: OPERATOR }), 403, 'reauth_unavailable')
})

test('POST wallet/operator-auth refuses a wallet added less than 24 hours ago', async () => {
  const path = '/workspaces/ws_team/wallet/operator-auth'
  const wallets = (createdAt: number): WalletRouteOverrides['memberWallets'] => () => ({ wallets: [{ id: 'cred_operator', address: OPERATOR.toLowerCase(), createdAt }], total: 2 })
  audits.length = 0
  const tooNew = setup({ ...freshOwner, operatorNonce: async () => 0n, memberWallets: wallets(NOW - 2 * 60_000) })
  const refused = await call(tooNew, 'POST', path, owner, { operator: OPERATOR }).then(() => null, (error: unknown) => error as { status: number; code: string; message: string })
  assert.equal(refused?.status, 403)
  assert.equal(refused?.code, 'operator_too_new')
  assert.match(refused!.message, /24 hours/)
  assert.match(refused!.message, /about 24 hours/)
  assert.deepEqual(audits.map((entry) => entry.action), ['wallet.operator_auth.denied'])
  const almost = setup({ ...freshOwner, operatorNonce: async () => 0n, memberWallets: wallets(NOW - DAY + 30 * 60_000) })
  await rejectsWith(call(almost, 'POST', path, owner, { operator: OPERATOR }), 403, 'operator_too_new')
  const oldEnough = setup({ ...freshOwner, operatorNonce: async () => 0n, memberWallets: wallets(NOW - DAY) })
  assert.ok(await call(oldEnough, 'POST', path, owner, { operator: OPERATOR }))
})

test('POST wallet/operator-auth wants the re-auth done with another credential than the operator wallet', async () => {
  const path = '/workspaces/ws_team/wallet/operator-auth'
  const viaOperator: WalletRouteOverrides['sessionSignIn'] = () => ({ authenticatedAt: NOW - 60_000, credentialId: 'cred_operator' })
  const withOthers = setup({ ...freshOwner, operatorNonce: async () => 0n, sessionSignIn: viaOperator })
  await rejectsWith(call(withOthers, 'POST', path, owner, { operator: OPERATOR }), 403, 'reauth_other_credential')
  // The operator wallet is the owner's only sign-in method: the 24 h age is the safeguard.
  const onlyWallet = setup({
    ...freshOwner,
    operatorNonce: async () => 0n,
    sessionSignIn: viaOperator,
    memberWallets: () => ({ wallets: [{ id: 'cred_operator', address: OPERATOR.toLowerCase(), createdAt: NOW - 2 * DAY }], total: 1 }),
  })
  assert.ok(await call(onlyWallet, 'POST', path, owner, { operator: OPERATOR }))
})

test('POST wallet/operator-auth needs an address and a wallet key', async () => {
  const router = setup({ ...freshOwner, operatorNonce: async () => 0n })
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: 'nope' }), 400, 'invalid_operator')
  await rejectsWith(call(router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: `0x${'0'.repeat(40)}` }), 400, 'invalid_operator')
  const keyless = setup({ ...freshOwner, operatorNonce: async () => 0n, loadWallet: async () => null })
  await rejectsWith(call(keyless, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: OPERATOR }), 409, 'wallet_unavailable')
  const offline = setup({ ...freshOwner, operatorNonce: async () => { throw new Error('rpc down') } })
  await rejectsWith(call(offline, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: OPERATOR }), 502, 'chain_unavailable')
})

test('an operator change seen by sync drops cached rewards and asks the buyer to re-read its balances', async () => {
  let now = 1_700_000_000_000
  let operator: string | null = null
  let rewardReads = 0
  const router = setup({
    resolveChain: async () => CHAIN,
    readRewards: async () => { rewardReads += 1; return rewardsView('0') },
    readOperator: async () => operator,
  }, () => now)
  await call(router, 'GET', '/workspaces/ws_team/rewards', member)
  await call(router, 'GET', '/workspaces/ws_team/wallet/operator', member)
  await call(router, 'GET', '/workspaces/ws_team/rewards', member)
  assert.equal(rewardReads, 1)
  operator = OPERATOR
  now += 5_000
  await call(router, 'POST', '/workspaces/ws_team/wallet/operator/sync', member, {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(buyer.requests.some((req) => req.url === '/_antseed/balances?fresh=1&identity=team-a'))
  await call(router, 'GET', '/workspaces/ws_team/rewards', member)
  assert.equal(rewardReads, 2, 'rewards re-read with the new operator')
})

// ── The running buyer's wallet is the source of truth ───────────────────

/** What the running buyer pays from for `default`: another wallet than the cached one and than the key here. */
const LIVE_DEFAULT = new Wallet(`0x${'66'.repeat(32)}`)
const liveBuyer: WalletRouteOverrides = {
  walletAddress: undefined,
  buyerAddresses: async () => new Map([['default', LIVE_DEFAULT.address], ['team-a', TEAM_WALLET.address]]),
}

test('operator reads and rewards use the live buyer address, never the cached one', async () => {
  const operatorReads: string[] = []
  const rewardReads: string[] = []
  const router = setup({
    ...freshOwner,
    ...liveBuyer,
    readOperator: async (_chain, buyerAddress) => { operatorReads.push(buyerAddress); return null },
    readRewards: async (_chain, address) => { rewardReads.push(address); return rewardsView('0') },
  })
  cacheWrites.length = 0
  const state = await call(router, 'GET', '/workspaces/ws_default/wallet/operator', member) as { buyer: string }
  assert.equal(state.buyer, LIVE_DEFAULT.address)
  assert.deepEqual(operatorReads, [LIVE_DEFAULT.address])
  await call(router, 'GET', '/workspaces/ws_default/rewards', member)
  assert.deepEqual(rewardReads, [LIVE_DEFAULT.address])
  // The stale display cache (DEFAULT_WALLET) is corrected from the buyer.
  assert.deepEqual(cacheWrites, [{ buyerIdentity: 'default', address: LIVE_DEFAULT.address }])
})

test('signing is refused with wallet_mismatch when the key here is not the buyer\'s wallet', async () => {
  const router = setup({ ...freshOwner, ...liveBuyer, operatorNonce: async () => 0n })
  audits.length = 0
  let error: unknown
  try {
    await call(router, 'POST', '/workspaces/ws_default/wallet/operator-auth', owner, { operator: OPERATOR })
  } catch (err) {
    error = err
  }
  assert.ok(error instanceof ConsoleError)
  assert.equal(error.status, 409)
  assert.equal(error.code, 'wallet_mismatch')
  assert.deepEqual(error.details, { signingAddress: DEFAULT_WALLET.address, buyerAddress: LIVE_DEFAULT.address })
  assert.match(error.message, new RegExp(`${DEFAULT_WALLET.address}.*${LIVE_DEFAULT.address}`))
  assert.deepEqual(audits.map((entry) => entry.action), ['wallet.operator_auth.denied'])
  await rejectsWith(call(router, 'POST', '/workspaces/ws_default/wallet/card-link', member, { amountUsd: 10, provider: 'crossmint' }), 409, 'wallet_mismatch')
  // A key that matches the buyer still signs.
  const ok = await call(router, 'POST', '/workspaces/ws_team/wallet/operator-auth', owner, { operator: OPERATOR }) as { buyer: string }
  assert.equal(ok.buyer, TEAM_WALLET.address)
})
