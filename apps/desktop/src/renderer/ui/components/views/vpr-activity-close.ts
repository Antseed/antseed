import type { CooperativeCloseResult, DesktopBridge } from '../../../types/bridge';

export type ChannelCloseAction = 'seller-and-on-chain' | 'on-chain' | 'withdraw' | 'none';

export type ChannelCloseFeedback = {
  tone: 'success' | 'error';
  message: string;
};

export function isCurrentChannelStatus(status: string): boolean {
  return status === 'active'
    || status === 'open'
    || status === 'closing'
    || status === 'withdrawable';
}

export function isFundedCurrentChannel(row: {
  status: string;
  onChainStateKnown: boolean;
  onChainDeposit: string;
  onChainSettled: string;
  cumulativeSigned: string;
}): boolean {
  if (!isCurrentChannelStatus(row.status)) return false;
  return !row.onChainStateKnown || channelRecoverableBaseUnits(row) > 0n;
}

/**
 * What the buyer can actually get back by closing: the on-chain reserve
 * minus spend already signed away. Sellers settle lazily (batched idle
 * settles, dust deltas skipped), so on-chain `settled` lags the buyer's
 * `cumulativeSigned` — counting only settled would present already-spent
 * funds as "locked".
 */
export function channelRecoverableBaseUnits(row: {
  onChainDeposit: string;
  onChainSettled: string;
  cumulativeSigned: string;
}): bigint {
  try {
    const reserved = BigInt(row.onChainDeposit || '0');
    const settled = BigInt(row.onChainSettled || '0');
    const signed = BigInt(row.cumulativeSigned || '0');
    const spent = signed > settled ? signed : settled;
    return reserved > spent ? reserved - spent : 0n;
  } catch {
    return 0n;
  }
}

export function formatChannelLockedAmount(row: {
  onChainStateKnown: boolean;
  onChainDeposit: string;
  onChainSettled: string;
  cumulativeSigned: string;
}): string {
  if (!row.onChainStateKnown) return 'Locked amount unavailable';
  const locked = channelRecoverableBaseUnits(row);
  if (locked === 0n) return 'No funds locked';
  if (locked < 10_000n) return '<$0.01 locked';
  const whole = locked / 1_000_000n;
  const cents = (locked % 1_000_000n) / 10_000n;
  return `$${whole}.${cents.toString().padStart(2, '0')} locked`;
}

export function compareChannelsByLockedAmount(
  left: { onChainDeposit: string; onChainSettled: string; cumulativeSigned: string; reservedAt: number },
  right: { onChainDeposit: string; onChainSettled: string; cumulativeSigned: string; reservedAt: number },
): number {
  const leftLocked = channelRecoverableBaseUnits(left);
  const rightLocked = channelRecoverableBaseUnits(right);
  if (leftLocked === rightLocked) return (right.reservedAt || 0) - (left.reservedAt || 0);
  return rightLocked > leftLocked ? 1 : -1;
}

export function channelCloseAction(
  status: string,
  cooperativeCloseSupported: boolean,
  cooperativeCloseFailed = false,
): ChannelCloseAction {
  if (status === 'active' || status === 'open') {
    return cooperativeCloseSupported && !cooperativeCloseFailed ? 'seller-and-on-chain' : 'on-chain';
  }
  if (status === 'withdrawable') return 'withdraw';
  return 'none';
}

export function cooperativeCloseRejectionMessage(result: CooperativeCloseResult): string {
  switch (result.code) {
    case 'busy':
      return 'The seller is still processing a request. Retry shortly.';
    case 'pending_auth':
      return 'The seller needs the latest payment authorization. Retry shortly.';
    case 'no_channel':
      return 'The seller no longer has this channel open. Refresh Activity to check its status.';
    case 'invalid_auth':
      return 'The seller could not verify the latest payment authorization. Use on-chain close instead.';
    case 'close_failed':
      return 'The seller could not close the channel. Use on-chain close instead.';
    case 'unsupported':
      return 'This seller does not support seller-assisted close. Use on-chain close instead.';
    default:
      return result.reason || 'The seller declined to close the channel. Use on-chain close instead.';
  }
}

export async function requestSellerAssistedClose(
  peerId: string,
  bridge: DesktopBridge | undefined,
  refresh: { credits: () => Promise<void>; summary: () => Promise<void> },
  channelId?: string,
): Promise<ChannelCloseFeedback> {
  if (!bridge?.paymentsRequestCooperativeClose) {
    return { tone: 'error', message: 'Seller-assisted close is unavailable. The channel is unchanged.' };
  }
  let response: Awaited<ReturnType<NonNullable<DesktopBridge['paymentsRequestCooperativeClose']>>>;
  try {
    response = await bridge.paymentsRequestCooperativeClose({ peerId, ...(channelId ? { channelId } : {}) });
  } catch {
    return { tone: 'error', message: 'The seller could not be reached. The channel is unchanged.' };
  }
  if (!response.ok || !response.result) {
    return {
      tone: 'error',
      message: response.error
        ? `${response.error} The channel is unchanged.`
        : 'The close request failed. The channel is unchanged.',
    };
  }
  if (response.result.status === 'rejected') {
    return { tone: 'error', message: cooperativeCloseRejectionMessage(response.result) };
  }
  await Promise.allSettled([
    Promise.resolve().then(refresh.credits),
    Promise.resolve().then(refresh.summary),
  ]);
  return { tone: 'success', message: 'Seller closed the channel.' };
}
