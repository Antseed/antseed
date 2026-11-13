/**
 * Balance arithmetic for the buyer's deposits.
 *
 * Three numbers describe the same pot of money and none of them alone answers
 * "how much do I have left?":
 *
 *   - deposited  — everything in AntseedDeposits for this buyer.
 *   - reserved   — the slice locked into open payment channels. Reserving does
 *                  not spend it; closing a channel hands the remainder back.
 *   - pending    — signed away via SpendingAuth but not settled on-chain yet.
 *                  Nothing has moved, yet the seller can claim it at will.
 *
 * So the honest headline is deposited - pending: reserving money must not make
 * the balance appear to drop, and authorizing spend must not let it linger.
 * The gateway reports pending with the deposits (`GET /v1/key`).
 */

export type CreditsBalanceComponents = {
  available: bigint;
  reserved: bigint;
  pending: bigint;
  wallet: bigint;
};

export type CreditsBalanceTotals = CreditsBalanceComponents & {
  deposited: bigint;
  spendable: bigint;
  totalOwned: bigint;
};

/**
 * What the buyer actually still owns. Clamped at zero: pending is measured
 * against the local channel store while the deposit total comes from the
 * chain, so a settle landing between the two reads can briefly make pending
 * look like the larger number.
 */
export function spendableBalance(deposited: bigint, pending: bigint): bigint {
  return deposited > pending ? deposited - pending : 0n;
}

/** Everything the buyer still owns, including USDC waiting in its wallet. */
export function totalOwnedBalance(spendable: bigint, wallet: bigint): bigint {
  return spendable + wallet;
}

/** Derive every displayed total from one internally consistent snapshot. */
export function creditsBalanceTotals(components: CreditsBalanceComponents): CreditsBalanceTotals {
  const deposited = components.available + components.reserved;
  const spendable = spendableBalance(deposited, components.pending);
  return {
    ...components,
    deposited,
    spendable,
    totalOwned: totalOwnedBalance(spendable, components.wallet),
  };
}
