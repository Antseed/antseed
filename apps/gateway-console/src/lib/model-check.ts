/**
 * On-chain model checks: auditors give each seller's offer of a model a
 * verdict, SAME (the genuine model) or DIFF (very likely a different one).
 * Routing keeps 10% of a DIFF offer's reputation, as the buyer does.
 */
import type { ModelCheckView, Peer } from '../api/types'

/** The share of its reputation an offer with a live DIFF verdict keeps in routing. */
export const DIFF_ROUTING_SHARE = 0.1

export const DIFF_ROUTING_NOTE = `${Math.round(DIFF_ROUTING_SHARE * 100)}% in routing`

export function modelCheckLabel(check: ModelCheckView): string {
  return check.verdict === 'diff' ? 'Model check: DIFF' : 'Verified model'
}

export function modelCheckTitle(check: ModelCheckView): string {
  return check.verdict === 'diff'
    ? `Auditors found this seller very likely serves a different model here, so routing counts only ${Math.round(DIFF_ROUTING_SHARE * 100)}% of its reputation for it.`
    : 'Auditors checked this seller and found it serves this model.'
}

/** The trust routing judges an offer by: the seller's score, cut to 10% by a live DIFF verdict. */
export function offerTrust(trustScore: number | null, check: ModelCheckView | undefined): number | null {
  if (trustScore === null) return null
  return check?.verdict === 'diff' ? trustScore * DIFF_ROUTING_SHARE : trustScore
}

/** "Trust 72", or "Trust 7 · cut from 72" when the offer has a live DIFF verdict. */
export function offerTrustLabel(trustScore: number | null, check: ModelCheckView | undefined): string {
  if (trustScore === null) return 'Trust —'
  const trust = offerTrust(trustScore, check)!
  return check?.verdict === 'diff' ? `Trust ${Math.round(trust)} · cut from ${Math.round(trustScore)}` : `Trust ${Math.round(trust)}`
}

/** For a seller's trust figure: which of its models routing cuts to 10%; null when none. */
export function diffRoutingNote(peer: Pick<Peer, 'diffServices'>): string | null {
  const services = peer.diffServices ?? []
  if (services.length === 0) return null
  return `Counts ${Math.round(DIFF_ROUTING_SHARE * 100)}% in routing for ${services.length === 1 ? services[0] : `${services.length} models`}`
}

/** Whether the seller has a live DIFF verdict on the model a route is for. */
export function hasDiffVerdict(peer: Pick<Peer, 'diffServices'> | undefined, model: string): boolean {
  return peer?.diffServices?.includes(model.trim().toLowerCase()) ?? false
}
