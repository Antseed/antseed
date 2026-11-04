import { getAddress } from 'ethers';
import { formatAntsExact, type ReferralView, type ReferredBuyersView } from '@antseed/ants/service';
import type { ReferralInvites } from '../shared/referrals.js';
import { friendlyNetworkError } from './utils.js';

const NO_TOTALS = { points: '0', ants: '0', pendingPoints: '0' };
export const NO_INVITES: ReferralInvites = { available: false, listed: false, allowance: null, buyers: [], totals: NO_TOTALS, payable: '0', claimableEpochs: [], error: null };

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
  const card = cardRead.status === 'fulfilled' ? cardRead.value : null;
  const allowance = card?.invites ?? null;
  const rewards = card?.indexed ? { payable: formatAntsExact(card.payable), claimableEpochs: card.claimableEpochs } : {};
  const cardError = cardRead.status === 'rejected' ? friendlyNetworkError(cardRead.reason) : null;
  if (listRead.status === 'rejected') {
    return { ...NO_INVITES, ...rewards, available: true, listed: true, allowance, error: cardError ?? friendlyNetworkError(listRead.reason) };
  }
  const list = listRead.value;
  if (!list.available) return { ...NO_INVITES, ...rewards, available: true, allowance };
  const sum = (key: 'points' | 'ants' | 'pendingPoints') => list.buyers.reduce((total, row) => total + BigInt(row[key]), 0n).toString();
  return {
    available: true,
    listed: true,
    allowance,
    buyers: list.buyers.map((row) => ({ buyer: getAddress(row.buyer), points: row.points, ants: formatAntsExact(row.ants), pendingPoints: row.pendingPoints })),
    totals: { points: sum('points'), ants: formatAntsExact(sum('ants')), pendingPoints: sum('pendingPoints') },
    payable: '0',
    claimableEpochs: [],
    ...rewards,
    error: cardError,
  };
}
