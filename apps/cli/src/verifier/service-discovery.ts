import type { PeerInfo } from '@antseed/node'

/**
 * Enumerate the model/service catalog advertised by discovered peers, so
 * Group peer advertisements while preserving the original model spelling used
 * for outgoing verifier requests.
 *
 * A service id is a model id announced in the peer's signed metadata
 * (`metadata.providers[].services`) or priced in `providerPricing[*].services`.
 * Provider plugin names (e.g. "anthropic") are NOT services — audits target
 * model claims, not plugin names.
 *
 * Sellers match the request body's model field against their advertised
 * services CASE-SENSITIVELY, so the original advertised spelling must be
 * preserved for outgoing probe requests — `Qwen/Qwen3-32B` probed as
 * `qwen/qwen3-32b` would 404 forever. The normalized (lowercased) form is
 * used only for grouping, config matching, and hash/log keys.
 */
export interface DiscoveredService {
  /** Normalized (trimmed, lowercased) service/model id — grouping/config/hash key. */
  service: string
  /**
   * Canonical advertised spelling for outgoing requests: the most common
   * original spelling across peers (ties break to first seen).
   */
  advertised: string
  /** Per-peer advertised spelling (peerId → exactly what that peer announces). */
  advertisedByPeer: Map<string, string>
  /** Every discovered peer that advertises this service. */
  peers: PeerInfo[]
}

/** Advertised services of one peer: normalized id → original spelling (first seen). */
export function advertisedServices(peer: PeerInfo): Map<string, string> {
  const services = new Map<string, string>()
  const add = (service: string): void => {
    const original = service.trim()
    if (original.length === 0) return
    const normalized = original.toLowerCase()
    if (!services.has(normalized)) services.set(normalized, original)
  }
  for (const announcement of peer.metadata?.providers ?? []) {
    for (const service of announcement.services ?? []) add(service)
  }
  for (const entry of Object.values(peer.providerPricing ?? {})) {
    for (const service of Object.keys(entry.services ?? {})) add(service)
  }
  return services
}

/**
 * Group peers by advertised service, most-advertised first. Ties break
 * alphabetically so round ordering is stable across runs.
 */
export function discoverServices(peers: readonly PeerInfo[]): DiscoveredService[] {
  interface Group {
    peers: PeerInfo[]
    advertisedByPeer: Map<string, string>
    spellingCounts: Map<string, number>
  }
  const byService = new Map<string, Group>()
  for (const peer of peers) {
    for (const [service, original] of advertisedServices(peer)) {
      let group = byService.get(service)
      if (!group) {
        group = { peers: [], advertisedByPeer: new Map(), spellingCounts: new Map() }
        byService.set(service, group)
      }
      group.peers.push(peer)
      group.advertisedByPeer.set(peer.peerId, original)
      group.spellingCounts.set(original, (group.spellingCounts.get(original) ?? 0) + 1)
    }
  }
  return [...byService.entries()]
    .map(([service, group]) => {
      let advertised = service
      let best = 0
      for (const [spelling, count] of group.spellingCounts) {
        if (count > best) {
          advertised = spelling
          best = count
        }
      }
      return { service, advertised, advertisedByPeer: group.advertisedByPeer, peers: group.peers }
    })
    .sort((a, b) => b.peers.length - a.peers.length || a.service.localeCompare(b.service))
}
