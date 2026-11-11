export type HeadlineBalanceState = {
  creditsTotalOwnedUsdc: string;
};

/** The buyer's complete owned balance, including USDC awaiting deposit sweep. */
export function selectHeadlineBalanceUsdc(state: HeadlineBalanceState): string {
  return state.creditsTotalOwnedUsdc;
}

/**
 * Whether the user can pay a seller. An unread balance counts as yes, so a
 * funded user's model isn't moved or pinned before the balance is in.
 */
export function selectHasFunds(state: {
  creditsBalanceKnown: boolean;
  creditsTotalOwnedUsdc: string;
  gatewayStatus?: { mode: string } | null;
}): boolean {
  // On a remote gateway these are the gateway's figures for the wallet behind
  // the app's key; one that doesn't report them stays unknown, so counts as yes.
  return !state.creditsBalanceKnown || Number(state.creditsTotalOwnedUsdc) > 0;
}
