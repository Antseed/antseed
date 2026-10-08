import type { Peer } from '../api/types'

export interface PeerFilter {
  search: string
  model: string
  tee: boolean
  verified: boolean
  free: boolean
}

function servicesFor(peer: Peer, model: string) {
  return model ? peer.services.filter((service) => service.service === model) : peer.services
}

/** Cheapest input price across the peer's services (for the chosen model, if any). */
export function inputPrice(peer: Peer, model = ''): number | null {
  const prices = servicesFor(peer, model).map((service) => service.inputUsdPerMillion).filter((price): price is number => price !== null)
  return prices.length ? Math.min(...prices) : null
}

export function outputPrice(peer: Peer, model = ''): number | null {
  const prices = servicesFor(peer, model).map((service) => service.outputUsdPerMillion).filter((price): price is number => price !== null)
  return prices.length ? Math.min(...prices) : null
}

export function isFreePeer(peer: Peer, model = ''): boolean {
  return servicesFor(peer, model).some((service) => service.inputUsdPerMillion === 0 && (service.outputUsdPerMillion ?? 0) === 0)
}

export function filterPeers(peers: readonly Peer[], filter: PeerFilter): Peer[] {
  const needle = filter.search.trim().toLowerCase()
  return peers.filter((peer) => {
    if (needle && !peer.peerId.toLowerCase().includes(needle) && !(peer.displayName ?? '').toLowerCase().includes(needle)
      && !peer.services.some((service) => service.service.toLowerCase().includes(needle))) return false
    if (filter.model && !peer.services.some((service) => service.service === filter.model)) return false
    if (filter.tee && !peer.tee) return false
    if (filter.verified && !peer.verified) return false
    if (filter.free && !isFreePeer(peer, filter.model)) return false
    return true
  })
}
