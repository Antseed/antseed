export type ChannelCloseAction = 'seller-and-on-chain' | 'on-chain' | 'withdraw' | 'none';
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
