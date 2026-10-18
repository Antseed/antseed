import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { toPeerId } from '@antseed/protocol';
import type { SpendingAuthPayload } from '@antseed/protocol/messages';
import { BuyerPaymentManager } from './buyer-payment-manager.js';
import { CHANNEL_STATUS, type BuyerChannelStore, type StoredChannel } from './channel-store-types.js';
import type { PaymentMux } from './payment-mux.js';

const SELLER = toPeerId('5e'.repeat(20));
const MAX_PER_REQUEST = 1_000_000n;

function memoryChannelStore(): BuyerChannelStore {
  const channels = new Map<string, StoredChannel>();
  return {
    upsertChannel: (channel: StoredChannel) => { channels.set(channel.sessionId, channel); },
    getChannel: (id: string) => channels.get(id) ?? null,
    getActiveChannelByPeerAndBuyer: (peerId: string, role: string, buyer: string) =>
      [...channels.values()].find((c) =>
        c.peerId === peerId && c.role === role && c.buyerEvmAddr === buyer && c.status === CHANNEL_STATUS.ACTIVE) ?? null,
    getActiveChannelsByBuyer: () => [],
    replaceMetadataServiceTotals: () => {},
  } as unknown as BuyerChannelStore;
}

async function sessionSignedUpTo(cumulative: bigint) {
  const wallet = Wallet.createRandom();
  const manager = new BuyerPaymentManager(
    { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), wallet },
    {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: `0x${'dd'.repeat(20)}`,
      channelsContractAddress: `0x${'cc'.repeat(20)}`,
      usdcAddress: `0x${'ee'.repeat(20)}`,
      identityRegistryAddress: `0x${'ff'.repeat(20)}`,
      chainId: 31337,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: MAX_PER_REQUEST,
      maxReserveAmountUsdc: 10_000_000n,
      dataDir: '/nonexistent',
    },
    memoryChannelStore(),
  );
  const sent: SpendingAuthPayload[] = [];
  const mux = {
    sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload); },
    sendReserveAuth: () => {},
  } as unknown as PaymentMux;

  const channelId = await manager.authorizeSpending(SELLER, mux, 10_000n);
  await manager.handleAuthAck(SELLER, { channelId });
  await manager.handleNeedAuth(SELLER, {
    channelId,
    requiredCumulativeAmount: cumulative.toString(),
    currentAcceptedCumulative: '0',
    deposit: '10000000',
    lastRequestCost: cumulative.toString(),
  }, mux);
  expect(manager.getCumulativeAmount(SELLER)).toBe(cumulative);
  sent.length = 0;
  return { manager, mux, sent };
}

describe('BuyerPaymentManager 402 catch-up', () => {
  it('signs exactly the seller-required cumulative, without adding minBudgetPerRequest on top', async () => {
    const { manager, mux, sent } = await sessionSignedUpTo(1_000n);

    await manager.extendCurrentSpendingAuth(SELLER, 500_000n, mux, 4_000n);

    expect(sent.map((auth) => auth.cumulativeAmount)).toEqual(['4000']);
    expect(manager.getCumulativeAmount(SELLER)).toBe(4_000n);
  });

  it('caps the seller-required cumulative at verified spend plus maxPerRequestUsdc', async () => {
    const { manager, mux, sent } = await sessionSignedUpTo(1_000n);

    await manager.extendCurrentSpendingAuth(SELLER, 500_000n, mux, 5_000_000n);

    expect(sent.map((auth) => auth.cumulativeAmount)).toEqual([(1_000n + MAX_PER_REQUEST).toString()]);
  });
});
