import type { ChannelInfo } from './channels-client.js';
import { CHANNEL_STATUS } from './channel-store-types.js';

export type OnChainChannelStatus =
  | 'missing'
  | typeof CHANNEL_STATUS.ACTIVE
  | typeof CHANNEL_STATUS.SETTLED
  | typeof CHANNEL_STATUS.TIMEOUT
  | 'unknown';

export type OnChainChannelState =
  | { exists: false; status: 'missing' }
  | { exists: true; status: Exclude<OnChainChannelStatus, 'missing'>; channel: ChannelInfo };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function classifyOnChainChannel(channel: ChannelInfo): OnChainChannelState {
  const exists = channel.buyer !== ZERO_ADDRESS
    || channel.seller !== ZERO_ADDRESS
    || channel.deposit > 0n
    || channel.status !== 0;

  if (!exists) {
    return { exists: false, status: 'missing' };
  }

  if (channel.status === 1) {
    return { exists: true, status: CHANNEL_STATUS.ACTIVE, channel };
  }
  if (channel.status === 2) {
    return { exists: true, status: CHANNEL_STATUS.SETTLED, channel };
  }
  if (channel.status === 3) {
    return { exists: true, status: CHANNEL_STATUS.TIMEOUT, channel };
  }

  return { exists: true, status: 'unknown', channel };
}

export function matchesChannelParties(
  channel: ChannelInfo,
  buyerEvmAddr: string,
  sellerEvmAddr: string,
): boolean {
  return channel.buyer.toLowerCase() === buyerEvmAddr.toLowerCase()
    && channel.seller.toLowerCase() === sellerEvmAddr.toLowerCase();
}
