import type { Peer, PeerList, RoutingPolicy } from '../api/types'
import { normalizePeerId } from './peer-id'

/**
 * Client-side approximation of the gateway's policy combination and seller
 * filtering, for live feedback in the editor ("matches 0 sellers"). The
 * gateway and buyer stay authoritative; the route preview shows the real
 * result for a model.
 */

function intersect(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const right = new Set(b.map(normalizePeerId))
  return a.filter((value) => right.has(normalizePeerId(value)))
}

function union(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return [...new Set([...a, ...b])]
}

/** Two optional values combined with `pick`; a missing one leaves the other. */
function either<T>(a: T | undefined, b: T | undefined, pick: (a: T, b: T) => T): T | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return pick(a, b)
}

const higher = (a?: number, b?: number) => either(a, b, Math.max)
const lower = (a?: number, b?: number) => either(a, b, Math.min)
const sameModels = (a: string[], b: string[]) => a.filter((model) => b.some((other) => other.toLowerCase() === model.toLowerCase()))

/** Replaces peer list references with their members (a missing list contributes nobody). */
export function expandLists(policy: RoutingPolicy, lists: readonly PeerList[]): RoutingPolicy {
  const { allowedPeerLists, blockedPeerLists, ...rest } = policy
  const members = (ids: string[]) => ids.flatMap((id) => lists.find((list) => list.id === id)?.peerIds ?? [])
  const out: RoutingPolicy = { ...rest }
  if (allowedPeerLists !== undefined) out.allowedPeerIds = [...(rest.allowedPeerIds ?? []), ...members(allowedPeerLists)]
  if (blockedPeerLists?.length) out.blockedPeerIds = [...(rest.blockedPeerIds ?? []), ...members(blockedPeerLists)]
  return out
}

/** Restrictions accumulate from parent to child, like the gateway's `narrowPolicy`. */
export function combinePolicies(...levels: Array<RoutingPolicy | null | undefined>): RoutingPolicy {
  let result: RoutingPolicy = {}
  for (const level of levels) {
    if (!level) continue
    const next: RoutingPolicy = {
      allowedPeerIds: intersect(result.allowedPeerIds, level.allowedPeerIds),
      blockedPeerIds: union(result.blockedPeerIds, level.blockedPeerIds),
      minTrustScore: higher(result.minTrustScore, level.minTrustScore),
      minReputation: higher(result.minReputation, level.minReputation),
      requireVerified: result.requireVerified || level.requireVerified ? true : undefined,
      requireTee: result.requireTee || level.requireTee ? true : undefined,
      maxInputUsdPerMillion: lower(result.maxInputUsdPerMillion, level.maxInputUsdPerMillion),
      maxOutputUsdPerMillion: lower(result.maxOutputUsdPerMillion, level.maxOutputUsdPerMillion),
      maxCachedInputUsdPerMillion: lower(result.maxCachedInputUsdPerMillion, level.maxCachedInputUsdPerMillion),
      maxImageUsdPerImage: lower(result.maxImageUsdPerImage, level.maxImageUsdPerImage),
      preferFreePeers: level.preferFreePeers ?? result.preferFreePeers,
      sort: level.sort ?? result.sort,
      allowedModels: either(result.allowedModels, level.allowedModels, sameModels),
      modelRoutes: level.modelRoutes || result.modelRoutes ? { ...(result.modelRoutes ?? {}), ...(level.modelRoutes ?? {}) } : undefined,
    }
    result = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as RoutingPolicy
  }
  return result
}

function serviceFits(policy: RoutingPolicy, service: Peer['services'][number]): boolean {
  if (policy.allowedModels && !policy.allowedModels.some((model) => model.toLowerCase() === service.service.toLowerCase())) return false
  const over = (price: number | null, cap: number | undefined) => cap !== undefined && price !== null && price > cap
  if (over(service.inputUsdPerMillion, policy.maxInputUsdPerMillion)) return false
  if (over(service.outputUsdPerMillion, policy.maxOutputUsdPerMillion)) return false
  if (over(service.cachedInputUsdPerMillion, policy.maxCachedInputUsdPerMillion)) return false
  return true
}

/** Sellers the policy leaves eligible for at least one of their models. */
export function matchingPeers(policy: RoutingPolicy, peers: readonly Peer[], lists: readonly PeerList[] = []): Peer[] {
  const p = expandLists(policy, lists)
  const allowed = p.allowedPeerIds ? new Set(p.allowedPeerIds.map(normalizePeerId)) : null
  const blocked = new Set((p.blockedPeerIds ?? []).map(normalizePeerId))
  return peers.filter((peer) => {
    const id = normalizePeerId(peer.peerId)
    if (blocked.has(id)) return false
    if (allowed && !allowed.has(id)) return false
    if (p.minTrustScore !== undefined && (peer.trustScore ?? 0) < p.minTrustScore) return false
    if (p.minReputation !== undefined && (peer.reputationScore ?? 0) < p.minReputation) return false
    if (p.requireVerified && !peer.verified) return false
    if (p.requireTee && !peer.tee) return false
    return peer.services.some((service) => serviceFits(p, service))
  })
}

/** Whether any seller has a reputation score (the buyer reports its own score when it has one). */
export function hasReputationData(peers: readonly Peer[] | undefined): boolean {
  return !!peers && peers.some((peer) => peer.reputationScore !== null)
}
