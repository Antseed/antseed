import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';

const KEY = Symbol.for('antseed.failpoints');
const globals = globalThis as { [KEY]?: unknown };

function makeChannel(overrides: Partial<StoredChannel> = {}): StoredChannel {
  const now = Date.now();
  return {
    sessionId: '0x' + 'aa'.repeat(32),
    peerId: 'peer-abc123',
    role: CHANNEL_ROLE.SELLER,
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

describe('channel store fail points', () => {
  let tempDir: string;
  let store: ChannelStore;
  let hits: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'channel-store-failpoints-'));
    store = new ChannelStore(tempDir);
    hits = [];
    globals[KEY] = { hit: async (name: string) => { hits.push(name); }, hitSync: (name: string) => { hits.push(name); } };
  });

  afterEach(() => {
    delete globals[KEY];
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const receipt = (sessionId: string) => ({ sessionId, runningTotal: '5', requestCount: 1, responseHash: '0x01', sellerSig: '0x02', buyerAckSig: null, createdAt: Date.now() });

  it('every write method reaches one before/after pair, a transaction included', () => {
    const channel = makeChannel();
    const pair = ['store.before-write', 'store.after-write'];
    const writes: Array<() => void> = [
      () => store.upsertChannel(channel),
      () => store.updateChannelStatus(channel.sessionId, CHANNEL_STATUS.SETTLED, '10'),
      () => store.updateChannelStatus(channel.sessionId, CHANNEL_STATUS.ACTIVE),
      () => store.updateTokensDelivered(channel.sessionId, '7', 1),
      () => store.insertReceipt(receipt(channel.sessionId)),
      () => store.updateDeliveredAndInsertReceipt(channel.sessionId, '9', 2, { ...receipt(channel.sessionId), runningTotal: '9', requestCount: 2 }),
      () => store.updateReceiptAck(channel.sessionId, '9', 2, '0x03'),
      () => store.replaceServiceTotals(channel.sessionId, []),
      () => store.replaceMetadataServiceTotals(channel.sessionId, []),
      () => store.commitAuthorization({ ...channel, authMax: '2000000' }, []),
    ];
    for (const write of writes) {
      hits.length = 0;
      write();
      expect(hits).toEqual(pair);
    }
    expect(store.getChannel(channel.sessionId)?.authMax).toBe('2000000');
    expect(store.getReceipts(channel.sessionId)).toHaveLength(2);
    // Reads reach no point.
    hits.length = 0;
    store.getChannel(channel.sessionId);
    store.getReceipts(channel.sessionId);
    store.getActiveChannels(CHANNEL_ROLE.SELLER);
    expect(hits).toEqual([]);
  });

  it('an error before the write leaves nothing written; one after it leaves the row on disk', () => {
    const channel = makeChannel();
    globals[KEY] = { hit: async () => {}, hitSync: (name: string) => { if (name === 'store.before-write') throw new Error('before'); } };
    expect(() => store.upsertChannel(channel)).toThrow('before');
    expect(store.getChannel(channel.sessionId)).toBeNull();

    globals[KEY] = { hit: async () => {}, hitSync: (name: string) => { if (name === 'store.after-write') throw new Error('after'); } };
    expect(() => store.upsertChannel(channel)).toThrow('after');
    expect(store.getChannel(channel.sessionId)?.authMax).toBe('1000000');

    // A point that threw does not leave the store thinking it is inside a write: the next write reaches its pair again.
    globals[KEY] = { hit: async () => {}, hitSync: (name: string) => { hits.push(name); } };
    store.updateTokensDelivered(channel.sessionId, '3', 1);
    expect(hits).toEqual(['store.before-write', 'store.after-write']);
  });

  it('without a handler the store writes as before', () => {
    delete globals[KEY];
    const channel = makeChannel();
    store.commitAuthorization(channel, []);
    store.updateDeliveredAndInsertReceipt(channel.sessionId, '4', 1, receipt(channel.sessionId));
    expect(store.getChannel(channel.sessionId)?.tokensDelivered).toBe('4');
    expect(store.getReceipts(channel.sessionId)).toHaveLength(1);
    expect(hits).toEqual([]);
  });
});
