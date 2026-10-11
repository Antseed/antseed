import { channelRecoverableBaseUnits, isFundedCurrentChannel } from './vpr-activity-close';

/**
 * One answer to "can I use Antseed right now, and if not, what do I do?".
 *
 * The buyer's money sits in three places with different rules, and a single
 * balance number hides all of them:
 *
 *   - deposit wallet — USDC received on Base but not yet in credits. A sweep
 *     moves it in, minus the relay fee, and only once it clears the
 *     contract's first-deposit floor (min + fee in the wallet).
 *   - reserved — credits locked for an open seller session. That seller can
 *     keep drawing on it; nobody else can until the session closes.
 *   - available — credits a new session (or the next block of an existing
 *     one) can lock.
 *
 * Every new session locks SESSION_RESERVE at a time, so "available" below
 * that blocks the next session even when the headline balance looks fine.
 */

/**
 * What a session locks per block: the buyer's default `maxReserveAmountUsdc`
 * and the seller's default suggested amount (both $1.00). A 402 carries the
 * exact figure for a specific seller; this is the planning number.
 */
export const SESSION_RESERVE_BASE_UNITS = 1_000_000n;

export type FundingStatusKind =
  | 'empty'
  | 'wallet-below-minimum'
  | 'depositing'
  | 'wallet-at-limit'
  | 'all-reserved'
  | 'low-available'
  | 'wallet-dust'
  | 'ready';

export type FundingAction = 'add-funds' | 'manage-sessions';

export type FundingSession = {
  sellerName: string;
  /** Locked for this session on-chain (base units). */
  heldBaseUnits: bigint;
  /** Of the held amount, what is not yet signed away (base units). */
  unusedBaseUnits: bigint;
};

export type FundingStatus = {
  kind: FundingStatusKind;
  /** warning blocks paid use; info explains something in flight; ok is silent. */
  tone: 'ok' | 'info' | 'warning';
  title: string;
  body: string;
  /** USDC to send to the deposit wallet to clear the blocker, fee included. */
  sendMoreBaseUnits: bigint | null;
  actions: FundingAction[];
  sessions: FundingSession[];
};

export type FundingInputs = {
  /** Decimal USDC strings, as CreditsInfo reports them. */
  available: string;
  reserved: string;
  wallet: string;
  creditLimit: string;
  minFirstDeposit: string;
  depositFee: string;
  channels?: ReadonlyArray<{
    peerId: string;
    sellerDisplayName: string | null;
    status: string;
    onChainStateKnown: boolean;
    onChainDeposit: string;
    onChainSettled: string;
    cumulativeSigned: string;
  }>;
};

/** Decimal USDC string → base units. Malformed input reads as zero. */
export function usdcToBaseUnits(value: string | null | undefined): bigint {
  const match = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(value ?? '');
  if (!match || (!match[1] && !match[2])) return 0n;
  const whole = BigInt(match[1] || '0');
  const fraction = BigInt(((match[2] ?? '') + '000000').slice(0, 6));
  return whole * 1_000_000n + fraction;
}

/**
 * Base units → "$1.05". Balances round to the nearest cent; amounts the user
 * must send round up, so a shortfall is never understated.
 */
export function formatUsd(baseUnits: bigint, rounding: 'nearest' | 'up' = 'nearest'): string {
  const cents = (baseUnits + (rounding === 'up' ? 9_999n : 5_000n)) / 10_000n;
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function sellerLabel(channel: { peerId: string; sellerDisplayName: string | null }): string {
  const name = channel.sellerDisplayName?.trim();
  if (name) return name;
  return channel.peerId ? `${channel.peerId.slice(0, 6)}…${channel.peerId.slice(-4)}` : 'a seller';
}

export function openFundingSessions(channels: FundingInputs['channels']): FundingSession[] {
  if (!channels) return [];
  const sessions: FundingSession[] = [];
  for (const channel of channels) {
    if (!channel.onChainStateKnown || !isFundedCurrentChannel(channel)) continue;
    let held = 0n;
    try {
      const deposit = BigInt(channel.onChainDeposit || '0');
      const settled = BigInt(channel.onChainSettled || '0');
      held = deposit > settled ? deposit - settled : 0n;
    } catch {
      continue;
    }
    if (held === 0n) continue;
    sessions.push({
      sellerName: sellerLabel(channel),
      heldBaseUnits: held,
      unusedBaseUnits: channelRecoverableBaseUnits(channel),
    });
  }
  return sessions.sort((a, b) => (b.heldBaseUnits > a.heldBaseUnits ? 1 : b.heldBaseUnits < a.heldBaseUnits ? -1 : 0));
}

function heldWithText(sessions: FundingSession[]): string {
  if (sessions.length === 0) return 'your open sessions';
  if (sessions.length === 1) return `your session with ${sessions[0]!.sellerName}`;
  return `${sessions.length} open sessions`;
}

export function deriveFundingStatus(inputs: FundingInputs): FundingStatus {
  const available = usdcToBaseUnits(inputs.available);
  const reserved = usdcToBaseUnits(inputs.reserved);
  const wallet = usdcToBaseUnits(inputs.wallet);
  const creditLimit = usdcToBaseUnits(inputs.creditLimit);
  const minFirst = usdcToBaseUnits(inputs.minFirstDeposit);
  const fee = usdcToBaseUnits(inputs.depositFee);
  const deposited = available + reserved;
  const sessions = openFundingSessions(inputs.channels);
  const firstDepositNeeds = minFirst + fee;
  const feeText = formatUsd(fee);

  const status = (
    kind: FundingStatusKind,
    tone: FundingStatus['tone'],
    title: string,
    body: string,
    sendMoreBaseUnits: bigint | null = null,
    actions: FundingAction[] = [],
  ): FundingStatus => ({ kind, tone, title, body, sendMoreBaseUnits, actions, sessions });

  // ── Nothing in credits yet: everything hinges on the first sweep. ──
  if (deposited === 0n) {
    if (wallet === 0n) {
      return status(
        'empty',
        'info',
        'Add credits to start',
        `Your first deposit needs at least ${formatUsd(firstDepositNeeds)}: the ${formatUsd(minFirst)} minimum plus a ${feeText} network fee.`,
        firstDepositNeeds,
        ['add-funds'],
      );
    }
    if (wallet < firstDepositNeeds) {
      const shortfall = firstDepositNeeds - wallet;
      return status(
        'wallet-below-minimum',
        'warning',
        `${formatUsd(wallet)} received — not enough to deposit yet`,
        `A first deposit needs ${formatUsd(firstDepositNeeds)} (${formatUsd(minFirst)} minimum + ${feeText} network fee). `
          + `Send ${formatUsd(shortfall, 'up')} more USDC on Base to the same address and it's added automatically. Your USDC is safe meanwhile.`,
        shortfall,
        ['add-funds'],
      );
    }
    return status(
      'depositing',
      'info',
      `Adding ${formatUsd(wallet - fee)} to your credits`,
      `${formatUsd(wallet)} arrived in your deposit wallet. It moves into your credits automatically, minus the ${feeText} network fee.`,
    );
  }

  // ── Credits exist; a top-up may be waiting in the wallet. ──
  // An unread credit limit (0) must not read as "at the limit".
  const headroom = creditLimit === 0n ? wallet : creditLimit > deposited ? creditLimit - deposited : 0n;
  const walletSweepable = wallet > fee && headroom > 0n;
  const walletAtLimit = wallet > fee && headroom === 0n && creditLimit > 0n;

  if (available < SESSION_RESERVE_BASE_UNITS) {
    // Money already on its way covers it — say so instead of asking for more.
    if (walletSweepable && available + (wallet - fee) >= SESSION_RESERVE_BASE_UNITS) {
      return status(
        'depositing',
        'info',
        `Adding ${formatUsd(wallet - fee)} to your credits`,
        `${formatUsd(wallet)} arrived in your deposit wallet. It moves into your credits automatically, minus the ${feeText} network fee.`,
      );
    }
    const blockText = formatUsd(SESSION_RESERVE_BASE_UNITS);
    const shortfall = SESSION_RESERVE_BASE_UNITS - available - (walletSweepable ? wallet - fee : 0n);
    const sendMore = shortfall + fee;
    if (reserved > 0n) {
      return status(
        'all-reserved',
        'warning',
        available === 0n
          ? `All your credits are held for ${heldWithText(sessions)}`
          : `Only ${formatUsd(available)} available — the rest is held for ${heldWithText(sessions)}`,
        `Held credits are still yours: that session keeps working, and what it doesn't use comes back when it closes. `
          + `A new session, or the next ${blockText} block of this one, needs ${blockText} available. `
          + `Add ${formatUsd(sendMore, 'up')}+ (incl. ${feeText} fee) or close a session you're done with.`,
        sendMore,
        ['add-funds', 'manage-sessions'],
      );
    }
    return status(
      'low-available',
      'warning',
      `${formatUsd(available)} left — below what a session needs`,
      `Each seller session sets aside ${blockText} at a time, so ${formatUsd(available)} can't start one. `
        + `Add ${formatUsd(sendMore, 'up')}+ (incl. ${feeText} fee). Your remaining credits stay yours.`,
      sendMore,
      ['add-funds'],
    );
  }

  if (walletAtLimit) {
    return status(
      'wallet-at-limit',
      'info',
      `${formatUsd(wallet)} waiting in your deposit wallet`,
      'Your credits are at the account limit. This USDC tops them up automatically as you spend.',
    );
  }
  if (walletSweepable) {
    return status(
      'depositing',
      'info',
      `Adding ${formatUsd(wallet - fee)} to your credits`,
      `${formatUsd(wallet)} arrived in your deposit wallet. It moves into your credits automatically, minus the ${feeText} network fee.`,
    );
  }
  if (wallet > 0n) {
    return status(
      'wallet-dust',
      'info',
      `${formatUsd(wallet)} in your deposit wallet`,
      `That's less than the ${feeText} network fee, so it can't be added on its own. It's included automatically with your next deposit.`,
    );
  }
  return status('ready', 'ok', 'Ready to use', '');
}
