import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { AntseedNode, ChannelStore, type StoredChannel } from '@antseed/node'
import type { ChannelChainRead, ChannelChainReader, ChannelChainState } from '@antseed/node/payments'
import { BuyerProxy, type BuyerBalanceReader } from './buyer-proxy.js'
import { GATEWAY_CONTROL_HEADER, GATEWAY_CONTROL_SECRET_FILE } from '../routing-policy/policy.js'

// The recorder is loaded at run time, so this file also runs, unchanged,
// against a buyer from before it existed, and shows what that buyer reports.
const payments = await import('@antseed/node/payments') as Partial<typeof import('@antseed/node/payments')>

const SECRET = 'e'.repeat(64)
const BUYER = '0x' + 'b1'.repeat(20)
const SELLER = '0x' + '51'.repeat(20)
const PEER = '52'.repeat(20)
const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`
const open = (deposit: bigint, settled = 0n): ChannelChainState => ({ status: 1, deposit, settled, closeRequestedAt: 0n })

function channel(n: number, overrides: Partial<StoredChannel> = {}): StoredChannel {
  const now = Date.now()
  return {
    sessionId: id(n), peerId: PEER, role: 'buyer', sellerEvmAddr: SELLER, buyerEvmAddr: BUYER, nonce: n, authMax: '0',
    deadline: Math.floor(now / 1000) + 3600, previousSessionId: '0x' + '00'.repeat(32), previousConsumption: '0', tokensDelivered: '0',
    requestCount: 1, reservedAt: now, settledAt: null, settledAmount: null, status: 'active', createdAt: now + n, updatedAt: now,
    latestBuyerSig: null, latestSpendingAuthSig: null, latestMetadata: null,
    ...overrides,
  } as StoredChannel
}

/**
 * A buyer as `buyer start` runs it, with a real channel store and node, its
 * routes on a loopback port, and a chain the test edits. Each chain read
 * takes `readDelayMs`, as a real RPC does; `advance` moves the recorder's clock.
 */
async function startBuyer(t: TestContext, chain: { block: number; reserved: bigint; channels: Record<string, ChannelChainState> }, options: { readDelayMs?: number; hangAfterFirstRead?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-channel-records-'))
  await mkdir(join(dataDir, 'gateway'), { recursive: true })
  await writeFile(join(dataDir, GATEWAY_CONTROL_SECRET_FILE), `${SECRET}\n`, { mode: 0o600 })
  const store = new ChannelStore(dataDir)
  const node = new AntseedNode({ role: 'buyer' })
  Object.assign(node, {
    _identity: { wallet: { address: BUYER } },
    _channelStore: store,
    _buyerPaymentManager: { getReserveCeiling: () => null, getActiveSession: () => null },
  })
  let reads = 0
  const read: ChannelChainReader = async (_buyer, rows): Promise<ChannelChainRead> => {
    reads += 1
    if (options.hangAfterFirstRead && reads > 1) await new Promise(() => {})
    if (options.readDelayMs) await new Promise((resolve) => setTimeout(resolve, options.readDelayMs))
    return {
      block: chain.block,
      readAt: Date.now(),
      reserved: chain.reserved,
      channels: new Map(rows.map((row) => [row.channelId, chain.channels[row.channelId] ?? { status: 0, deposit: 0n, settled: 0n, closeRequestedAt: 0n }])),
    }
  }
  let offsetMs = 0
  const Recorder = payments.BuyerChannelChainRecorder
  const channelChain = Recorder ? new Recorder({ store, read, now: () => Date.now() + offsetMs }) : undefined
  const balanceReader: BuyerBalanceReader = {
    getBuyerBalance: async () => ({ available: 4_000_000n, reserved: chain.reserved }),
    getUSDCBalance: async () => 0n,
    getBuyerCreditLimit: async () => 10_000_000n,
    getOperator: async () => '0x0000000000000000000000000000000000000000',
  }
  const proxy = new BuyerProxy({ adaptiveRouting: { spreadTolerance: 0, explorationRate: 0 }, port: 0, dataDir, node, balanceReader, ...(channelChain ? { channelChain } : {}) })
  // No seller network in this test: peers come from nowhere.
  ;(proxy as any)._getPeers = async () => []
  ;(proxy as any)._cachedPeers = []
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  ;(proxy as any)._mergeStateFile = async () => {}
  const server = (proxy as any)._server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await (proxy as any)._conversations.flush()
    store.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = async (path: string): Promise<Record<string, any>> => (await fetch(`${url}${path}`, { headers: { [GATEWAY_CONTROL_HEADER]: SECRET } })).json() as Promise<Record<string, any>>
  return { store, node, channelChain, url, get, reads: () => reads, advance: (ms: number) => { offsetMs += ms } }
}

test('a channel the buyer retired while the chain holds it open counts its signed spend in the buyer\'s balances (#1463)', async (t) => {
  // The seller answered that the channel is exhausted: the buyer gave up on the session with 0.40 signed.
  const chain = { block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } }
  const buyer = await startBuyer(t, chain)
  buyer.store.upsertChannel(channel(1, { status: 'ghost', authMax: '400000' }))
  // The buyer's chain read, as its timer runs it.
  await buyer.channelChain?.refresh(BUYER)
  const balances = await buyer.get('/_antseed/balances')
  assert.equal(balances['reserved'], '1.000000')
  assert.deepEqual(balances['channels'], { pending: '0.400000', held: '1.000000', unaccountedReserved: '0.000000', stale: false })
  const listed = (await buyer.get('/_antseed/channels?all=1'))['channels'] as Array<Record<string, any>>
  assert.deepEqual(listed.map((row) => [row['channelId'], row['status'], row['onChain']?.['status'], row['onChain']?.['unsettled']]), [[id(1), 'ghost', 1, '400000']])
})

test('the channel list asked for right after a seller closed a channel shows it ended (#1463)', async (t) => {
  const chain = { block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } }
  const buyer = await startBuyer(t, chain, { readDelayMs: 200 })
  buyer.store.upsertChannel(channel(1, { authMax: '250000' }))
  await buyer.channelChain?.refresh(BUYER)
  // The seller settles 0.25, closes the channel and answers once its transaction is mined.
  ;(buyer.node as any).requestChannelClose = async () => {
    chain.block = 11
    chain.reserved = 0n
    chain.channels[id(1)] = { status: 2, deposit: 1_000_000n, settled: 250_000n, closeRequestedAt: 0n }
    buyer.store.updateChannelStatus(id(1), 'settled', '250000')
    return { version: 1, channelId: id(1), status: 'closed', txHash: '0x' + '77'.repeat(32), finalAmount: '250000' }
  }
  const closed = await fetch(`${buyer.url}/_antseed/channels/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [GATEWAY_CONTROL_HEADER]: SECRET },
    body: JSON.stringify({ peerId: PEER, channelId: id(1) }),
  })
  assert.equal(closed.status, 200)
  // What the console asks for next: the chain's record already says settled, so no "Close on chain" is offered.
  const listed = (await buyer.get('/_antseed/channels?all=1'))['channels'] as Array<Record<string, any>>
  assert.deepEqual(listed.map((row) => [row['status'], row['onChain']?.['status'], row['onChain']?.['block']]), [['settled', 2, 11]])
  // The reserve read with it says the same: nothing is left unaccounted.
  assert.deepEqual((await buyer.get('/_antseed/balances'))['channels'], { pending: '0.000000', held: '0.000000', unaccountedReserved: '0.000000', stale: false })
})

test('balances?fresh=1 answers within 2 s while the chain read is slow, inside the gateway\'s 3 s', async (t) => {
  const chain = { block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } }
  const buyer = await startBuyer(t, chain, { hangAfterFirstRead: true })
  buyer.store.upsertChannel(channel(1, { authMax: '100000' }))
  await buyer.channelChain?.refresh(BUYER)
  // Past the floor, so the fresh read starts (and hangs).
  buyer.advance(5_000)
  const started = Date.now()
  const balances = await buyer.get('/_antseed/balances?fresh=1')
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2_600, `answered after ${elapsed} ms`)
  // The stored figures, from the read before.
  assert.equal(balances['channels']?.['pending'], '0.100000')
})

test('balances?fresh=1 starts a channel read at most once per 5 s per wallet; the console\'s channels?all=1&fresh=1 always reads', async (t) => {
  const chain = { block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } }
  const buyer = await startBuyer(t, chain)
  buyer.store.upsertChannel(channel(1, { authMax: '100000' }))
  await buyer.channelChain?.refresh(BUYER)
  // A key holder polling /v1/key?fresh=1 right after the buyer's own read: no new read.
  for (let n = 0; n < 3; n += 1) await buyer.get('/_antseed/balances?fresh=1')
  assert.equal(buyer.reads(), 1)
  // Once the floor has passed, the next one reads; the one after it does not.
  buyer.advance(5_000)
  await buyer.get('/_antseed/balances?fresh=1')
  await buyer.get('/_antseed/balances?fresh=1')
  assert.equal(buyer.reads(), 2)
  // Right after a transaction the console asks for the channels: that read is never skipped.
  await buyer.get('/_antseed/channels?all=1&fresh=1')
  assert.equal(buyer.reads(), 3)
})
