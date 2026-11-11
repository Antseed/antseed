import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Interface, type AbstractProvider } from 'ethers'
import { BuyerChannelChainView, createChannelChainReader, type ChannelChainReader, type ChannelChainRow, type ChannelChainState } from './channel-chain.js'

const BUYER = `0x${'b1'.repeat(20)}`
const SELLER = `0x${'51'.repeat(20)}`
const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`
const T0 = 1_800_000_000_000

function row(n: number, status = 'active', extra: Partial<ChannelChainRow> = {}): ChannelChainRow {
  return { channelId: id(n), seller: SELLER, status, updatedAt: T0, deadline: 0, ...extra }
}

function open(deposit: bigint, settled = 0n, closeRequestedAt = 0n): ChannelChainState {
  return { status: 1, deposit, settled, closeRequestedAt }
}

const NONE: ChannelChainState = { status: 0, deposit: 0n, settled: 0n, closeRequestedAt: 0n }

/** A chain the test edits between reads, and a clock it moves. */
function harness(chain: { reserved: bigint | null; channels: Record<string, ChannelChainState> }) {
  const clock = { now: T0 }
  const reads: string[][] = []
  let fail = false
  const read: ChannelChainReader = async (_buyer, rows) => {
    reads.push(rows.map((entry) => entry.channelId))
    if (fail) throw new Error('rpc down')
    return {
      reserved: chain.reserved,
      channels: new Map(rows.flatMap((entry) => (chain.channels[entry.channelId] ? [[entry.channelId, chain.channels[entry.channelId]!] as const] : []))),
    }
  }
  return {
    view: new BuyerChannelChainView({ read, now: () => clock.now }),
    chain,
    reads,
    advance: (ms: number) => { clock.now += ms },
    failing: (value: boolean) => { fail = value },
  }
}

test('a row the store retired reports the open record the chain holds for it', async () => {
  for (const status of ['ghost', 'settled', 'timeout']) {
    const h = harness({ reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n, 250_000n) } })
    // Retired a minute before the read.
    const { channels, summary } = await h.view.describe(BUYER, [row(1, status, { updatedAt: T0 - 60_000 })])
    assert.deepEqual(channels.get(id(1)), { status: 1, deposit: '1000000', settled: '250000', closeRequestedAt: 0, readAt: T0 }, status)
    assert.equal(summary.heldByChannels, '750000')
  }
})

test('a retired row is not reported open from a read that started before its retirement, or within 30 s after it', async () => {
  const h = harness({ reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } })
  // Read while the store still called it active.
  assert.equal((await h.view.describe(BUYER, [row(1, 'active')])).channels.get(id(1))?.status, 1)
  // The seller closes and the buyer retires the row 5 s later: the cached read predates it.
  h.advance(5_000)
  const retired = row(1, 'settled', { updatedAt: T0 + 5_000 })
  assert.equal((await h.view.describe(BUYER, [retired])).channels.has(id(1)), false)
  // A lagging endpoint still answers Active 25 s after the retirement.
  h.advance(25_000)
  assert.equal((await h.view.describe(BUYER, [retired])).channels.has(id(1)), false)
  // 30 s after the retirement and later, an Active answer is believed.
  h.advance(25_000)
  assert.equal((await h.view.describe(BUYER, [retired])).channels.get(id(1))?.status, 1)
  // The reserve it holds counted throughout: the store has a row for it.
  assert.equal((await h.view.describe(BUYER, [retired])).summary.unaccountedReserved, '0')
})

test('a channel the chain showed settled or timed out is final and never read again', async () => {
  const h = harness({ reserved: 0n, channels: { [id(1)]: { status: 2, deposit: 1_000_000n, settled: 400_000n, closeRequestedAt: 0n }, [id(2)]: { status: 3, deposit: 1_000_000n, settled: 0n, closeRequestedAt: 5n } } })
  const rows = [row(1), row(2, 'ghost')]
  await h.view.describe(BUYER, rows)
  h.advance(60_000)
  const { channels, summary } = await h.view.describe(BUYER, rows)
  assert.deepEqual(h.reads, [[id(1), id(2)], []])
  assert.equal(channels.get(id(1))?.status, 2)
  assert.equal(channels.get(id(2))?.status, 3)
  // A closed channel's deposit minus settled was released, not held.
  assert.equal(summary.heldByChannels, '0')
})

test('a channel with no record is read until no reserve the buyer signed can still land', async () => {
  const deadline = T0 / 1000 + 600
  const h = harness({ reserved: 0n, channels: { [id(1)]: NONE } })
  const rows = [row(1, 'ghost', { deadline })]
  await h.view.describe(BUYER, rows)
  // Past the deadline but inside the hour's margin: still read.
  h.advance(900_000)
  await h.view.describe(BUYER, rows)
  // A read taken an hour past the deadline settles it.
  h.advance(3_600_000)
  await h.view.describe(BUYER, rows)
  h.advance(60_000)
  const { channels } = await h.view.describe(BUYER, rows)
  assert.deepEqual(h.reads, [[id(1)], [id(1)], [id(1)], []])
  assert.equal(channels.get(id(1))?.status, 0)
  // A later ReserveAuth for the same channel reopens the question.
  h.advance(60_000)
  await h.view.describe(BUYER, [row(1, 'active', { deadline: deadline + 7_200 })])
  assert.deepEqual(h.reads.at(-1), [id(1)])
})

test('reads are shared for 20 s, and fresh always reads again', async () => {
  const h = harness({ reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } })
  const rows = [row(1)]
  await h.view.describe(BUYER, rows)
  h.advance(19_000)
  await h.view.describe(BUYER, rows)
  assert.equal(h.reads.length, 1)
  h.advance(2_000)
  await h.view.describe(BUYER, rows)
  assert.equal(h.reads.length, 2)
  // The caller just requested a close: the read from a second ago does not show it.
  h.advance(1_000)
  h.chain.channels[id(1)] = open(1_000_000n, 0n, 1_800_000_000n)
  const closing = await h.view.describe(BUYER, rows, { fresh: true })
  assert.equal(h.reads.length, 3)
  assert.equal(closing.channels.get(id(1))?.closeRequestedAt, 1_800_000_000)
  // A new channel is a new question, whatever the cache holds.
  h.chain.channels[id(2)] = open(500_000n)
  const { channels } = await h.view.describe(BUYER, [...rows, row(2)])
  assert.equal(h.reads.length, 4)
  assert.equal(channels.get(id(2))?.deposit, '500000')
  // invalidate() makes the next call read, e.g. after a close.
  h.view.invalidate(BUYER)
  await h.view.describe(BUYER, [...rows, row(2)])
  assert.equal(h.reads.length, 5)
})

test('a failed read keeps the last records, and a lagging no-record answer does not erase one', async () => {
  const h = harness({ reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n, 100_000n) } })
  const rows = [row(1)]
  await h.view.describe(BUYER, rows)
  h.advance(30_000)
  h.failing(true)
  const down = await h.view.describe(BUYER, rows)
  assert.deepEqual(down.channels.get(id(1)), { status: 1, deposit: '1000000', settled: '100000', closeRequestedAt: 0, readAt: T0 })
  h.failing(false)
  h.advance(30_000)
  h.chain.channels[id(1)] = NONE
  const lagging = await h.view.describe(BUYER, rows)
  assert.equal(lagging.channels.get(id(1))?.status, 1)
})

test('the reserve no stored channel accounts for is reported', async () => {
  // Two open channels explain 1.75 of a 4.69 reserve: 2.94 is held by a channel with no row.
  const h = harness({ reserved: 4_690_000n, channels: { [id(1)]: open(1_000_000n, 250_000n), [id(2)]: open(1_000_000n) } })
  const { summary } = await h.view.describe(BUYER, [row(1), row(2, 'ghost', { updatedAt: T0 - 60_000 })])
  assert.deepEqual(summary, { readAt: T0, reserved: '4690000', heldByChannels: '1750000', unaccountedReserved: '2940000' })
  // Found by reading twice: a single difference can be a top-up landing between the reads.
  assert.equal(h.reads.length, 2)
})

test('a reserve the stored channels explain in full leaves nothing unaccounted', async () => {
  const h = harness({ reserved: 1_750_000n, channels: { [id(1)]: open(1_000_000n, 250_000n), [id(2)]: open(1_000_000n) } })
  const { summary } = await h.view.describe(BUYER, [row(1), row(2)])
  assert.equal(summary.unaccountedReserved, '0')
  assert.equal(h.reads.length, 1)
  // A reserve read before a close and channels read after it: smaller than the channels hold, never negative.
  const lagging = harness({ reserved: 500_000n, channels: { [id(1)]: open(1_000_000n) } })
  assert.equal((await lagging.view.describe(BUYER, [row(1)])).summary.unaccountedReserved, '0')
})

test('a difference that the second read does not confirm is not reported', async () => {
  const chain = { reserved: 2_000_000n as bigint | null, channels: { [id(1)]: open(1_000_000n) } }
  let calls = 0
  const view = new BuyerChannelChainView({
    now: () => T0,
    read: async (_buyer, rows) => {
      calls += 1
      // The top-up that raised the reserve shows on the channel from the second read on.
      if (calls === 2) chain.channels[id(1)] = open(2_000_000n)
      return { reserved: chain.reserved, channels: new Map(rows.map((entry) => [entry.channelId, chain.channels[entry.channelId]!])) }
    },
  })
  const { summary } = await view.describe(BUYER, [row(1)])
  assert.equal(calls, 2)
  assert.equal(summary.unaccountedReserved, '0')
  assert.equal(summary.heldByChannels, '2000000')
})

test('a difference the second read could not check is not reported, and the channels it read still are', async () => {
  let calls = 0
  const view = new BuyerChannelChainView({
    now: () => T0,
    read: async (_buyer, rows) => {
      calls += 1
      if (calls === 2) throw new Error('rpc down')
      return { reserved: 2_000_000n, channels: new Map(rows.map((entry) => [entry.channelId, open(1_000_000n)])) }
    },
  })
  const { channels, summary } = await view.describe(BUYER, [row(1)])
  assert.equal(summary.unaccountedReserved, null)
  assert.equal(summary.reserved, '2000000')
  assert.equal(channels.get(id(1))?.status, 1)
})

test('the unaccounted reserve is not judged when the reserve or a channel is unread', async () => {
  const noReserve = harness({ reserved: null, channels: { [id(1)]: open(1_000_000n) } })
  assert.equal((await noReserve.view.describe(BUYER, [row(1)])).summary.unaccountedReserved, null)
  // Channel 2 is missing from the batch: its reserve cannot be told from an unknown channel's.
  const missed = harness({ reserved: 2_000_000n, channels: { [id(1)]: open(1_000_000n) } })
  const { channels, summary } = await missed.view.describe(BUYER, [row(1), row(2)])
  assert.equal(summary.unaccountedReserved, null)
  assert.equal(summary.reserved, '2000000')
  assert.equal(channels.has(id(2)), false)
  const down = harness({ reserved: 2_000_000n, channels: {} })
  down.failing(true)
  assert.deepEqual((await down.view.describe(BUYER, [row(1)])).summary, { readAt: null, reserved: null, heldByChannels: '0', unaccountedReserved: null })
})

test('a fresh read never joins one that began earlier, and the earlier one cannot overwrite it', async () => {
  const releases: Array<() => void> = []
  const clock = { now: T0 }
  let state = open(1_000_000n)
  const view = new BuyerChannelChainView({
    now: () => clock.now,
    read: async (_buyer, rows) => {
      const seen = state
      await new Promise<void>((resolve) => { releases.push(resolve) })
      return { reserved: 1_000_000n, channels: new Map(rows.map((entry) => [entry.channelId, seen])) }
    },
  })
  // A poll starts a read; the close lands; the explicit refresh starts its own.
  const poll = view.describe(BUYER, [row(1)])
  clock.now += 1_000
  state = open(1_000_000n, 0n, 1_800_000_000n)
  const refresh = view.describe(BUYER, [row(1)], { fresh: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(releases.length, 2)
  // The refresh answers first, the earlier poll after it.
  releases[1]!()
  assert.equal((await refresh).channels.get(id(1))?.closeRequestedAt, 1_800_000_000)
  releases[0]!()
  await poll
  assert.equal((await view.describe(BUYER, [row(1)])).channels.get(id(1))?.closeRequestedAt, 1_800_000_000)
})

test('a slow chain does not hold the answer: earlier records come back and the read finishes behind it', async () => {
  let release: (() => void) | undefined
  let slow = false
  const state = open(1_000_000n)
  const clock = { now: T0 }
  const view = new BuyerChannelChainView({
    now: () => clock.now,
    read: async (_buyer, rows) => {
      if (slow) await new Promise<void>((resolve) => { release = resolve })
      return { reserved: 1_000_000n, channels: new Map(rows.map((entry) => [entry.channelId, state])) }
    },
  })
  await view.describe(BUYER, [row(1)])
  clock.now += 30_000
  slow = true
  const answered = await view.describe(BUYER, [row(1)], { maxWaitMs: 20 })
  assert.equal(answered.channels.get(id(1))?.readAt, T0)
  assert.equal(answered.summary.readAt, null)
  release?.()
  slow = false
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await view.describe(BUYER, [row(1)])).channels.get(id(1))?.readAt, T0 + 30_000)
})

test('the chain reader reads the buyer\'s reserve and its channels, and survives an unreadable reserve', async () => {
  const CHANNELS = `0x${'c1'.repeat(20)}`
  const DEPOSITS = `0x${'d1'.repeat(20)}`
  const channelsAbi = new Interface(['function channels(bytes32) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)'])
  const depositsAbi = new Interface(['function getBuyerBalance(address buyer) view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)'])
  /** A chain without Multicall3, so every read is a plain eth_call this fake answers. */
  const provider = (reserveFails: boolean) => ({
    getCode: async () => '0x',
    call: async ({ to, data }: { to: string; data: string }) => {
      if (to.toLowerCase() === DEPOSITS) {
        if (reserveFails) throw new Error('rpc timeout')
        const [buyer] = depositsAbi.decodeFunctionData('getBuyerBalance', data)
        assert.equal((buyer as string).toLowerCase(), BUYER)
        return depositsAbi.encodeFunctionResult('getBuyerBalance', [5_000_000n, 1_750_000n, 0n])
      }
      // The seller is asked whether it is a facade for another channels contract: a plain seller answers nothing.
      if (to.toLowerCase() === SELLER) return '0x'
      assert.equal(to.toLowerCase(), CHANNELS)
      const [channelId] = channelsAbi.decodeFunctionData('channels', data)
      const record = channelId === id(1) ? { deposit: 1_000_000n, settled: 250_000n, status: 1 } : { deposit: 0n, settled: 0n, status: 0 }
      return channelsAbi.encodeFunctionResult('channels', [BUYER, SELLER, record.deposit, record.settled, `0x${'00'.repeat(32)}`, 0n, 0n, 0n, record.status])
    },
  }) as unknown as AbstractProvider
  const rows = [{ channelId: id(1), seller: SELLER }, { channelId: id(2), seller: SELLER }]

  const read = await createChannelChainReader({ provider: provider(false), channelsAddress: CHANNELS, depositsAddress: DEPOSITS })(BUYER, rows)
  assert.equal(read.reserved, 1_750_000n)
  assert.deepEqual(read.channels.get(id(1)), { status: 1, deposit: 1_000_000n, settled: 250_000n, closeRequestedAt: 0n })
  assert.equal(read.channels.get(id(2))?.status, 0)

  const withoutReserve = await createChannelChainReader({ provider: provider(true), channelsAddress: CHANNELS, depositsAddress: DEPOSITS })(BUYER, rows)
  assert.equal(withoutReserve.reserved, null)
  assert.equal(withoutReserve.channels.get(id(1))?.status, 1)
})
