import { policyAllowsModel } from '../../routing-policy/policy.js'
import { buyerJson, optionalBuyerJson, type BuyerClient } from '../console-api/handlers/network-buyer.js'
import { enrichCandidates, mapPeers, type PeerStat } from '../console-api/handlers/network-mapping.js'
import type { Peer, RoutePreview } from '../console-api/types.js'
import { resolvePolicy, type PolicyTarget } from '../policy-resolver.js'
import type { GatewayStore } from '../store.js'

const DAY_MS = 24 * 60 * 60 * 1000
const PINNED_MODEL_RE = /^(?:0x)?[0-9a-f]{40}@(.+)$/i

export type PreviewTarget = Pick<PolicyTarget, 'keyId' | 'workspaceId' | 'memberId' | 'presetSlug'>

/** Sellers the buyer knows, with health, verification and this gateway's own 24 h stats. */
export async function listNetworkPeers(store: GatewayStore, buyer: BuyerClient, now: number): Promise<Peer[]> {
  const [peers, health, verification] = await Promise.all([
    buyerJson(buyer, '/_antseed/peers'),
    optionalBuyerJson(buyer, '/_antseed/peer-health'),
    // Needs the buyer's own verification token today; when refused, `verified` falls back.
    optionalBuyerJson(buyer, '/_antseed/verification'),
  ])
  const stats = store.peerStats(now - DAY_MS) as PeerStat[]
  return mapPeers({ peers, health, verification, stats, now })
}

/**
 * Which sellers a request for `model` would route to under the effective
 * policy of `target` (gateway default → workspace → member → key → preset),
 * ranked by the buyer with the same code as real routing, ineligible ones
 * with reasons. A pinned `peer@model` is checked by its model id.
 */
export async function previewRoute(
  store: GatewayStore,
  buyer: BuyerClient,
  requested: string,
  target: PreviewTarget,
  resolve: typeof resolvePolicy = resolvePolicy,
): Promise<RoutePreview> {
  const model = PINNED_MODEL_RE.exec(requested)?.[1] ?? requested
  const { policy, sources } = resolve(store, target)
  const modelAllowed = policyAllowsModel(policy, model)
  if (!modelAllowed) return { model, policy, sources, modelAllowed, candidates: [] }
  const [preview, peers] = await Promise.all([
    buyerJson(buyer, `/_antseed/route-preview?model=${encodeURIComponent(model)}`, { policy }),
    optionalBuyerJson(buyer, '/_antseed/peers'),
  ])
  return { model, policy, sources, modelAllowed, candidates: enrichCandidates(preview['candidates'], peers) }
}
