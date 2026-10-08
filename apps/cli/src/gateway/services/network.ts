import { loadConfig } from '../../config/loader.js'
import { isRoutingPolicy, policyAllowsModel, type RoutingPolicy } from '../../routing-policy/policy.js'
import { buyerJson, optionalBuyerJson, type BuyerClient } from '../console-api/handlers/network-buyer.js'
import { enrichCandidates, mapPeers, type PeerStat } from '../console-api/handlers/network-mapping.js'
import type { BuyerLimits, Peer, RoutePreview } from '../console-api/types.js'
import { resolvePolicy, type PolicyTarget } from '../policy-resolver.js'
import type { GatewayStore } from '../store.js'

const DAY_MS = 24 * 60 * 60 * 1000
const PINNED_MODEL_RE = /^(?:0x)?[0-9a-f]{40}@(.+)$/i
/** Model name the buyer-limits read previews; no seller serves it, so it is cheap. */
const PROBE_MODEL = '__probe__'

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
 * The buyer's hard limits, which apply under every gateway policy: max
 * pricing defaults (from the config file), min reputation and a required
 * verifier (as the running buyer reports them, else from the config). Its
 * routing preferences are not limits: gateway policies replace them.
 */
export async function readBuyerLimits(configPath: string | null, live: unknown): Promise<BuyerLimits> {
  const reported = isRoutingPolicy(live) ? live : null
  let fromConfig: BuyerLimits | null = null
  if (configPath) {
    try {
      const config = await loadConfig(configPath)
      const pricing = config.buyer.maxPricing.defaults
      // Same reading as `GET /settings`; `--require-verifier` is a flag only the running buyer knows.
      const buyerConfig = config.buyer as typeof config.buyer & { routingPolicy?: { requireVerified?: boolean }; requireVerifier?: boolean }
      fromConfig = {
        minPeerReputation: config.buyer.minPeerReputation,
        requireVerifier: Boolean(buyerConfig.requireVerifier ?? buyerConfig.routingPolicy?.requireVerified),
        maxPricing: {
          inputUsdPerMillion: pricing.inputUsdPerMillion,
          outputUsdPerMillion: pricing.outputUsdPerMillion,
          cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion ?? null,
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
  }
}

/** `GET /routing/buyer-limits`: asks the running buyer, falls back to the config file. */
export async function buyerLimits(configPath: string | null, buyer: BuyerClient): Promise<BuyerLimits> {
  const preview = await optionalBuyerJson(buyer, `/_antseed/route-preview?model=${PROBE_MODEL}`, { policy: {} })
  return readBuyerLimits(configPath, preview?.['buyer'])
}

/** The buyer's hard limits as a policy, for the preview's `buyer` source. */
export function buyerLimitsPolicy(limits: BuyerLimits): RoutingPolicy | null {
  const policy: RoutingPolicy = {}
  if (limits.minPeerReputation > 0) policy.minReputation = limits.minPeerReputation
  if (limits.requireVerifier) policy.requireVerified = true
  if (limits.maxPricing) {
    policy.maxInputUsdPerMillion = limits.maxPricing.inputUsdPerMillion
    policy.maxOutputUsdPerMillion = limits.maxPricing.outputUsdPerMillion
    if (limits.maxPricing.cachedInputUsdPerMillion !== null) policy.maxCachedInputUsdPerMillion = limits.maxPricing.cachedInputUsdPerMillion
  }
  return Object.keys(policy).length > 0 ? policy : null
}

async function withBuyerSource(sources: RoutePreview['sources'], configPath: string | null, live: unknown): Promise<RoutePreview['sources']> {
  if (!configPath && !isRoutingPolicy(live)) return sources
  const policy = buyerLimitsPolicy(await readBuyerLimits(configPath, live))
  return sources.map((source) => (source.level === 'buyer' ? { ...source, policy } : source))
}
