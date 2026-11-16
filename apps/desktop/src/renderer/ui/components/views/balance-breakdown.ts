export type BalanceBreakdownValues = {
  available: string;
  reserved: string;
  pending: string;
  wallet: string;
  totalOwned: string;
  creditLimit: string;
  deposited: string;
};

export function hasPositiveAmount(value: string): boolean {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

export type BalanceSplitPart = {
  label: string;
  value: string;
  /** Links to the payment channels in the gateway console, the one place a session can be closed. */
  opensSessions: boolean;
};

/**
 * The parts of the balance that cannot start a new session, spelled out under
 * the headline; null when there are none. What sessions hold always links to
 * the gateway's channel list, whatever else the balance says: a session the
 * buyer gave up on keeps its reserve until it is closed there.
 */
export function balanceSplit(values: Pick<BalanceBreakdownValues, 'available' | 'reserved' | 'wallet'>): BalanceSplitPart[] | null {
  const held = hasPositiveAmount(values.reserved);
  const waiting = hasPositiveAmount(values.wallet);
  if (!held && !waiting) return null;
  return [
    { label: 'available', value: values.available, opensSessions: false },
    ...(held ? [{ label: 'held in sessions', value: values.reserved, opensSessions: true }] : []),
    ...(waiting ? [{ label: 'not deposited yet', value: values.wallet, opensSessions: false }] : []),
  ];
}

export function isEntireBalanceLocked(values: Pick<BalanceBreakdownValues, 'available' | 'reserved' | 'wallet'>): boolean {
  return hasPositiveAmount(values.reserved)
    && !hasPositiveAmount(values.available)
    && !hasPositiveAmount(values.wallet);
}

export function walletBalanceMessage(values: BalanceBreakdownValues): string {
  const wallet = Number(values.wallet);
  const deposited = Number(values.deposited);
  const creditLimit = Number(values.creditLimit);
  const headroom = Math.max(0, creditLimit - deposited);
  if (
    Number.isFinite(wallet)
    && Number.isFinite(deposited)
    && Number.isFinite(creditLimit)
    && creditLimit > 0
    && wallet > headroom
  ) {
    return 'Your on-chain credits are at or near the account limit. This USDC stays in your deposit wallet and tops up automatically as you spend.';
  }
  return 'This USDC is in your deposit wallet and is waiting to be added to the on-chain credits contract.';
}
