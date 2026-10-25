/**
 * The model page's Antseed Points line: what the seller serving the model
 * earns per $1 and, when another paid seller earns more, the best one to pin.
 * Free usage earns nothing (points are paid $ × boost), so free sellers never
 * count as the best. Display only: routing does not use the boost.
 */

import type { DiscoverRow } from '../../core/state';
import { BOOST_EARNING_MIN, isFreeRoute } from './seller-format';

export type BoostOption = {
  peerId: string;
  name: string;
  /** null when Antscan is unreachable. */
  boost: number | null;
  free: boolean;
};

export type ModelBoostSummary = {
  /** The seller serving the model now (auto pick or pin); null when none. */
  current: BoostOption | null;
  /** The paid seller with the highest boost that earns anything; null when none does. */
  best: BoostOption | null;
  /** The best seller earns more than the current one, so pinning it is worth offering. */
  better: boolean;
};

export function boostOptionFromRoute(route: DiscoverRow): BoostOption {
  return {
    peerId: route.peerId,
    name: route.peerDisplayName || route.peerLabel || route.peerId,
    boost: route.boost ?? null,
    free: isFreeRoute(route),
  };
}

/** Null when no seller's boost is known (Antscan unreachable): show nothing rather than a false 0×. */
export function summarizeModelBoost(options: readonly BoostOption[], currentPeerId: string | null | undefined): ModelBoostSummary | null {
  if (!options.some((option) => option.boost !== null)) return null;
  const current = options.find((option) => option.peerId === currentPeerId) ?? null;
  const best = options.reduce<BoostOption | null>((top, option) => {
    if (option.free || option.boost === null || option.boost < BOOST_EARNING_MIN) return top;
    return top === null || option.boost > (top.boost ?? 0) ? option : top;
  }, null);
  const currentEarns = current && !current.free ? current.boost ?? 0 : 0;
  return { current, best, better: best !== null && best.peerId !== current?.peerId && (best.boost ?? 0) > currentEarns };
}

export type SellerBoostChoice = { peerId: string; name: string; boost: number };

/**
 * Sellers worth spending with for points: one per seller, its best boost over
 * the paid models it serves, highest first. Free models and sellers under
 * 0.01× earn nothing, so they are left out.
 */
export function paidSellerBoosts(rows: readonly DiscoverRow[]): SellerBoostChoice[] {
  const best = new Map<string, SellerBoostChoice>();
  for (const row of rows) {
    if (isFreeRoute(row) || row.boost == null || row.boost < BOOST_EARNING_MIN) continue;
    const current = best.get(row.peerId);
    if (!current || row.boost > current.boost) {
      best.set(row.peerId, { peerId: row.peerId, name: row.peerDisplayName || row.peerLabel || row.peerId, boost: row.boost });
    }
  }
  return [...best.values()].sort((a, b) => b.boost - a.boost || a.name.localeCompare(b.name));
}
