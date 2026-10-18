/**
 * Routing policies in plain sentences, and which level of the policy chain
 * keeps a seller out of a model's route. Client-side, like `policy-match`:
 * the buyer stays authoritative, the route preview shows the real result.
 */
import type { Peer, PeerList, RoutePreview, RoutingPolicy } from '../api/types'
import { formatPricePerMillion, shortId } from './format'
import { normalizePeerId } from './peer-id'
import { expandLists } from './policy-match'

function names(peerIds: readonly string[], peers: readonly Peer[] | undefined, max = 3): string {
  const named = peerIds.map((id) => peers?.find((peer) => normalizePeerId(peer.peerId) === normalizePeerId(id))?.displayName ?? shortId(id, 8, 4))
  if (named.length <= max) return named.join(', ')
  return `${named.slice(0, max).join(', ')} and ${named.length - max} more`
}

function listNames(ids: readonly string[] | undefined, lists: readonly PeerList[]): string {
  return (ids ?? []).map((id) => `the “${lists.find((list) => list.id === id)?.name ?? id}” list`).join(', ')
}

/** The policy as short sentences, most restrictive first. Empty when it adds nothing. */
export function policySentences(policy: RoutingPolicy | null | undefined, peers: readonly Peer[] | undefined, lists: readonly PeerList[] = []): string[] {
  if (!policy) return []
  const p = policy
  const out: string[] = []
  if (p.allowedModels) out.push(p.allowedModels.length === 0 ? 'No model is allowed.' : `Only these models: ${p.allowedModels.join(', ')}.`)
  if (p.allowedPeerIds || p.allowedPeerLists) {
    const parts = [p.allowedPeerIds?.length ? names(p.allowedPeerIds, peers) : '', listNames(p.allowedPeerLists, lists)].filter(Boolean)
    out.push(parts.length ? `Only these sellers: ${parts.join(', ')}.` : 'No seller is allowed.')
  }
  if (p.blockedPeerIds?.length || p.blockedPeerLists?.length) {
    const parts = [p.blockedPeerIds?.length ? names(p.blockedPeerIds, peers) : '', listNames(p.blockedPeerLists, lists)].filter(Boolean)
    out.push(`Never uses ${parts.join(', ')}.`)
  }
  if (p.requireTee) out.push('Only sellers running in a TEE.')
  if (p.requireVerified) out.push('Only sellers with a verified domain or GitHub account.')
  if (p.minTrustScore !== undefined) out.push(`Only sellers with trust ${p.minTrustScore} or more.`)
  if (p.minReputation !== undefined) out.push(`Only sellers with reputation ${p.minReputation} or more.`)
  const caps = [
    p.maxInputUsdPerMillion !== undefined ? `${formatPricePerMillion(p.maxInputUsdPerMillion)}/M input` : null,
    p.maxOutputUsdPerMillion !== undefined ? `${formatPricePerMillion(p.maxOutputUsdPerMillion)}/M output` : null,
    p.maxCachedInputUsdPerMillion !== undefined ? `${formatPricePerMillion(p.maxCachedInputUsdPerMillion)}/M cached input` : null,
    p.maxImageUsdPerImage !== undefined ? `$${p.maxImageUsdPerImage} per image` : null,
  ].filter((cap): cap is string => cap !== null)
  if (caps.length) out.push(`Pays at most ${caps.join(', ')}.`)
  for (const [model, route] of Object.entries(p.modelRoutes ?? {})) {
    out.push(`For ${model}: tries ${names(route.peerIds, peers, 4).replace(/, ([^,]*)$/, ', then $1')} first${route.strict ? ', and no other seller' : ''}.`)
  }
  if (p.sort === 'price') out.push('Ranks the cheapest seller first.')
  else if (p.sort === 'latency') out.push('Ranks the fastest seller first.')
  else if (p.sort === 'trust') out.push('Ranks the most trusted seller first.')
  if (p.preferFreePeers) out.push('Free sellers first.')
  return out
}

type Candidate = RoutePreview['candidates'][number]
type Source = RoutePreview['sources'][number]

/** Why a level's policy keeps the candidate out, or null when it does not. */
function exclusion(policy: RoutingPolicy, candidate: Candidate, peer: Peer | undefined, model: string): string | null {
  const id = normalizePeerId(candidate.peerId)
  if (policy.blockedPeerIds?.some((entry) => normalizePeerId(entry) === id)) return 'blocks it'
  if (policy.allowedPeerIds && !policy.allowedPeerIds.some((entry) => normalizePeerId(entry) === id)) return 'does not allow it'
  if (policy.requireTee && peer && !peer.tee) return 'requires a TEE'
  if (policy.requireVerified && peer && !peer.verified) return 'requires a verified seller'
  if (policy.minTrustScore !== undefined && (candidate.trustScore ?? 0) < policy.minTrustScore) return `requires trust ${policy.minTrustScore}+ (it has ${Math.round(candidate.trustScore ?? 0)})`
  if (policy.minReputation !== undefined && peer && (peer.reputationScore ?? 0) < policy.minReputation) return `requires reputation ${policy.minReputation}+`
  if (policy.maxInputUsdPerMillion !== undefined && candidate.inputUsdPerMillion !== null && candidate.inputUsdPerMillion > policy.maxInputUsdPerMillion) {
    return `caps input at ${formatPricePerMillion(policy.maxInputUsdPerMillion)}/M (it asks ${formatPricePerMillion(candidate.inputUsdPerMillion)})`
  }
  if (policy.maxOutputUsdPerMillion !== undefined && candidate.outputUsdPerMillion !== null && candidate.outputUsdPerMillion > policy.maxOutputUsdPerMillion) {
    return `caps output at ${formatPricePerMillion(policy.maxOutputUsdPerMillion)}/M (it asks ${formatPricePerMillion(candidate.outputUsdPerMillion)})`
  }
  const route = policy.modelRoutes?.[model]
  if (route?.strict && !route.peerIds.some((entry) => normalizePeerId(entry) === id)) return 'only allows its route for this model'
  return null
}

export interface LevelExclusion {
  level: Source['level']
  levelId: string | null
  rule: string
}

/** The levels that keep an ineligible candidate out, top to bottom. Empty when no policy level explains it (the buyer itself skipped it). */
export function exclusionsFor(preview: RoutePreview, candidate: Candidate, peers: readonly Peer[] | undefined, lists: readonly PeerList[] = []): LevelExclusion[] {
  if (candidate.eligible) return []
  const peer = peers?.find((entry) => normalizePeerId(entry.peerId) === normalizePeerId(candidate.peerId))
  return preview.sources.flatMap((source) => {
    if (!source.policy) return []
    const rule = exclusion(expandLists(source.policy, lists), candidate, peer, preview.model)
    return rule ? [{ level: source.level, levelId: source.id, rule }] : []
  })
}

/** How many of the preview's sellers each level keeps out, by level. */
export function exclusionCounts(preview: RoutePreview | undefined, peers: readonly Peer[] | undefined, lists: readonly PeerList[] = []): Map<Source['level'], number> {
  const counts = new Map<Source['level'], number>()
  for (const candidate of preview?.candidates ?? []) {
    for (const level of new Set(exclusionsFor(preview!, candidate, peers, lists).map((entry) => entry.level))) {
      counts.set(level, (counts.get(level) ?? 0) + 1)
    }
  }
  return counts
}
