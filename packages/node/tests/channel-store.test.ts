import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { ChannelStore, CHANNEL_KIND, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel, type StoredReceipt } from '../src/payments/channel-store.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'channel-store-test-'));
}

function makeChannel(overrides: Partial<StoredChannel> = {}): StoredChannel {
  const now = Date.now();
  return {
    sessionId: '0x' + 'aa'.repeat(32),
    peerId: 'peer-abc123',
    role: CHANNEL_ROLE.BUYER,
    sellerEvmAddr: '0x' + 'bb'.repeat(20),
    buyerEvmAddr: '0x' + 'cc'.repeat(20),
    nonce: 1,
    authMax: '1000000',
    deadline: Math.floor(now / 1000) + 3600,
    previousSessionId: '0x' + '00'.repeat(32),
    previousConsumption: '0',
    tokensDelivered: '0',
    requestCount: 0,
    reservedAt: now,
    settledAt: null,
    settledAmount: null,
    status: CHANNEL_STATUS.ACTIVE,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ChannelStore', () => {
  let tempDir: string;
  let store: ChannelStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new ChannelStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_createAndRead: insert channel, read back all fields', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    const loaded = store.getChannel(channel.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(channel.sessionId);
    expect(loaded!.peerId).toBe(channel.peerId);
    expect(loaded!.role).toBe(channel.role);
    expect(loaded!.sellerEvmAddr).toBe(channel.sellerEvmAddr);
    expect(loaded!.buyerEvmAddr).toBe(channel.buyerEvmAddr);
    expect(loaded!.nonce).toBe(channel.nonce);
    expect(loaded!.authMax).toBe(channel.authMax);
    expect(loaded!.deadline).toBe(channel.deadline);
    expect(loaded!.previousSessionId).toBe(channel.previousSessionId);
    expect(loaded!.previousConsumption).toBe(channel.previousConsumption);
    expect(loaded!.tokensDelivered).toBe(channel.tokensDelivered);
    expect(loaded!.requestCount).toBe(channel.requestCount);
    expect(loaded!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(loaded!.settledAt).toBeNull();
    expect(loaded!.settledAmount).toBeNull();
  });

  it('test_updateStatus: update to settled, verify', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    store.updateChannelStatus(channel.sessionId, CHANNEL_STATUS.SETTLED, '500000');

    const loaded = store.getChannel(channel.sessionId);
    expect(loaded!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(loaded!.settledAmount).toBe('500000');
    expect(loaded!.settledAt).toBeTypeOf('number');
  });

  it('durably preserves reserve recovery state and the delivered amount', () => {
    const recovery = {
      reserveSalt: 'reserve-salt', initialReserveAmount: '1000000', reserveMaxAmount: '5000000',
      latestReserveAuthSig: 'reserve-signature', latestReserveDeadline: 1900000000,
      reserveAuthPending: true, confirmedReserveAmount: '1000000', deliveredAmount: '100000',
    };
    const channel = makeChannel({ ...recovery, authMax: '850000' });
    store.upsertChannel(channel);
    store.close();
    store = new ChannelStore(tempDir);
    expect(store.getChannel(channel.sessionId)).toMatchObject(recovery);
    store.upsertChannel({ ...store.getChannel(channel.sessionId)!, deliveredAmount: '850000', reserveAuthPending: false });
    store.close();
    store = new ChannelStore(tempDir);
    expect(store.getChannel(channel.sessionId)).toMatchObject({ deliveredAmount: '850000', reserveAuthPending: false });
  });

  it('upgrades a version-five database without changing existing channels', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);
    store.close();
    const legacyDatabase = new Database(join(tempDir, 'sessions.db'));
    legacyDatabase.exec('ALTER TABLE payment_channels DROP COLUMN payment_recovery; DELETE FROM schema_version WHERE version = 6');
    legacyDatabase.close();
    store = new ChannelStore(tempDir);
    expect(store.getChannel(channel.sessionId)).toMatchObject(channel);
    expect(store.getChannel(channel.sessionId)?.deliveredAmount).toBeUndefined();
    store.upsertChannel({ ...store.getChannel(channel.sessionId)!, deliveredAmount: '850000' });
    expect(store.getChannel(channel.sessionId)?.deliveredAmount).toBe('850000');
  });

  it('test_updateTokensDelivered: increment tokens, verify', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    store.updateTokensDelivered(channel.sessionId, '250000', 3);

    const loaded = store.getChannel(channel.sessionId);
    expect(loaded!.tokensDelivered).toBe('250000');
    expect(loaded!.requestCount).toBe(3);
  });

  it('atomically commits an authorization with its service totals', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    store.commitAuthorization({
      ...channel,
      authMax: '250000',
      tokensDelivered: '12',
      previousConsumption: '8',
      requestCount: 1,
    }, [{
      serviceId: '0x' + '11'.repeat(32),
      cumulativeAmount: 250000n,
      cumulativeInputTokens: 12n,
      cumulativeCachedInputTokens: 2n,
      cumulativeOutputTokens: 8n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 0n,
    }]);

    expect(store.getChannel(channel.sessionId)).toMatchObject({
      authMax: '250000',
      tokensDelivered: '12',
      previousConsumption: '8',
      requestCount: 1,
    });
    expect(store.getServiceTotals(channel.sessionId)).toEqual([
      expect.objectContaining({
        cumulativeAmount: '250000',
        cumulativeInputTokens: '12',
        cumulativeOutputTokens: '8',
      }),
    ]);
  });

  it('rolls back the channel snapshot when service-total persistence fails', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);
    store.replaceServiceTotals(channel.sessionId, [{
      serviceId: '0x' + '22'.repeat(32),
      cumulativeAmount: '10',
      cumulativeInputTokens: '1',
      cumulativeCachedInputTokens: '0',
      cumulativeOutputTokens: '1',
      cumulativeRequestCount: '1',
      cumulativeOutputImages: '0',
    }]);

    expect(() => store.commitAuthorization({ ...channel, authMax: '999' }, [{
      serviceId: null as unknown as string,
      cumulativeAmount: 999n,
      cumulativeInputTokens: 9n,
      cumulativeCachedInputTokens: 0n,
      cumulativeOutputTokens: 9n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 0n,
    }])).toThrow();

    expect(store.getChannel(channel.sessionId)?.authMax).toBe(channel.authMax);
    expect(store.getServiceTotals(channel.sessionId)).toEqual([
      expect.objectContaining({
        serviceId: '0x' + '22'.repeat(32),
        cumulativeAmount: '10',
      }),
    ]);
  });

  it('test_getActiveByPeer: returns correct active channel', () => {
    const s1 = makeChannel({ sessionId: '0x' + '01'.repeat(32), status: CHANNEL_STATUS.SETTLED, createdAt: Date.now() - 1000 });
    const s2 = makeChannel({ sessionId: '0x' + '02'.repeat(32), status: CHANNEL_STATUS.ACTIVE, createdAt: Date.now() });
    store.upsertChannel(s1);
    store.upsertChannel(s2);

    const active = store.getActiveChannelByPeer('peer-abc123', CHANNEL_ROLE.BUYER);
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe(s2.sessionId);
  });

  it('keeps active paid and free channels separate for the same peer', () => {
    const paid = makeChannel({
      sessionId: '0x' + '10'.repeat(32),
      channelKind: CHANNEL_KIND.PAID,
      createdAt: Date.now() - 1000,
    });
    const free = makeChannel({
      sessionId: '0x' + '20'.repeat(32),
      channelKind: CHANNEL_KIND.FREE,
      authMax: '0',
      createdAt: Date.now(),
    });
    store.upsertChannel(paid);
    store.upsertChannel(free);

    expect(store.getActiveChannelByPeer('peer-abc123', CHANNEL_ROLE.BUYER)!.sessionId).toBe(paid.sessionId);
    expect(store.getActiveChannelByPeer('peer-abc123', CHANNEL_ROLE.BUYER, CHANNEL_KIND.FREE)!.sessionId).toBe(free.sessionId);
    expect(store.listAllChannels()).toHaveLength(1);
    expect(store.listAllChannels(100, CHANNEL_KIND.FREE)).toHaveLength(1);
  });

  it('test_getActiveByPeer: returns null when no active channel', () => {
    const s1 = makeChannel({ status: CHANNEL_STATUS.SETTLED });
    store.upsertChannel(s1);

    const active = store.getActiveChannelByPeer('peer-abc123', CHANNEL_ROLE.BUYER);
    expect(active).toBeNull();
  });

  it('test_getLatestByPeer: returns most recent (any status)', () => {
    const s1 = makeChannel({ sessionId: '0x' + '01'.repeat(32), status: CHANNEL_STATUS.SETTLED, createdAt: Date.now() - 2000 });
    const s2 = makeChannel({ sessionId: '0x' + '02'.repeat(32), status: CHANNEL_STATUS.SETTLED, createdAt: Date.now() - 1000 });
    const s3 = makeChannel({ sessionId: '0x' + '03'.repeat(32), status: CHANNEL_STATUS.ACTIVE, createdAt: Date.now() });
    store.upsertChannel(s1);
    store.upsertChannel(s2);
    store.upsertChannel(s3);

    const latest = store.getLatestChannel('peer-abc123', CHANNEL_ROLE.BUYER);
    expect(latest).not.toBeNull();
    expect(latest!.sessionId).toBe(s3.sessionId);
  });

  it('test_getTimedOut: returns channels past timeout', () => {
    const oldTime = Date.now() - 100_000; // 100 seconds ago
    const s1 = makeChannel({
      sessionId: '0x' + '01'.repeat(32),
      updatedAt: oldTime,
      createdAt: oldTime,
    });
    const recentTime = Date.now();
    const s2 = makeChannel({
      sessionId: '0x' + '02'.repeat(32),
      updatedAt: recentTime,
      createdAt: recentTime,
    });
    store.upsertChannel(s1);
    store.upsertChannel(s2);

    // 50 second timeout — s1 should be timed out, s2 should not
    const timedOut = store.getTimedOutChannels(50);
    expect(timedOut.length).toBe(1);
    expect(timedOut[0].sessionId).toBe(s1.sessionId);
  });

  it('test_receiptCRUD: insert and read receipts', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    const receipt: Omit<StoredReceipt, 'id'> = {
      sessionId: channel.sessionId,
      runningTotal: '100000',
      requestCount: 1,
      responseHash: 'dd'.repeat(32),
      sellerSig: 'ee'.repeat(64),
      buyerAckSig: null,
      createdAt: Date.now(),
    };
    store.insertReceipt(receipt);

    const receipt2: Omit<StoredReceipt, 'id'> = {
      sessionId: channel.sessionId,
      runningTotal: '200000',
      requestCount: 2,
      responseHash: 'ff'.repeat(32),
      sellerSig: 'ab'.repeat(64),
      buyerAckSig: 'cd'.repeat(64),
      createdAt: Date.now() + 1,
    };
    store.insertReceipt(receipt2);

    const receipts = store.getReceipts(channel.sessionId);
    expect(receipts.length).toBe(2);
    expect(receipts[0].runningTotal).toBe('100000');
    expect(receipts[0].requestCount).toBe(1);
    expect(receipts[0].buyerAckSig).toBeNull();
    expect(receipts[1].runningTotal).toBe('200000');
    expect(receipts[1].buyerAckSig).toBe('cd'.repeat(64));
  });

  it('test_persistence: close and reopen, data survives', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);
    store.insertReceipt({
      sessionId: channel.sessionId,
      runningTotal: '50000',
      requestCount: 1,
      responseHash: 'aa'.repeat(32),
      sellerSig: 'bb'.repeat(64),
      buyerAckSig: null,
      createdAt: Date.now(),
    });

    // Close and reopen
    store.close();
    const store2 = new ChannelStore(tempDir);

    const loaded = store2.getChannel(channel.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.peerId).toBe(channel.peerId);

    const receipts = store2.getReceipts(channel.sessionId);
    expect(receipts.length).toBe(1);
    expect(receipts[0].runningTotal).toBe('50000');

    store2.close();
    // Prevent double-close in afterEach
    store = new ChannelStore(tempDir);
  });

  describe('getBuyerServiceUsageTotals', () => {
    const buyerAddr = '0x' + 'cc'.repeat(20);

    it('sums the same service across paid and free channels', () => {
      const paid = makeChannel({ sessionId: '0x' + 'a1'.repeat(32) });
      const free = makeChannel({ sessionId: '0x' + 'a2'.repeat(32), channelKind: CHANNEL_KIND.FREE });
      store.upsertChannel(paid);
      store.upsertChannel(free);
      store.replaceServiceTotals(paid.sessionId, [{
        serviceId: '0x' + '11'.repeat(32),
        cumulativeAmount: '1000',
        cumulativeInputTokens: '500',
        cumulativeCachedInputTokens: '100',
        cumulativeOutputTokens: '200',
        cumulativeRequestCount: '3',
        cumulativeOutputImages: '2',
        cumulativeVideoGenerations: '1',
        cumulativeVideoSeconds: '8',
      }]);
      // Rows written before migration 005 hydrate without the images field.
      store.replaceServiceTotals(free.sessionId, [{
        serviceId: '0x' + '11'.repeat(32),
        cumulativeAmount: '0',
        cumulativeInputTokens: '400',
        cumulativeCachedInputTokens: '0',
        cumulativeOutputTokens: '300',
        cumulativeRequestCount: '2',
      }]);

      const totals = store.getBuyerServiceUsageTotals(buyerAddr);
      expect(totals.length).toBe(1);
      expect(totals[0].serviceId).toBe('0x' + '11'.repeat(32));
      expect(totals[0].amountUsdc).toBe('1000');
      expect(totals[0].inputTokens).toBe('900');
      expect(totals[0].cachedInputTokens).toBe('100');
      expect(totals[0].outputTokens).toBe('500');
      expect(totals[0].outputImages).toBe('2');
      expect(totals[0].videoGenerations).toBe('1');
      expect(totals[0].videoSeconds).toBe('8');
      expect(totals[0].requestCount).toBe(5);
    });

    it('keeps distinct services separate and excludes other buyers', () => {
      const mine = makeChannel({ sessionId: '0x' + 'b1'.repeat(32) });
      const theirs = makeChannel({ sessionId: '0x' + 'b2'.repeat(32), buyerEvmAddr: '0x' + 'dd'.repeat(20) });
      store.upsertChannel(mine);
      store.upsertChannel(theirs);
      store.replaceServiceTotals(mine.sessionId, [
        {
          serviceId: '0x' + '11'.repeat(32),
          cumulativeAmount: '10',
          cumulativeInputTokens: '1',
          cumulativeCachedInputTokens: '0',
          cumulativeOutputTokens: '1',
          cumulativeRequestCount: '1',
        },
        {
          serviceId: '0x' + '22'.repeat(32),
          cumulativeAmount: '20',
          cumulativeInputTokens: '2',
          cumulativeCachedInputTokens: '0',
          cumulativeOutputTokens: '2',
          cumulativeRequestCount: '1',
        },
      ]);
      store.replaceServiceTotals(theirs.sessionId, [{
        serviceId: '0x' + '11'.repeat(32),
        cumulativeAmount: '999',
        cumulativeInputTokens: '999',
        cumulativeCachedInputTokens: '0',
        cumulativeOutputTokens: '999',
        cumulativeRequestCount: '9',
      }]);

      const totals = store.getBuyerServiceUsageTotals(buyerAddr);
      expect(totals.length).toBe(2);
      const first = totals.find((t) => t.serviceId === '0x' + '11'.repeat(32));
      expect(first?.amountUsdc).toBe('10');
    });

    it('returns empty for a buyer with no channels', () => {
      expect(store.getBuyerServiceUsageTotals('0x' + 'ee'.repeat(20))).toEqual([]);
    });
  });
});
