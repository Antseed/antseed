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
