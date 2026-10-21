import { getAddress } from 'ethers';
import { formatAntsExact, type ReferralView, type ReferredBuyersView } from '@antseed/ants/service';
import { friendlyNetworkError } from './utils.js';

export type InviteAllowance = { epoch: number; quota: number; used: number; left: number };

/** This wallet as a referrer, for the rewards view. ANTS are decimal strings. */
export type ReferralInvites = {
  available: boolean;
  /** False when no Antscan explorer lists this network's referrals. */
  listed: boolean;
  /** Invites for this week (Antscan, else the Referrals contract); null when neither reports them. */
  allowance: InviteAllowance | null;
  /** `pendingPoints`: usage in weeks that are not claimable yet (no ANTS value yet). */
  buyers: Array<{ buyer: string; points: string; ants: string; pendingPoints: string }>;
  /** Sums over `buyers`. */
  totals: { points: string; ants: string; pendingPoints: string };
  error: string | null;
};

const NO_TOTALS = { points: '0', ants: '0', pendingPoints: '0' };
export const NO_INVITES: ReferralInvites = { available: false, listed: false, allowance: null, buyers: [], totals: NO_TOTALS, error: null };

/**
 * The card (allowance) and the referred-buyer list are read independently:
 * a failing list (explorer timeout, HTTP error, an older explorer without the
 * endpoint) is reported as an error but never drops an allowance the card
 * read, so the remaining-invites count stays right.
 */
export function combineInviteReads(
  cardRead: PromiseSettledResult<ReferralView>,
  listRead: PromiseSettledResult<ReferredBuyersView>,
): ReferralInvites {
  const allowance = cardRead.status === 'fulfilled' ? cardRead.value.invites : null;
  const cardError = cardRead.status === 'rejected' ? friendlyNetworkError(cardRead.reason) : null;
  if (listRead.status === 'rejected') {
    return { ...NO_INVITES, available: true, listed: true, allowance, error: cardError ?? friendlyNetworkError(listRead.reason) };
  }
  const list = listRead.value;
  if (!list.available) return { ...NO_INVITES, available: true, allowance };
  const sum = (key: 'points' | 'ants' | 'pendingPoints') => list.buyers.reduce((total, row) => total + BigInt(row[key]), 0n).toString();
  return {
    available: true,
    listed: true,
    allowance,
    buyers: list.buyers.map((row) => ({ buyer: getAddress(row.buyer), points: row.points, ants: formatAntsExact(row.ants), pendingPoints: row.pendingPoints })),
    totals: { points: sum('points'), ants: formatAntsExact(sum('ants')), pendingPoints: sum('pendingPoints') },
    error: cardError,
  };
}
