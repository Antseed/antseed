import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { AntseedNode } from '../src/node.js';
import { ChannelStore, CHANNEL_KIND, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../src/payments/buyer-payment-negotiator.js';
import type { ChannelInfo, ChannelsClient } from '../src/payments/evm/channels-client.js';
import type { Identity } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';

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
  // The live session with the seller is 'chat'.
  const getActiveSession = vi.fn(() => ({ sessionId: 'chat' }));

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'antseed-buyer-channels-'));
    store = new ChannelStore(dataDir);
    node = new AntseedNode({ role: 'buyer' });
    getReserveCeiling.mockClear();
    Object.assign(node, {
      _identity: { wallet: { address: buyerAddress } },
      _channelStore: store,
      _buyerPaymentManager: { getReserveCeiling, getActiveSession },
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

  it('marks only the live session live and gives older active rows no reserve', () => {
    store.upsertChannel(makeChannel('older-chat', { reservedAt: 0 }));
    const active = node.getActiveBuyerChannels();
    expect(active.find((channel) => channel.channelId === 'chat')).toMatchObject({ live: true, channelKind: CHANNEL_KIND.PAID, reserveCeiling: '1000000' });
    expect(active.find((channel) => channel.channelId === 'older-chat')).toMatchObject({ live: false, reserveCeiling: null });
    expect(active.find((channel) => channel.channelId === 'video')).toMatchObject({ live: false, channelKind: CHANNEL_KIND.ONE_OFF });
    expect(node.getAllBuyerChannels().find((channel) => channel.channelId === 'settled-video')?.live).toBe(false);
  });
});

describe('buyer channel counts after a reconcile with the chain', () => {
  let dataDir: string;
  let store: ChannelStore;

  function buyerIdentity(): Identity {
    const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));
    return { wallet, peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey: Buffer.from(wallet.privateKey.slice(2), 'hex') };
  }

  function buyerAccount(identity: Identity, chain: ChannelsClient) {
    const paymentManager = new BuyerPaymentManager(identity, {
      rpcUrl: 'http://127.0.0.1:1',
      chainId: 31337,
      channelsContractAddress: '0x' + 'cc'.repeat(20),
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n,
      maxReserveAmountUsdc: 1_000_000n,
      dataDir,
    }, store);
    const negotiator = new BuyerPaymentNegotiator(identity, paymentManager, null, chain, store, {}, { emit: () => true });
    return { address: identity.wallet.address, paymentManager, negotiator };
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'antseed-buyer-reconcile-node-'));
    store = new ChannelStore(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stops counting channels the chain shows closed, for every buyer identity', async () => {
    const main = buyerIdentity();
    const alt = buyerIdentity();
    const closedOnChain = new Map<string, ChannelInfo>();
    const closeOnChain = (channel: StoredChannel, status: 2 | 3): StoredChannel => {
      closedOnChain.set(channel.sessionId, {
        buyer: channel.buyerEvmAddr,
        seller: channel.sellerEvmAddr,
        deposit: 1_000_000n,
        settled: 400_000n,
        metadataHash: '0x' + '00'.repeat(32),
        deadline: 0n,
        settledAt: 0n,
        closeRequestedAt: 0n,
        status,
      });
      return channel;
    };
    for (const channel of [
      closeOnChain(makeChannel('0x' + 'a1'.repeat(32), { buyerEvmAddr: main.wallet.address }), 2),
      closeOnChain(makeChannel('0x' + 'a2'.repeat(32), { buyerEvmAddr: main.wallet.address, channelKind: CHANNEL_KIND.ONE_OFF, peerId: '33'.repeat(20) }), 2),
      closeOnChain(makeChannel('0x' + 'b1'.repeat(32), { buyerEvmAddr: alt.wallet.address }), 3),
    ]) store.upsertChannel(channel);
    const chain = { getSession: vi.fn(async (id: string) => closedOnChain.get(id)!) } as unknown as ChannelsClient;
    const mainAccount = buyerAccount(main, chain);
    const node = new AntseedNode({ role: 'buyer' });
    Object.assign(node, {
      _identity: main,
      _channelStore: store,
      _buyerPaymentManager: mainAccount.paymentManager,
      _buyerNegotiator: mainAccount.negotiator,
      _buyerIdentities: new Map([['alt', { name: 'alt', ...buyerAccount(alt, chain) }]]),
    });
    expect([node.getBuyerUsageTotals().activeChannels, node.getBuyerUsageTotals('alt').activeChannels]).toEqual([1, 1]);
    expect(node.getActiveBuyerChannels()).toHaveLength(2);

    await node.reconcileBuyerChannels();

    expect(node.getBuyerUsageTotals().activeChannels).toBe(0);
    expect(node.getBuyerUsageTotals('alt').activeChannels).toBe(0);
    expect(node.getActiveBuyerChannels()).toEqual([]);
    expect(node.getActiveBuyerChannels('alt')).toEqual([]);
  });
});
