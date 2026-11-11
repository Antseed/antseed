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
 */

/** The shape this module needs from a channel row. */
export type ChannelSpendRow = {
  status: string;
  /** Cumulative amount the buyer has signed for on this channel (base units). */
  cumulativeSigned: string;
  /** Amount already settled on-chain for this channel (base units). */
  onChainSettled: string;
  /** True once the chain was read for this channel; then onChainDeposit is its reserve. */
  onChainStateKnown?: boolean;
  /** Amount the channel locks on-chain (base units): the most a seller can settle on it now. */
  onChainDeposit?: string;
  /** Deadline (unix seconds) of the latest ReserveAuth the buyer signed for it; 0 when unknown. */
  deadline?: number;
};

/**
 * A top-up can land until its ReserveAuth's deadline; this much later, a local
 * clock running ahead of the chain's cannot have cut it short.
 */
const TOP_UP_DEADLINE_GRACE_SECS = 60 * 60;

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

/** Statuses where the seller can still settle against the buyer's signatures. */
export function isOpenChannelStatus(status: string): boolean {
  return status === 'active' || status === 'open' || status === 'pending'
    || status === 'closing' || status === 'close_requested' || status === 'withdrawable';
}

/**
 * Signed but not yet settled on one channel, in USDC base units. settle()
 * refuses more than the deposit, so once no top-up the buyer signed can raise
 * it (a close was requested, or its deadline passed) only that much counts.
 */
export function unsettledSpend(row: ChannelSpendRow, nowSeconds = Math.floor(Date.now() / 1000)): bigint {
  try {
    const signed = BigInt(row.cumulativeSigned || '0');
    const settled = BigInt(row.onChainSettled || '0');
    const closing = row.status === 'closing' || row.status === 'withdrawable';
    const toppedUpBefore = row.deadline ? row.deadline + TOP_UP_DEADLINE_GRACE_SECS : Infinity;
    let claimable = signed;
    if (row.onChainStateKnown && (closing || nowSeconds > toppedUpBefore)) {
      const deposit = BigInt(row.onChainDeposit || '0');
      if (deposit < signed) claimable = deposit;
    }
    return claimable > settled ? claimable - settled : 0n;
  } catch {
    // Malformed row — skip it rather than poison the total.
    return 0n;
  }
}

/**
 * Total spend the buyer has authorized but not yet paid out, across every
 * channel a seller can still settle against.
 *
 * Rows that were never checked against the chain read as settled=0, which
 * overstates pending rather than understating it — the balance shown is then
 * conservative, never optimistic.
 */
export function pendingSpendFromChannels(channels: readonly ChannelSpendRow[]): bigint {
  let total = 0n;
  for (const row of channels) {
    if (!isOpenChannelStatus(row.status)) continue;
    total += unsettledSpend(row);
  }
  return total;
}

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

/** Merge only successful component reads into the last-known-good snapshot. */
export function updateCreditsBalanceComponents(
  current: CreditsBalanceComponents,
  updates: Partial<CreditsBalanceComponents>,
): CreditsBalanceComponents {
  return { ...current, ...updates };
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
