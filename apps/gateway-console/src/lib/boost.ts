/**
 * The model panel's Antseed Points line: what the seller serving the model
 * earns per $1 and, when another paid seller earns more, the best one to pin.
 * Free usage earns nothing (points are paid $ × boost), so free offers never
 * count as the best. Display only: routing does not use the boost.
 */
import type { NetworkModelOffer, Peer } from '../api/types'
import { BOOST_EARNING_MIN } from './format'
import { samePeerId } from './peer-id'

export interface BoostOption {
  peerId: string
  /** `<peerId>:<serviceId>`, the key the panel pins by. */
  key: string
  name: string
  /** null when Antscan is unreachable. */
  boost: number | null
  free: boolean
}

export interface ModelBoostSummary {
  /** The offer serving the model now (pinned, else automatic routing's first pick); null when unknown. */
  current: BoostOption | null
  /** The paid offer with the highest boost that earns anything; null when none does. */
  best: BoostOption | null
  /** The best offer earns more than the current one, so pinning it is worth offering. */
  better: boolean
}

/** One option per offer, with its seller's boost from the peer list. */
export function boostOptions(offers: readonly NetworkModelOffer[], peers: readonly Peer[] | undefined): BoostOption[] {
  return offers.map((offer) => ({
    peerId: offer.peerId,
    key: `${offer.peerId}:${offer.serviceId}`,
    name: offer.displayName ?? offer.peerId.slice(0, 10),
    boost: peers?.find((peer) => samePeerId(peer.peerId, offer.peerId))?.boost ?? null,
    free: offer.free,
  }))
}

/** Null when no boost is known (Antscan unreachable): show nothing rather than a false 0×. */
export function summarizeModelBoost(options: readonly BoostOption[], current: { key?: string; peerId?: string } | null): ModelBoostSummary | null {
  if (!options.some((option) => option.boost !== null)) return null
  const now = current?.key ? options.find((option) => option.key === current.key)
    : current?.peerId ? options.find((option) => samePeerId(option.peerId, current.peerId!))
      : undefined
  const best = options.reduce<BoostOption | null>((top, option) => {
    if (option.free || option.boost === null || option.boost < BOOST_EARNING_MIN) return top
    return top === null || option.boost > (top.boost ?? 0) ? option : top
  }, null)
  const nowEarns = now && !now.free ? now.boost ?? 0 : 0
  return { current: now ?? null, best, better: best !== null && !samePeerId(best.peerId, now?.peerId ?? '') && (best.boost ?? 0) > nowEarns }
}
