import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';
import { runMigrations } from '../src/storage/migrate.js';
import { channelMigrations } from '../src/storage/migrations/channels/index.js';
import {
  BuyerChannelChainRecorder,
  type ChannelChainRead,
  type ChannelChainReader,
  type ChannelChainState,
} from '../src/payments/channel-chain-record.js';

const BUYER = '0x' + 'cc'.repeat(20);
const SELLER = '0x' + 'bb'.repeat(20);
const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const NOW = 1_800_000_000_000;

function channel(n: number, overrides: Partial<StoredChannel> = {}): StoredChannel {
  return {
    sessionId: id(n),
    peerId: `peer-${n}`,
    role: CHANNEL_ROLE.BUYER,
    sellerEvmAddr: SELLER,
    buyerEvmAddr: BUYER,
    nonce: n,
    authMax: '0',
    deadline: Math.floor(NOW / 1000) + 3600,
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

const open = (deposit: bigint, settled = 0n, closeRequestedAt = 0n): ChannelChainState => ({ status: 1, deposit, settled, closeRequestedAt });
const SETTLED = (settled: bigint): ChannelChainState => ({ status: 2, deposit: settled, settled, closeRequestedAt: 0n });

/** A chain the test edits, read at the block it says, and the ids each read asked for. */
function fakeChain(chain: { block: number; reserved: bigint | null; channels: Record<string, ChannelChainState> }) {
  const reads: string[][] = [];
  let hang = false;
  const read: ChannelChainReader = async (_buyer, rows): Promise<ChannelChainRead> => {
    reads.push(rows.map((row) => row.channelId));
    if (hang) await new Promise(() => {});
    return {
      block: chain.block,
      readAt: NOW,
      reserved: chain.reserved,
      channels: new Map(rows.flatMap((row) => (chain.channels[row.channelId] ? [[row.channelId, chain.channels[row.channelId]!] as const] : []))),
    };
  };
  return { chain, reads, read, hang: () => { hang = true; } };
}

describe('chain records in the channel store', () => {
  let dir: string;
  let store: ChannelStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'channel-chain-record-'));
  });
  afterEach(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates an existing database: old rows get no record, and those already retired are marked for backfill', () => {
    // A database written before the chain record columns existed.
    const db = new Database(join(dir, 'sessions.db'));
    runMigrations(db, channelMigrations.filter((migration) => migration.version <= 8));
    const insert = db.prepare(`INSERT INTO payment_channels (session_id, peer_id, role, channel_kind, seller_evm_addr, buyer_evm_addr, nonce, auth_max, deadline,
      previous_session_id, previous_consumption, reserved_at, status, created_at, updated_at) VALUES (?, ?, 'buyer', 'paid', ?, ?, ?, '500000', 0, ?, '0', ?, ?, ?, ?)`);
    insert.run(id(1), 'p1', SELLER, BUYER, 1, '0x' + '00'.repeat(32), NOW, 'active', NOW + 1, NOW);
    insert.run(id(2), 'p2', SELLER, BUYER, 2, '0x' + '00'.repeat(32), NOW, 'ghost', NOW + 2, NOW);
    db.close();

    store = new ChannelStore(dir);
    const rows = new Map(store.getBuyerChannelChainRows(BUYER).map((row) => [row.sessionId, row]));
    expect(rows.get(id(1))).toMatchObject({ status: 'active', record: null, backfill: false });
    expect(rows.get(id(2))).toMatchObject({ status: 'ghost', record: null, backfill: true });
    // Rows written after the upgrade are never backfill.
    store.upsertChannel(channel(3, { status: CHANNEL_STATUS.GHOST }));
    expect(store.getBuyerChannelChainRows(BUYER).find((row) => row.sessionId === id(3))?.backfill).toBe(false);
  });

  it('backfills unread rows in bounded batches until every row has a record, and never reads an ended channel again', async () => {
    store = new ChannelStore(dir);
    for (let n = 1; n <= 5; n += 1) store.upsertChannel(channel(n, { status: CHANNEL_STATUS.GHOST, authMax: '1000000' }));
    const fake = fakeChain({ block: 100, reserved: 0n, channels: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [id(n), SETTLED(1_000_000n)])) });
    const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW, batchSize: 2 });
    await recorder.refresh(BUYER);
    expect(recorder.totals(BUYER)).toMatchObject({ unread: 3, stale: true });
    await recorder.refresh(BUYER);
    await recorder.refresh(BUYER);
    expect(recorder.totals(BUYER)).toMatchObject({ unread: 0, stale: false, pending: 0n });
    await recorder.refresh(BUYER);
    expect(fake.reads.map((ids) => ids.length)).toEqual([2, 2, 1, 0]);
  });

  it('a read from an older block cannot revive a channel a newer read showed settled or timed out', () => {
    store = new ChannelStore(dir);
    store.upsertChannel(channel(1, { authMax: '400000' }));
    expect(store.recordChainState(id(1), { ...SETTLED(400_000n), block: 120, readAt: NOW })).toBe(true);
    // A lagging endpoint answers for block 110, before the seller closed.
    expect(store.recordChainState(id(1), { ...open(1_000_000n), block: 110, readAt: NOW + 1_000 })).toBe(false);
    expect(store.getBuyerChannelChainRows(BUYER)[0]!.record).toMatchObject({ status: 2, block: 120 });
    // Timed out likewise; and "no record" never replaces a record, whatever the block.
    store.upsertChannel(channel(2));
    store.recordChainState(id(2), { status: 3, deposit: 1_000_000n, settled: 0n, closeRequestedAt: 5n, block: 130, readAt: NOW });
    expect(store.recordChainState(id(2), { ...open(1_000_000n), block: 129, readAt: NOW })).toBe(false);
    expect(store.recordChainState(id(2), { status: 0, deposit: 0n, settled: 0n, closeRequestedAt: 0n, block: 200, readAt: NOW })).toBe(false);
    expect(store.getBuyerChannelChainRows(BUYER).find((row) => row.sessionId === id(2))!.record?.status).toBe(3);
    // A later read of an open channel replaces an earlier one.
    store.upsertChannel(channel(3));
    store.recordChainState(id(3), { ...open(1_000_000n), block: 10, readAt: NOW });
    expect(store.recordChainState(id(3), { ...open(1_000_000n, 250_000n), block: 11, readAt: NOW })).toBe(true);
  });

  it('retiring a session never touches its chain record', () => {
    store = new ChannelStore(dir);
    store.upsertChannel(channel(1, { authMax: '400000' }));
    store.recordChainState(id(1), { ...open(1_000_000n), block: 50, readAt: NOW });
    store.updateChannelStatus(id(1), CHANNEL_STATUS.GHOST);
    store.upsertChannel({ ...channel(1, { authMax: '400000' }), status: CHANNEL_STATUS.GHOST });
    expect(store.getBuyerChannelChainRows(BUYER)[0]).toMatchObject({ status: 'ghost', record: { status: 1, deposit: 1_000_000n, block: 50 } });
  });
});

describe('the buyer figures from stored records', () => {
  let dir: string;
  let store: ChannelStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'channel-chain-figures-'));
    store = new ChannelStore(dir);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a retired channel the chain holds open counts its unsettled spend and what it holds (#1463)', async () => {
    // The seller answered that the channel is exhausted: the buyer retired the session with 0.40 signed.
    store.upsertChannel(channel(1, { status: CHANNEL_STATUS.GHOST, authMax: '400000' }));
    const fake = fakeChain({ block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } });
    const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
    await recorder.refresh(BUYER);
    expect(recorder.totals(BUYER)).toMatchObject({ pending: 400_000n, held: 1_000_000n, unaccountedReserved: 0n, stale: false });
  });

  it('200 old sessions that ran out of reserve never collapse the balance, unread during backfill or read as settled', async () => {
    const days = (n: number) => NOW - n * 24 * 60 * 60_000;
    // Retired as ghost with no settled amount, before chain records existed (marked as the migration marks them).
    for (let n = 1; n <= 200; n += 1) store.upsertChannel(channel(n, { status: CHANNEL_STATUS.GHOST, authMax: '1000000', updatedAt: days(n) }));
    const raw = new Database(join(dir, 'sessions.db'));
    raw.exec("UPDATE payment_channels SET chain_backfill = 1 WHERE status <> 'active'");
    raw.close();
    store.upsertChannel(channel(1000, { authMax: '100000' }));
    const channels: Record<string, ChannelChainState> = { [id(1000)]: open(1_000_000n) };
    for (let n = 1; n <= 200; n += 1) channels[id(n)] = SETTLED(1_000_000n);
    const fake = fakeChain({ block: 10, reserved: 1_000_000n, channels });
    const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW, batchSize: 50 });
    // Not read yet: only the live session's signed spend counts.
    expect(recorder.totals(BUYER)).toMatchObject({ pending: 100_000n, stale: true });
    await recorder.refresh(BUYER);
    // Part way through the backfill.
    expect(recorder.totals(BUYER)).toMatchObject({ pending: 100_000n, stale: true, unaccountedReserved: null });
    for (let pass = 0; pass < 4; pass += 1) await recorder.refresh(BUYER);
    expect(recorder.totals(BUYER)).toMatchObject({ pending: 100_000n, held: 1_000_000n, unread: 0, stale: false, unaccountedReserved: 0n });
  });

  it('giving up on a session never makes the balance jump up, read or not yet read', async () => {
    store.upsertChannel(channel(1, { authMax: '400000' }));
    store.upsertChannel(channel(2, { authMax: '300000' }));
    const fake = fakeChain({ block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } });
    const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
    await recorder.refresh(BUYER);
    // Channel 2's reserve was still landing: no record yet.
    expect(recorder.totals(BUYER).pending).toBe(700_000n);
    store.updateChannelStatus(id(1), CHANNEL_STATUS.GHOST);
    store.updateChannelStatus(id(2), CHANNEL_STATUS.GHOST);
    expect(recorder.totals(BUYER).pending).toBe(700_000n);
  });

  it('after a buyer restart the stored record is used at once, before any chain read', async () => {
    store.upsertChannel(channel(1, { status: CHANNEL_STATUS.GHOST, authMax: '400000' }));
    const before = fakeChain({ block: 10, reserved: 1_000_000n, channels: { [id(1)]: open(1_000_000n) } });
    await new BuyerChannelChainRecorder({ store, read: before.read, now: () => NOW }).refresh(BUYER);
    store.close();

    // The buyer restarts; its first chain read does not finish.
    store = new ChannelStore(dir);
    const after = fakeChain({ block: 11, reserved: 1_000_000n, channels: {} });
    after.hang();
    const recorder = new BuyerChannelChainRecorder({ store, read: after.read, now: () => NOW });
    void recorder.refresh(BUYER);
    expect(recorder.totals(BUYER)).toMatchObject({ pending: 400_000n, held: 1_000_000n, unread: 0, stale: true, unaccountedReserved: null });
  });

  it('names the reserve no channel explains, only from a read that covered every open channel', async () => {
    store.upsertChannel(channel(1, { authMax: '0' }));
    const fake = fakeChain({ block: 10, reserved: 5_690_000n, channels: { [id(1)]: open(1_000_000n) } });
    const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
    expect(recorder.totals(BUYER).unaccountedReserved).toBeNull();
    await recorder.refresh(BUYER);
    expect(recorder.totals(BUYER).unaccountedReserved).toBe(4_690_000n);
    // A failed read after it: not confirmed any more.
    const failing = new BuyerChannelChainRecorder({ store, read: async () => { throw new Error('rpc down'); }, now: () => NOW });
    await expect(failing.refresh(BUYER)).rejects.toThrow('rpc down');
    expect(failing.totals(BUYER)).toMatchObject({ stale: true, unaccountedReserved: null, held: 1_000_000n });
  });

  it('caps a closing channel\'s pending at what the seller can still settle', async () => {
    store.upsertChannel(channel(1, { status: CHANNEL_STATUS.GHOST, authMax: '2000000' }));
    const fake = fakeChain({ block: 10, reserved: 750_000n, channels: { [id(1)]: open(1_000_000n, 250_000n, 1_799_999_000n) } });
    const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
    await recorder.refresh(BUYER);
    expect(recorder.totals(BUYER)).toMatchObject({ pending: 750_000n, held: 750_000n });
  });

  it('a fresh refresh waits for the read already running and reads again after it', async () => {
    store.upsertChannel(channel(1));
    const fake = fakeChain({ block: 10, reserved: 0n, channels: { [id(1)]: open(1_000_000n) } });
    const recorder = new BuyerChannelChainRecorder({ store, read: fake.read, now: () => NOW });
    const first = recorder.refresh(BUYER);
    const joined = recorder.refresh(BUYER);
    const fresh = recorder.refresh(BUYER, { fresh: true });
    await Promise.all([first, joined, fresh]);
    expect(fake.reads.length).toBe(2);
  });
});
