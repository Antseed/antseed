import type { Peer } from '../api/types'

export interface PeerFilter {
  search: string
  model: string
  tee: boolean
  /** Only providers with a verified domain or GitHub. */
  linked: boolean
  free: boolean
}

function servicesFor(peer: Peer, model: string) {
  return model ? peer.services.filter((service) => service.service === model) : peer.services
}

type PriceSide = 'inputUsdPerMillion' | 'outputUsdPerMillion'

export interface PriceRange {
  min: number
  max: number
}

/** Cheapest to dearest price on one side across the peer's services (for the chosen model, if any). */
export function priceRange(peer: Peer, side: PriceSide, model = ''): PriceRange | null {
  const prices = servicesFor(peer, model).map((service) => service[side]).filter((price): price is number => price !== null)
  return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null
}

/** Cheapest input price across the peer's services (for the chosen model, if any). */
export function inputPrice(peer: Peer, model = ''): number | null {
  return priceRange(peer, 'inputUsdPerMillion', model)?.min ?? null
}

export function outputPrice(peer: Peer, model = ''): number | null {
  return priceRange(peer, 'outputUsdPerMillion', model)?.min ?? null
}

export function isFreePeer(peer: Peer, model = ''): boolean {
  return servicesFor(peer, model).some((service) => service.paid !== undefined
    ? !service.paid
    : service.inputUsdPerMillion === 0 && (service.outputUsdPerMillion ?? 0) === 0)
}

/** Charges for at least one service (for the chosen model, if any). Only paid usage earns Antseed Points. */
export function isPaidPeer(peer: Peer, model = ''): boolean {
  return servicesFor(peer, model).some((service) => (service.inputUsdPerMillion ?? 0) > 0 || (service.outputUsdPerMillion ?? 0) > 0)
}

export function filterPeers(peers: readonly Peer[], filter: PeerFilter): Peer[] {
  const needle = filter.search.trim().toLowerCase()
  return peers.filter((peer) => {
    if (needle && !peer.peerId.toLowerCase().includes(needle) && !(peer.displayName ?? '').toLowerCase().includes(needle)
      && !peer.services.some((service) => service.service.toLowerCase().includes(needle))) return false
    if (filter.model && !peer.services.some((service) => service.service === filter.model)) return false
    if (filter.tee && !peer.tee) return false
    if (filter.linked && !peer.verificationLinks?.length) return false
    if (filter.free && !isFreePeer(peer, filter.model)) return false
    return true
  })
}
