import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';
import {
  BuyerChannelChainRecorder,
  type ChannelChainRead,
  type ChannelChainReader,
  type ChannelChainState,
} from '../src/payments/channel-chain-record.js';

const BUYER = '0x' + 'cc'.repeat(20);
const OTHER_BUYER = '0x' + 'dd'.repeat(20);
const NO_CHANNELS_BUYER = '0x' + 'ee'.repeat(20);
const SELLER = '0x' + 'bb'.repeat(20);
const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const NOW = 1_800_000_000_000;
const NOW_SECS = NOW / 1000;
const DAY_SECS = 24 * 60 * 60;

function channel(n: number, overrides: Partial<StoredChannel> = {}): StoredChannel {
  return {
    sessionId: id(n),
    peerId: `peer-${n}`,
    role: CHANNEL_ROLE.BUYER,
    sellerEvmAddr: SELLER,
    buyerEvmAddr: BUYER,
    nonce: n,
    authMax: '0',
    deadline: NOW_SECS + 3600,
    previousSessionId: '0x' + '00'.repeat(32),
    previousConsumption: '0',
    tokensDelivered: '0',
    requestCount: 0,
    reservedAt: NOW,
    settledAt: null,
    settledAmount: null,
    status: CHANNEL_STATUS.ACTIVE,
    createdAt: NOW + n,
    updatedAt: NOW,
    ...overrides,
  };
}

const open = (deposit: bigint, settled = 0n): ChannelChainState => ({ status: 1, deposit, settled, closeRequestedAt: 0n });
const NONE: ChannelChainState = { status: 0, deposit: 0n, settled: 0n, closeRequestedAt: 0n };
const SETTLED = (settled: bigint): ChannelChainState => ({ status: 2, deposit: settled, settled, closeRequestedAt: 0n });

/**
 * A chain the test edits and a clock it moves; each read is answered at the
 * chain's block, and recorded. `reservedOf` gives a buyer its own reserve.
 */
function fakeChain(chain: { block: number; reserved: bigint | null; channels: Record<string, ChannelChainState>; reservedOf?: Record<string, bigint> }, clock: { now: number } = { now: NOW }) {
  const reads: Array<{ buyer: string; ids: string[] }> = [];
  const read: ChannelChainReader = async (buyer, rows): Promise<ChannelChainRead> => {
    reads.push({ buyer, ids: rows.map((row) => row.channelId) });
    return {
      block: chain.block,
      readAt: clock.now,
      reserved: chain.reservedOf?.[buyer] ?? chain.reserved,
      channels: new Map(rows.map((row) => [row.channelId, chain.channels[row.channelId] ?? NONE])),
    };
  };
  return { chain, clock, reads, read };
}

describe('the buyer\'s channel recorder (#1463)', () => {
  let dir: string;
  let store: ChannelStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'channel-chain-recorder-'));
    store = new ChannelStore(dir);
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('a top-up\'s deadline, not the first ReserveAuth\'s, says whether a reserve can still land', () => {
    it('counts spend signed past the deposit while a top-up the buyer signed can still land', async () => {
      // The first ReserveAuth expired two days ago; the top-up signed for this session is good for another hour.
      store.upsertChannel(channel(1, { authMax: '1500000', deadline: NOW_SECS - 2 * DAY_SECS, latestReserveDeadline: NOW_SECS + 3600 }));
      const fake = fakeChain({ block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } });
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
      await recorder.refresh(BUYER);
      // Once the top-up lands the seller can settle all 1.50: none of it is the buyer's to spend.
      expect(recorder.totals(BUYER).pending).toBe(1_500_000n);
    });

    it('keeps reading a retired channel settled in full while its top-up can still land, and counts what the top-up locks', async () => {
      store.upsertChannel(channel(1, { status: CHANNEL_STATUS.GHOST, authMax: '1000000', deadline: NOW_SECS - 2 * DAY_SECS, latestReserveDeadline: NOW_SECS + 3600 }));
      const fake = fakeChain({ block: 10, reserved: 0n, channels: { [id(1)]: open(1_000_000n, 1_000_000n) } });
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
      await recorder.refresh(BUYER);
      expect(recorder.totals(BUYER).held).toBe(0n);
      // The seller lands the top-up it was still holding: the channel holds 1.00 again.
      fake.chain.block = 11;
      fake.chain.reserved = 1_000_000n;
      fake.chain.channels[id(1)] = open(2_000_000n, 1_000_000n);
      await recorder.refresh(BUYER);
      expect(fake.reads[1]!.ids).toEqual([id(1)]);
      expect(recorder.totals(BUYER)).toMatchObject({ held: 1_000_000n, unaccountedReserved: 0n });
    });
  });

  describe('fresh reads', () => {
    it('callers asking for a fresh read while one runs share one read after it, however many they are', async () => {
      store.upsertChannel(channel(1));
      const releases: Array<() => void> = [];
      let gated = true;
      let reads = 0;
      const read: ChannelChainReader = async () => {
        reads += 1;
        if (gated) await new Promise<void>((resolve) => releases.push(resolve));
        return { block: 10, readAt: NOW, reserved: 0n, channels: new Map([[id(1), open(1_000_000n)]]) };
      };
      const recorder = new BuyerChannelChainRecorder({ store, read, now: () => NOW });
      const running = recorder.refresh(BUYER);
      // Five callers ask for a fresh read while the first runs (a key holder polling `/v1/key?fresh=1`),
      // and one more joins without asking for fresh.
      const fresh = Array.from({ length: 5 }, () => recorder.refresh(BUYER, { fresh: true }));
      const joined = recorder.refresh(BUYER);
      expect(reads).toBe(1);
      releases.shift()!();
      await running;
      await new Promise((resolve) => setTimeout(resolve, 20));
      // One more read, started after the first, for all five.
      expect(reads).toBe(2);
      gated = false;
      releases.shift()!();
      await Promise.all([...fresh, joined]);
      expect(reads).toBe(2);
    });
  });

  describe('final rows', () => {
    it('leaves rows the chain can no longer change out of the figures and the reads, however long the history', async () => {
      for (let n = 1; n <= 300; n += 1) store.upsertChannel(channel(n, { status: CHANNEL_STATUS.GHOST, authMax: '1000000' }));
      store.upsertChannel(channel(301, { authMax: '250000' }));
      const fake = fakeChain({
        block: 10,
        reserved: 1_000_000n,
        channels: { ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [id(i + 1), SETTLED(1_000_000n)])), [id(301)]: open(1_000_000n) },
      });
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW, batchSize: 400 });
      await recorder.refresh(BUYER);
      expect(store.getBuyerChannelChainRows(BUYER).map((row) => row.sessionId)).toEqual([id(301)]);
      await recorder.refresh(BUYER);
      expect(fake.reads[1]!.ids).toEqual([id(301)]);
      expect(recorder.totals(BUYER)).toMatchObject({ pending: 250_000n, held: 1_000_000n, unaccountedReserved: 0n, stale: false });
    });

    it('a row the buyer signed spend on that reads as never opened is not final: it is read again now and then, and a later read corrects it', async () => {
      // Read against the wrong contract (a changed channels address): "no record", long after its deadline.
      store.upsertChannel(channel(1, { status: CHANNEL_STATUS.GHOST, authMax: '400000', deadline: NOW_SECS - DAY_SECS }));
      const clock = { now: NOW };
      const fake = fakeChain({ block: 10, reserved: 1_000_000n, channels: {} }, clock);
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => clock.now });
      await recorder.refresh(BUYER);
      expect(store.getBuyerChannelChainRows(BUYER).map((row) => row.sessionId)).toEqual([id(1)]);
      // Read again only now and then.
      clock.now += 60_000;
      await recorder.refresh(BUYER);
      expect(fake.reads[1]!.ids).toEqual([]);
      // The setting is corrected: the next read finds the channel open.
      fake.chain.block = 20;
      fake.chain.channels[id(1)] = open(1_000_000n);
      clock.now += 10 * 60_000;
      await recorder.refresh(BUYER);
      expect(fake.reads[2]!.ids).toEqual([id(1)]);
      expect(recorder.totals(BUYER)).toMatchObject({ pending: 400_000n, held: 1_000_000n, unaccountedReserved: 0n });
    });

    it('200 retired rows with signed spend that read as never opened leave pending at 0, and are not final', async () => {
      // History from before a change of the channels address: each session ran out of reserve and was retired
      // with 0.40 signed and no settled amount; read against today's contract, none of them exists.
      for (let n = 1; n <= 200; n += 1) {
        store.upsertChannel(channel(n, { status: CHANNEL_STATUS.GHOST, authMax: '400000', deadline: NOW_SECS - 30 * DAY_SECS }));
      }
      const fake = fakeChain({ block: 10, reserved: 0n, channels: {} });
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
      await recorder.refresh(BUYER);
      expect(recorder.totals(BUYER)).toMatchObject({ pending: 0n, held: 0n, unread: 0, unaccountedReserved: 0n, stale: false });
      // Still read now and then, in case the read was the wrong one.
      expect(store.getBuyerChannelChainRows(BUYER)).toHaveLength(200);
    });

    it('a session the buyer still uses whose reserve has not landed is never final, so a re-signed reserve that opens it counts', async () => {
      // The seller went away before reserve(); nothing was signed, and the deadline passed long ago.
      store.upsertChannel(channel(1, { deadline: NOW_SECS - DAY_SECS }));
      const fake = fakeChain({ block: 10, reserved: 0n, channels: {} });
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
      await recorder.refresh(BUYER);
      expect(store.getBuyerChannelChainRows(BUYER).map((row) => row.sessionId)).toEqual([id(1)]);
      // Reconcile did not retire it: the buyer re-signs the reserve with a new deadline, the seller reserves and serves.
      store.upsertChannel(channel(1, { authMax: '300000', deadline: NOW_SECS - DAY_SECS, latestReserveDeadline: NOW_SECS + 3600 }));
      fake.chain.block = 11;
      fake.chain.reserved = 1_000_000n;
      fake.chain.channels[id(1)] = open(1_000_000n);
      await recorder.refresh(BUYER);
      expect(fake.reads[1]!.ids).toEqual([id(1)]);
      expect(recorder.totals(BUYER)).toMatchObject({ pending: 300_000n, held: 1_000_000n, unaccountedReserved: 0n });
    });

    it('a final row written as in use again is read again: a reused channel id never stays final', async () => {
      store.upsertChannel(channel(1, { status: CHANNEL_STATUS.GHOST, deadline: NOW_SECS - DAY_SECS }));
      const fake = fakeChain({ block: 10, reserved: 0n, channels: {} });
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
      await recorder.refresh(BUYER);
      expect(store.getBuyerChannelChainRows(BUYER)).toEqual([]);
      // Still retired: still final.
      store.upsertChannel(channel(1, { status: CHANNEL_STATUS.GHOST, deadline: NOW_SECS - DAY_SECS }));
      expect(store.getBuyerChannelChainRows(BUYER)).toEqual([]);
      // The channel id is written as in use again (e.g. an external SpendingAuth for it).
      store.upsertChannel(channel(1, { authMax: '200000', deadline: NOW_SECS - DAY_SECS, latestReserveDeadline: NOW_SECS + 3600 }));
      expect(store.getBuyerChannelChainRows(BUYER).map((row) => row.sessionId)).toEqual([id(1)]);
      fake.chain.block = 11;
      fake.chain.reserved = 1_000_000n;
      fake.chain.channels[id(1)] = open(1_000_000n);
      await recorder.refresh(BUYER);
      expect(recorder.totals(BUYER)).toMatchObject({ pending: 200_000n, held: 1_000_000n, unaccountedReserved: 0n });
    });

    it('a row with nothing signed and no reserve the seller confirmed that never opened is final', async () => {
      store.upsertChannel(channel(1, { status: CHANNEL_STATUS.GHOST, deadline: NOW_SECS - DAY_SECS }));
      const fake = fakeChain({ block: 10, reserved: 0n, channels: {} });
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
      await recorder.refresh(BUYER);
      expect(store.getBuyerChannelChainRows(BUYER)).toEqual([]);
      expect(recorder.totals(BUYER)).toMatchObject({ pending: 0n, held: 0n, stale: false });
    });
  });

  describe('a buyer with no channel row (a new data directory, a lost store)', () => {
    it('reports a reserve held by channels it has no row for, reads it every five minutes while it is held, and stops once it is released', async () => {
      const clock = { now: NOW };
      const fake = fakeChain({ block: 10, reserved: 2_000_000n, channels: {} }, clock);
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => clock.now });
      expect(recorder.due(BUYER)).toBe(true);
      await recorder.refresh(BUYER);
      expect(recorder.totals(BUYER)).toMatchObject({ pending: 0n, held: 0n, unaccountedReserved: 2_000_000n, stale: false });
      clock.now += 60_000;
      expect(recorder.due(BUYER)).toBe(false);
      clock.now += 4 * 60_000;
      expect(recorder.due(BUYER)).toBe(true);
      // The channel holding it is closed on chain (by its id, from a block explorer): the reserve is released.
      fake.chain.block = 11;
      fake.chain.reserved = 0n;
      await recorder.refresh(BUYER);
      expect(recorder.totals(BUYER).unaccountedReserved).toBe(0n);
      clock.now += 60 * 60_000;
      expect(recorder.due(BUYER)).toBe(false);
    });

    it('with no reserve either, its reserve is read once per start and not again', async () => {
      const clock = { now: NOW };
      const fake = fakeChain({ block: 10, reserved: 0n, channels: {} }, clock);
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => clock.now });
      expect(recorder.due(BUYER)).toBe(true);
      await recorder.refresh(BUYER);
      expect(recorder.totals(BUYER)).toMatchObject({ unaccountedReserved: 0n, stale: false });
      for (const minutes of [5, 15, 60]) {
        clock.now = NOW + minutes * 60_000;
        expect(recorder.due(BUYER)).toBe(false);
      }
      expect(fake.reads).toHaveLength(1);
    });
  });

  describe('reading many buyers', () => {
    it('spreads buyers over the interval, reads one with nothing left to read only for its reserve, every five minutes, and one with no channels and no reserve once', async () => {
      vi.useFakeTimers({ now: NOW });
      store.upsertChannel(channel(1));
      // The other buyer's only channel ended long ago: its row is final.
      store.upsertChannel(channel(2, { buyerEvmAddr: OTHER_BUYER, status: CHANNEL_STATUS.SETTLED }));
      store.recordChainState(id(2), { ...SETTLED(1_000_000n), block: 5, readAt: NOW });
      store.markChainFinal([id(2)]);
      const fake = fakeChain({ block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) }, reservedOf: { [NO_CHANNELS_BUYER]: 0n } }, { get now() { return Date.now(); } });
      const recorder = new BuyerChannelChainRecorder({ store, read: fake.read });
      const stop = recorder.schedule(() => [BUYER, OTHER_BUYER, NO_CHANNELS_BUYER], 30_000);
      const readsOf = (buyer: string): number => fake.reads.filter((entry) => entry.buyer === buyer).length;
      const counts = (): number[] => [readsOf(BUYER), readsOf(OTHER_BUYER), readsOf(NO_CHANNELS_BUYER)];
      await vi.advanceTimersByTimeAsync(0);
      expect(counts()).toEqual([1, 0, 0]);
      // Each buyer's turn comes a third of the way further into the interval.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(counts()).toEqual([1, 1, 0]);
      expect(fake.reads.find((entry) => entry.buyer === OTHER_BUYER)!.ids).toEqual([]);
      // The third never had a channel: its reserve is read once.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(counts()).toEqual([1, 1, 1]);
      // Its open channel keeps the first buyer read every interval; the second has nothing to read.
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(counts()).toEqual([9, 1, 1]);
      // The second buyer's reserve is read again once five minutes have passed; the third's reserve is 0, so it is not.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(counts()).toEqual([11, 2, 1]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(readsOf(NO_CHANNELS_BUYER)).toBe(1);
      stop();
      const total = fake.reads.length;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(fake.reads).toHaveLength(total);
    });
  });
});
