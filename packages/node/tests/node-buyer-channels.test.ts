import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntseedNode } from '../src/node.js';
import { ChannelStore, CHANNEL_KIND, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';

const buyerAddress = '0x' + '11'.repeat(20);

function makeChannel(sessionId: string, overrides: Partial<StoredChannel> = {}): StoredChannel {
  return {
    sessionId,
    peerId: '22'.repeat(20),
    role: CHANNEL_ROLE.BUYER,
    channelKind: CHANNEL_KIND.PAID,
    sellerEvmAddr: '0x' + '22'.repeat(20),
    buyerEvmAddr: buyerAddress,
    nonce: 0,
    authMax: '850000',
    deadline: 2_000_000_000,
    previousSessionId: '',
    previousConsumption: '0',
    tokensDelivered: '0',
    requestCount: 0,
    reservedAt: 1,
    settledAt: null,
    settledAmount: null,
    status: CHANNEL_STATUS.ACTIVE,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('buyer payment channel summaries', () => {
  let dataDir: string;
  let store: ChannelStore;
  let node: AntseedNode;
  const getReserveCeiling = vi.fn(() => 1_000_000n);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'antseed-buyer-channels-'));
    store = new ChannelStore(dataDir);
    node = new AntseedNode({ role: 'buyer' });
    getReserveCeiling.mockClear();
    Object.assign(node, {
      _identity: { wallet: { address: buyerAddress } },
      _channelStore: store,
      _buyerPaymentManager: { getReserveCeiling },
    });
    for (const channel of [
      makeChannel('chat'),
      makeChannel('video', { channelKind: CHANNEL_KIND.ONE_OFF, confirmedReserveAmount: '4200000' }),
      makeChannel('pending-video', { channelKind: CHANNEL_KIND.ONE_OFF, reserveAuthPending: true, reserveMaxAmount: '4200000' }),
      makeChannel('settled-video', { channelKind: CHANNEL_KIND.ONE_OFF, status: CHANNEL_STATUS.SETTLED, confirmedReserveAmount: '4200000' }),
      makeChannel('free', { channelKind: CHANNEL_KIND.FREE }),
      makeChannel('other-buyer', { buyerEvmAddr: '0x' + '33'.repeat(20) }),
      makeChannel('seller', { role: CHANNEL_ROLE.SELLER }),
    ]) store.upsertChannel(channel);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('includes video channels in active listings and history with their own reserves', () => {
    const active = node.getActiveBuyerChannels();
    expect(active.map((channel) => channel.channelId).sort()).toEqual(['chat', 'pending-video', 'video']);
    expect(active.find((channel) => channel.channelId === 'chat')?.reserveCeiling).toBe('1000000');
    expect(active.find((channel) => channel.channelId === 'video')?.reserveCeiling).toBe('4200000');
    expect(active.find((channel) => channel.channelId === 'pending-video')?.reserveCeiling).toBeNull();
    const history = node.getAllBuyerChannels();
    expect(history.map((channel) => channel.channelId).sort()).toEqual(['chat', 'pending-video', 'settled-video', 'video']);
    expect(history.find((channel) => channel.channelId === 'video')?.reserveCeiling).toBe('4200000');
    expect(history.find((channel) => channel.channelId === 'settled-video')?.reserveCeiling).toBeNull();
    expect(getReserveCeiling).toHaveBeenCalledTimes(2);
  });

  it('retains confirmed video reserves when the payment manager is offline', () => {
    Object.assign(node, { _buyerPaymentManager: null });
    for (const channels of [node.getActiveBuyerChannels(), node.getAllBuyerChannels()]) {
      expect(channels.find((channel) => channel.channelId === 'video')?.reserveCeiling).toBe('4200000');
      expect(channels.find((channel) => channel.channelId === 'chat')?.reserveCeiling).toBeNull();
    }
  });
});
