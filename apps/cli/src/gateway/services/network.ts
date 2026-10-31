import { loadConfig } from '../../config/loader.js'
import { isRoutingPolicy, policyAllowsModel, type RoutingPolicy } from '../../routing-policy/policy.js'
import { buyerJson, optionalBuyerJson, type BuyerClient } from '../console-api/handlers/network-buyer.js'
import { enrichCandidates, mapNetworkModels, mapNetworkRouters, mapPeers, type PeerStat } from '../console-api/handlers/network-mapping.js'
import type { BuyerLimits, NetworkModel, NetworkRouter, Peer, RoutePreview } from '../console-api/types.js'
import { resolvePolicy, type PolicyTarget } from '../policy-resolver.js'
import { readPeerBoosts, type PeerBoostSource } from './peer-boosts.js'
import type { GatewayStore } from '../store.js'

const DAY_MS = 24 * 60 * 60 * 1000
const PINNED_MODEL_RE = /^(?:0x)?[0-9a-f]{40}@(.+)$/i
/** Model name the buyer-limits read previews; no seller serves it, so it is cheap. */
const PROBE_MODEL = '__probe__'
/** How long before the gateway asks the buyer to attest the same TEE seller again. */
const TEE_CHECK_RETRY_MS = 10 * 60 * 1000
const teeCheckAttempts = new Map<string, number>()

export type PreviewTarget = Pick<PolicyTarget, 'keyId' | 'workspaceId' | 'memberId' | 'presetSlug'>

/** Sellers the buyer knows, with health, verification, this gateway's own 24 h stats and (when given) boosts. */
export async function listNetworkPeers(store: GatewayStore, buyer: BuyerClient, now: number, boostSource?: PeerBoostSource): Promise<Peer[]> {
  const [peers, health, verification, boosts] = await Promise.all([
    buyerJson(buyer, '/_antseed/peers'),
    optionalBuyerJson(buyer, '/_antseed/peer-health'),
    // Needs the buyer's own verification token today; when refused, `verified` falls back.
    optionalBuyerJson(buyer, '/_antseed/verification'),
    readPeerBoosts(boostSource),
  ])
  const stats = store.peerStats(now - DAY_MS) as PeerStat[]
  const mapped = mapPeers({ peers, health, verification, stats, now, boosts })
  if (verification?.['verificationEnabled'] === true) checkUnattestedTeePeer(buyer, mapped, now)
  return mapped
}

/**
 * Asks the buyer, in the background, to attest one TEE-capable seller it has no current
 * result for, so a later list can tell full TEE from seller-only TEE. One per call: the buyer
 * accepts a check a second.
 */
function checkUnattestedTeePeer(buyer: BuyerClient, peers: readonly Peer[], now: number): void {
  const next = peers.find((peer) => peer.tee && peer.teeScope === null
    && now - (teeCheckAttempts.get(peer.peerId) ?? -Infinity) >= TEE_CHECK_RETRY_MS)
  if (!next) return
  teeCheckAttempts.set(next.peerId, now)
  void buyer('/_antseed/verification/check', { method: 'POST', body: { peerId: next.peerId } }).catch(() => {})
}

/**
 * Every model on the network, as the buyer's own `GET /v1/models` lists it
 * without a routing policy (like `listNetworkPeers`), with each offer's
 * verification, trust and latency from the peer list. The peer list is
 * enrichment only: when it fails the models still answer.
 */
export async function listNetworkModels(store: GatewayStore, buyer: BuyerClient, now: number): Promise<NetworkModel[]> {
  const [models, peers] = await Promise.all([
    buyerJson(buyer, '/v1/models'),
    listNetworkPeers(store, buyer, now).catch((): Peer[] => []),
  ])
  return mapNetworkModels(models, peers)
}

/**
 * Every routing service on the network, as the buyer's `GET /v1/models?type=router`
 * lists it without a routing policy, one per seller offering it.
 */
export async function listNetworkRouters(store: GatewayStore, buyer: BuyerClient, now: number): Promise<NetworkRouter[]> {
  const [routers, peers] = await Promise.all([
    buyerJson(buyer, '/v1/models?type=router'),
    listNetworkPeers(store, buyer, now).catch((): Peer[] => []),
  ])
  return mapNetworkRouters(routers, peers)
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
  /** Config file the buyer's max pricing is read from; null leaves it out. */
  configPath: string | null = null,
): Promise<RoutePreview> {
  const model = PINNED_MODEL_RE.exec(requested)?.[1] ?? requested
  const { policy, sources } = resolve(store, target)
  const modelAllowed = policyAllowsModel(policy, model)
  if (!modelAllowed) {
    return { model, policy, sources: await withBuyerSource(sources, configPath, null), modelAllowed, candidates: [] }
  }
  const [preview, peers] = await Promise.all([
    buyerJson(buyer, `/_antseed/route-preview?model=${encodeURIComponent(model)}`, { policy }),
    optionalBuyerJson(buyer, '/_antseed/peers'),
  ])
  return {
    model,
    policy,
    sources: await withBuyerSource(sources, configPath, preview['buyer']),
    modelAllowed,
    candidates: enrichCandidates(preview['candidates'], peers),
  }
}

/**
 * The buyer's config level, which every gateway policy narrows: max pricing
 * defaults (from the config file), min reputation, a required verifier and
 * routing preferences (as the running buyer reports them, else from the
 * config).
 */
export async function readBuyerLimits(configPath: string | null, live: unknown): Promise<BuyerLimits> {
  const reported = isRoutingPolicy(live) ? live : null
  let fromConfig: BuyerLimits | null = null
  if (configPath) {
    try {
      const config = await loadConfig(configPath)
      const pricing = config.buyer.maxPricing.defaults
      // `buyer.verifier` as `GET /settings` reads it; start flags only the running buyer knows.
      const verifier = config.buyer.verifier
      fromConfig = {
        minPeerReputation: config.buyer.minPeerReputation,
        requireVerifier: verifier?.enabled !== false && verifier?.require === true,
        maxPricing: {
          inputUsdPerMillion: pricing.inputUsdPerMillion,
          outputUsdPerMillion: pricing.outputUsdPerMillion,
          cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion ?? null,
        },
        routingPreferences: {
          minTrustScore: config.buyer.routingPreferences.minTrustScore,
          allowedPeerIds: [...config.buyer.routingPreferences.allowedPeerIds],
          blockedPeerIds: [...config.buyer.routingPreferences.blockedPeerIds],
          preferFreePeers: config.buyer.routingPreferences.preferFreePeers,
        },
      }
    } catch {
      // An unreadable config leaves only what the buyer reports.
    }
  }
  return {
    minPeerReputation: reported ? reported.minReputation ?? 0 : fromConfig?.minPeerReputation ?? 0,
    requireVerifier: reported ? reported.requireVerified === true : fromConfig?.requireVerifier ?? false,
    maxPricing: fromConfig?.maxPricing ?? null,
    routingPreferences: reported
      ? {
          minTrustScore: reported.minTrustScore ?? 0,
          allowedPeerIds: reported.allowedPeerIds ?? [],
          blockedPeerIds: reported.blockedPeerIds ?? [],
          preferFreePeers: reported.preferFreePeers === true,
        }
      : fromConfig?.routingPreferences ?? null,
  }
}

/** `GET /routing/buyer-limits`: asks the running buyer, falls back to the config file. */
export async function buyerLimits(configPath: string | null, buyer: BuyerClient): Promise<BuyerLimits> {
  const preview = await optionalBuyerJson(buyer, `/_antseed/route-preview?model=${PROBE_MODEL}`, { policy: {} })
  return readBuyerLimits(configPath, preview?.['buyer'])
}

/** The buyer's config as a policy, for the preview's `buyer` source. */
export function buyerLimitsPolicy(limits: BuyerLimits): RoutingPolicy | null {
  const policy: RoutingPolicy = {}
  if (limits.minPeerReputation > 0) policy.minReputation = limits.minPeerReputation
  if (limits.requireVerifier) policy.requireVerified = true
  if (limits.maxPricing) {
    policy.maxInputUsdPerMillion = limits.maxPricing.inputUsdPerMillion
    policy.maxOutputUsdPerMillion = limits.maxPricing.outputUsdPerMillion
    if (limits.maxPricing.cachedInputUsdPerMillion !== null) policy.maxCachedInputUsdPerMillion = limits.maxPricing.cachedInputUsdPerMillion
  }
  const prefs = limits.routingPreferences
  if (prefs) {
    if (prefs.minTrustScore > 0) policy.minTrustScore = prefs.minTrustScore
    if (prefs.allowedPeerIds.length > 0) policy.allowedPeerIds = [...prefs.allowedPeerIds]
    if (prefs.blockedPeerIds.length > 0) policy.blockedPeerIds = [...prefs.blockedPeerIds]
    if (prefs.preferFreePeers) policy.preferFreePeers = true
  }
  return Object.keys(policy).length > 0 ? policy : null
}

async function withBuyerSource(sources: RoutePreview['sources'], configPath: string | null, live: unknown): Promise<RoutePreview['sources']> {
  if (!configPath && !isRoutingPolicy(live)) return sources
  const policy = buyerLimitsPolicy(await readBuyerLimits(configPath, live))
  return sources.map((source) => (source.level === 'buyer' ? { ...source, policy } : source))
}
