/**
 * A fake AntseedChannels contract for tests that run the real buyer and seller
 * stacks: a map of channel records keyed by channelId that reserve(), topUp(),
 * settle() and close() mutate and getSession() reads. It follows the
 * contract's rules: `firstSignCap` caps reserve(), and topUp() settles the
 * authorized amount and needs 8500 bps of the old deposit settled first.
 */
import { vi } from 'vitest';
import { computeChannelId } from '@antseed/protocol/signatures';
import type { ChannelsClient } from '../../src/payments/evm/channels-client.js';

export interface ChainChannel { deposit: bigint; settled: bigint; status: number }

export interface FakeChannelChain {
  /** Channels the fake chain holds, by channel id. */
  chain: Map<string, ChainChannel>;
  reserve: ReturnType<typeof vi.fn>;
  topUp: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

export function fakeChannelChain(client: ChannelsClient, options: {
  buyerAddress: string;
  sellerAddress: string;
  firstSignCap: bigint;
  /** Runs before each topUp() lands: throw to revert it, or wait to hold it. */
  beforeTopUp?: () => Promise<void>;
}): FakeChannelChain {
  const chain = new Map<string, ChainChannel>();
  const channelOf = (channelId: string): ChainChannel => {
    const channel = chain.get(channelId);
    if (!channel) throw new Error('execution reverted: ChannelNotFound');
    return channel;
  };
  vi.spyOn(client, 'getFirstSignCap').mockResolvedValue(options.firstSignCap);
  vi.spyOn(client, 'getTopUpSettledThresholdBps').mockResolvedValue(8_500n);
  const reserve = vi.spyOn(client, 'reserve').mockImplementation(async (_signer, buyerAddr, salt, maxAmount) => {
    if (maxAmount > options.firstSignCap) throw new Error('execution reverted: FirstSignCapExceeded');
    const channelId = computeChannelId(buyerAddr, options.sellerAddress, salt);
    if (chain.has(channelId)) throw new Error('execution reverted: ChannelExists');
    chain.set(channelId, { deposit: maxAmount, settled: 0n, status: 1 });
    return '0xreserve';
  });
  const topUp = vi.spyOn(client, 'topUp').mockImplementation(async (_signer, channelId, cumulative, _meta, _sig, newMax) => {
    await options.beforeTopUp?.();
    const channel = channelOf(channelId);
    if (cumulative > channel.deposit) throw new Error('execution reverted: InvalidAmount');
    if (cumulative > channel.settled) channel.settled = cumulative;
    if (channel.settled * 10_000n < channel.deposit * 8_500n) throw new Error('execution reverted: TopUpThresholdNotMet');
    channel.deposit = newMax;
    return '0xtopup';
  });
  const close = vi.spyOn(client, 'close').mockImplementation(async (_signer, channelId, finalAmount) => {
    const channel = channelOf(channelId);
    if (channel.status !== 1) throw new Error('execution reverted: ChannelNotActive');
    if (finalAmount < channel.settled) throw new Error('execution reverted: FinalAmountBelowSettled');
    if (finalAmount > channel.deposit) throw new Error('execution reverted: InvalidAmount');
    channel.settled = finalAmount;
    channel.status = 2;
    return '0xclose';
  });
  vi.spyOn(client, 'settle').mockImplementation(async (_signer, channelId, amount) => {
    channelOf(channelId).settled = amount;
    return '0xsettle';
  });
  vi.spyOn(client, 'getSession').mockImplementation(async (channelId) => {
    const channel = chain.get(channelId) ?? { deposit: 0n, settled: 0n, status: 0 };
    return {
      buyer: options.buyerAddress, seller: options.sellerAddress,
      deposit: channel.deposit, settled: channel.settled, metadataHash: '0x' + '00'.repeat(32),
      deadline: 0n, settledAt: 0n, closeRequestedAt: 0n, status: channel.status,
    };
  });
  return {
    chain,
    reserve: reserve as unknown as ReturnType<typeof vi.fn>,
    topUp: topUp as unknown as ReturnType<typeof vi.fn>,
    close: close as unknown as ReturnType<typeof vi.fn>,
  };
}
