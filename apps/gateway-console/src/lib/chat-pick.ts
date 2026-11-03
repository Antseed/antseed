import type { ChatModel, ChatModelPeer, RoutePreview, RouteSelection } from '../api/types'

/** Filters and orderings for the chat's model and seller pickers (like the desktop app's model browser). */

export type ModelFilter = 'free' | 'tools' | 'reasoning' | 'vision' | 'tee'
export type ModelSort = 'popular' | 'price' | 'name'
export type PeerFilter = 'free' | 'tools' | 'tee'
export type PeerSort = 'auto' | 'price' | 'trust'

export const MODEL_FILTERS: Array<{ id: ModelFilter; label: string }> = [
  { id: 'free', label: 'Free' },
  { id: 'tools', label: 'Tools' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'vision', label: 'Vision' },
  { id: 'tee', label: 'TEE' },
]
export const MODEL_SORTS: Array<{ id: ModelSort; label: string }> = [
  { id: 'popular', label: 'Most sellers' },
  { id: 'price', label: 'Cheapest' },
  { id: 'name', label: 'Name' },
]
export const PEER_FILTERS: Array<{ id: PeerFilter; label: string }> = [
  { id: 'free', label: 'Free' },
  { id: 'tools', label: 'Tools' },
  { id: 'tee', label: 'TEE' },
]
export const PEER_SORTS: Array<{ id: PeerSort; label: string }> = [
  { id: 'auto', label: 'Routing order' },
  { id: 'price', label: 'Cheapest' },
  { id: 'trust', label: 'Trust' },
]

type Priced = {
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  freeTier?: { base: { stakersOnly?: boolean } } | null
}

/** Free to everyone: no price, and not reserved for the seller's stakers. */
export function isFreeOffer(offer: Priced): boolean {
  return offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0 && !offer.freeTier?.base.stakersOnly
}

/** Free only to buyers staked on its seller; others pay its price, or are not served. */
export function isStakerFreeOffer(offer: Priced): boolean {
  return offer.freeTier?.base.stakersOnly === true
}

/** Input + output per million, for ordering; unknown prices last. */
function totalPrice(offer: Priced): number {
  if (offer.inputUsdPerMillion === null || offer.outputUsdPerMillion === null) return Number.POSITIVE_INFINITY
  return offer.inputUsdPerMillion + offer.outputUsdPerMillion
}

function modelMatches(model: ChatModel, filter: ModelFilter): boolean {
  if (filter === 'free') return model.free
  if (filter === 'tools') return model.toolUse
  if (filter === 'reasoning') return model.reasoning
  if (filter === 'vision') return model.vision
  return model.tee
}

/** Models passing every chosen filter, in the chosen order. */
export function pickModels(models: readonly ChatModel[], filters: ReadonlySet<ModelFilter>, sort: ModelSort): ChatModel[] {
  const kept = models.filter((model) => [...filters].every((filter) => modelMatches(model, filter)))
  return kept.sort((a, b) => {
    if (sort === 'price') return totalPrice(a) - totalPrice(b) || b.offers - a.offers
    if (sort === 'name') return a.name.localeCompare(b.name)
    return b.offers - a.offers || a.name.localeCompare(b.name)
  })
}

/** How routing judges one seller right now, from the gateway's route preview for the chat key. */
export interface PeerVerdict {
  rank: number | null
  eligible: boolean
  reasons: string[]
  /** Eligible sellers: what routing has seen of them. */
  selection: RouteSelection | null
}

export function verdictsFrom(preview: RoutePreview | undefined): Map<string, PeerVerdict> {
  const verdicts = new Map<string, PeerVerdict>()
  for (const candidate of preview?.candidates ?? []) {
    verdicts.set(candidate.peerId.toLowerCase(), { rank: candidate.rank, eligible: candidate.eligible, reasons: candidate.reasons, selection: candidate.selection })
  }
  return verdicts
}

/** The seller automatic routing would try first, or null when none is eligible (or the preview is not in). */
export function autoPick(preview: RoutePreview | undefined): RoutePreview['candidates'][number] | null {
  if (!preview?.modelAllowed) return null
  return [...preview.candidates].filter((candidate) => candidate.eligible && candidate.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))[0] ?? null
}

function peerMatches(peer: ChatModelPeer, filter: PeerFilter): boolean {
  if (filter === 'free') return isFreeOffer(peer)
  if (filter === 'tools') return peer.toolUse
  return peer.tee
}

/**
 * Sellers passing every chosen filter. "Routing order" lists the ones
 * automatic routing would use in its order, then the ones it skips (by trust).
 */
export function pickPeers(
  peers: readonly ChatModelPeer[],
  filters: ReadonlySet<PeerFilter>,
  sort: PeerSort,
  verdicts: ReadonlyMap<string, PeerVerdict>,
): ChatModelPeer[] {
  const kept = peers.filter((peer) => [...filters].every((filter) => peerMatches(peer, filter)))
  const byTrust = (a: ChatModelPeer, b: ChatModelPeer) => (b.reputation ?? -1) - (a.reputation ?? -1)
  return kept.sort((a, b) => {
    if (sort === 'price') return totalPrice(a) - totalPrice(b) || byTrust(a, b)
    if (sort === 'trust') return byTrust(a, b)
    const va = verdicts.get(a.peerId)
    const vb = verdicts.get(b.peerId)
    const rank = (verdict: PeerVerdict | undefined) => (verdict?.eligible && verdict.rank !== null ? verdict.rank : Number.POSITIVE_INFINITY)
    return rank(va) - rank(vb) || byTrust(a, b)
  })
}
