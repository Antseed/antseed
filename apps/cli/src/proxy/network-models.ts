// ── Network model catalog ──
// Aggregates the buyer's discovered-peer cache into an OpenAI-style
// /v1/models payload that covers the whole network instead of a single
// pinned seller. Each model id appears once, with the peers that serve it
// (and their pricing) listed under `peers`. Each peer retains its actual
// advertised `serviceId`, which callers use to pin `<peerId>@<serviceId>`.

import {
  buildNetworkServiceOffers,
  compareEffectiveModelReputation,
  effectiveModelReputationScore,
  modelRouteTotalPrice,
  normalizedModelReputationScore,
  rankModelRoutes,
  selectLowestPricedCanonicalOffers,
  type CatalogServiceCapabilities,
  type CatalogServiceProtocol,
  type NetworkServiceOffer,
  type ModelRoutingPreferences,
  type PeerInfo,
} from '@antseed/node'
import { canonicalModelKey, preferredModelDisplayName } from '@antseed/node/model-identity'

export { effectiveModelReputationScore } from '@antseed/node'

export type NetworkModelType = 'text' | 'image' | 'decision' | 'video'

export type NetworkModelPeerOffer = {
  unitBillingModels?: NetworkServiceOffer['unitBillingModels']
  advertisedVerifierIds?: string[]
  peerId: string
  displayName?: string
  provider: string
  serviceId: string
  protocol: CatalogServiceProtocol | null
  protocols: string[]
  type: NetworkModelType
  capabilities?: CatalogServiceCapabilities
  categories?: string[]
  reputationScore: number | null
  effectiveReputationScore: number | null
  onChainReputationScore: number | null
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
  cachedInputUsdPerMillion?: number
  minImageUsdPerImage?: number
  maxImageUsdPerImage?: number
}

export type NetworkModelCapabilityCoverage = {
  total_offers: number
  context_length: number
  max_output_tokens: number
  input_modalities: number
  output_modalities: number
  reasoning: number
  tool_use: number
  structured_output: number
  supported_parameters: number
}

export type NetworkModelEntry = {
  id: string
  name: string
  aliases: string[]
  object: 'model'
  created: number
  owned_by: 'antseed'
  type: NetworkModelType
  supported_protocols: string[]
  context_length?: number
  max_output_tokens?: number
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  capabilities?: {
    reasoning?: boolean
    tool_use?: boolean
    structured_output?: boolean
  }
  supported_parameters?: string[]
  capability_coverage: NetworkModelCapabilityCoverage
  peers: NetworkModelPeerOffer[]
}

export type ModelTypeFilter = 'all' | NetworkModelType | 'invalid'

export type NetworkModelBuildOptions = {
  routingPreferences?: ModelRoutingPreferences | null
  peerHealth?: ReadonlyMap<string, {
    cooldownUntil?: number | null
    failureStreak?: number | null
  }>
}

function normalizedModelAlias(serviceId: string): string {
  let value = serviceId.trim().toLowerCase()
  const slash = value.lastIndexOf('/')
  if (slash >= 0) value = value.slice(slash + 1)
  return value.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Buyer trust score as set by the node (0-100), or `null` when unscored. */
function onChainReputationScore(peer: PeerInfo | undefined): number | null {
  const score = peer?.onChainReputationScore
  return typeof score === 'number' && Number.isFinite(score) ? score : null
}

function countReported<T>(values: Array<T | undefined>): number {
  return values.filter((value) => value !== undefined).length
}

function guaranteedMinimum(values: Array<number | undefined>): number | undefined {
  return values.every((value) => value !== undefined) ? Math.min(...values as number[]) : undefined
}

function guaranteedBoolean(values: Array<boolean | undefined>): boolean | undefined {
  return values.every((value) => value !== undefined) ? values.every(Boolean) : undefined
}

function guaranteedIntersection(values: Array<string[] | undefined>): string[] | undefined {
  if (!values.every((value) => value !== undefined)) return undefined
  const [first = [], ...rest] = values as string[][]
  return [...new Set(first)].filter((value) => rest.every((items) => items.includes(value))).sort((a, b) => a.localeCompare(b))
}

function aggregateModelCapabilities(entry: NetworkModelEntry): void {
  const capabilities = entry.peers.map((peer) => peer.capabilities)
  const contextWindows = capabilities.map((value) => value?.contextWindow)
  const maxOutputTokens = capabilities.map((value) => value?.maxOutputTokens)
  const inputModalities = capabilities.map((value) => value?.inputs)
  const outputModalities = capabilities.map((value) => value?.outputs)
  const reasoning = capabilities.map((value) => value?.reasoning)
  const toolUse = capabilities.map((value) => value?.toolUse)
  const structuredOutput = capabilities.map((value) => value?.structuredOutput)
  const supportedParameters = capabilities.map((value) => value?.supportedParameters)

  entry.supported_protocols = [...new Set(entry.peers.flatMap((peer) => [peer.protocol, ...peer.protocols]))]
    .filter((protocol): protocol is string => Boolean(protocol))
    .sort((a, b) => a.localeCompare(b))
  entry.capability_coverage = {
    total_offers: entry.peers.length,
    context_length: countReported(contextWindows),
    max_output_tokens: countReported(maxOutputTokens),
    input_modalities: countReported(inputModalities),
    output_modalities: countReported(outputModalities),
    reasoning: countReported(reasoning),
    tool_use: countReported(toolUse),
    structured_output: countReported(structuredOutput),
    supported_parameters: countReported(supportedParameters),
  }

  const contextLength = guaranteedMinimum(contextWindows)
  const maxOutput = guaranteedMinimum(maxOutputTokens)
  const inputs = guaranteedIntersection(inputModalities)
  const outputs = guaranteedIntersection(outputModalities)
  const guaranteedReasoning = guaranteedBoolean(reasoning)
  const guaranteedToolUse = guaranteedBoolean(toolUse)
  const guaranteedStructuredOutput = guaranteedBoolean(structuredOutput)
  const parameters = guaranteedIntersection(supportedParameters)

  if (contextLength !== undefined) entry.context_length = contextLength
  if (maxOutput !== undefined) entry.max_output_tokens = maxOutput
  if (inputs !== undefined || outputs !== undefined) {
    entry.architecture = {
      ...(inputs !== undefined ? { input_modalities: inputs } : {}),
      ...(outputs !== undefined ? { output_modalities: outputs } : {}),
    }
  }
  if (guaranteedReasoning !== undefined || guaranteedToolUse !== undefined || guaranteedStructuredOutput !== undefined) {
    entry.capabilities = {
      ...(guaranteedReasoning !== undefined ? { reasoning: guaranteedReasoning } : {}),
      ...(guaranteedToolUse !== undefined ? { tool_use: guaranteedToolUse } : {}),
      ...(guaranteedStructuredOutput !== undefined ? { structured_output: guaranteedStructuredOutput } : {}),
    }
  }
  if (parameters !== undefined) entry.supported_parameters = parameters
}

/** Maps a `?type=` query value to a filter; absent/empty means "all". */
export function parseModelTypeFilter(raw: string | null): ModelTypeFilter {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '') return 'all'
  if (value === 'image' || value === 'images') return 'image'
  if (value === 'video' || value === 'videos') return 'video'
  if (value === 'text') return 'text'
  if (value === 'decision' || value === 'decisions') return 'decision'
  return 'invalid'
}

/**
 * One entry per canonical model across all discovered peers. Cosmetic naming
 * variants and conservative family aliases are grouped together, while each
 * peer offer retains its actual advertised service id for explicit routing.
 */
export function buildNetworkModels(
  peers: PeerInfo[],
  nowMs: number,
  options: NetworkModelBuildOptions = {},
): NetworkModelEntry[] {
  const created = Math.floor(nowMs / 1000)
  const byModelKey = new Map<string, NetworkModelEntry>()
  // Trust score when the node scored the peer, else the seller-reported score.
  const normalizedReputationByPeerId = new Map<string, number | null>()
  const peerById = new Map<string, PeerInfo>(peers.map((peer) => [peer.peerId, peer]))
  for (const peer of peers) {
    normalizedReputationByPeerId.set(peer.peerId, normalizedModelReputationScore(peer))
  }

  const allOffers = buildNetworkServiceOffers(peers)
  const offersByPeerModel = new Map<string, NetworkServiceOffer[]>()
  for (const offer of allOffers) {
    const key = canonicalModelKey(offer.serviceId)
    if (!key) continue
    const peerModelKey = `${offer.peerId}\u0000${key}`
    const duplicateOffers = offersByPeerModel.get(peerModelKey) ?? []
    duplicateOffers.push(offer)
    offersByPeerModel.set(peerModelKey, duplicateOffers)
  }

  const selectedOffers = new Set(selectLowestPricedCanonicalOffers(allOffers))
  for (const duplicateOffers of offersByPeerModel.values()) {
    const offer = duplicateOffers.find((candidate) => selectedOffers.has(candidate))
    if (!offer) continue
    const key = canonicalModelKey(offer.serviceId)
    if (!key) continue
    let entry = byModelKey.get(key)
    if (!entry) {
      entry = {
        id: offer.serviceId,
        name: preferredModelDisplayName(offer.serviceId),
        aliases: [],
        object: 'model',
        created,
        owned_by: 'antseed',
        type: offer.type,
        supported_protocols: [],
        capability_coverage: {
          total_offers: 0,
          context_length: 0,
          max_output_tokens: 0,
          input_modalities: 0,
          output_modalities: 0,
          reasoning: 0,
          tool_use: 0,
          structured_output: 0,
          supported_parameters: 0,
        },
        peers: [],
      }
      byModelKey.set(key, entry)
    }
    for (const duplicate of duplicateOffers) {
      entry.aliases.push(normalizedModelAlias(duplicate.serviceId), key)
    }
    // Text wins over image, image over decision, so a canonically merged
    // model stays routable for the most general client.
    if (offer.type === 'text') entry.type = 'text'
    else if (offer.type === 'image' && entry.type === 'decision') entry.type = 'image'
    const peer = peerById.get(offer.peerId)
    entry.peers.push({
      advertisedVerifierIds: offer.advertisedVerifierIds,
      peerId: offer.peerId,
      ...(offer.displayName ? { displayName: offer.displayName } : {}),
      provider: offer.provider,
      serviceId: offer.serviceId,
      protocol: offer.protocol,
      protocols: offer.protocols,
      type: offer.type,
      ...(offer.unitBillingModels ? { unitBillingModels: offer.unitBillingModels } : {}),
      ...(offer.capabilities ? { capabilities: offer.capabilities } : {}),
      ...(offer.categories ? { categories: offer.categories } : {}),
      reputationScore: normalizedReputationByPeerId.get(offer.peerId) ?? null,
      effectiveReputationScore: normalizedReputationByPeerId.get(offer.peerId) ?? null,
      onChainReputationScore: onChainReputationScore(peer),
      ...(offer.inputUsdPerMillion !== undefined ? { inputUsdPerMillion: offer.inputUsdPerMillion } : {}),
      ...(offer.outputUsdPerMillion !== undefined ? { outputUsdPerMillion: offer.outputUsdPerMillion } : {}),
      ...(offer.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion } : {}),
      ...(offer.minImageUsdPerImage !== undefined ? { minImageUsdPerImage: offer.minImageUsdPerImage } : {}),
      ...(offer.maxImageUsdPerImage !== undefined ? { maxImageUsdPerImage: offer.maxImageUsdPerImage } : {}),
    })
  }

  const entries = [...byModelKey.values()]
  for (const entry of entries) {
    entry.aliases = [...new Set(entry.aliases.filter(Boolean))].sort((a, b) => a.localeCompare(b))
    const modelHasCachedInputPricing = entry.peers.some((peer) => peer.cachedInputUsdPerMillion !== undefined)
    for (const peer of entry.peers) {
      peer.effectiveReputationScore = modelHasCachedInputPricing
        ? effectiveModelReputationScore(
            normalizedReputationByPeerId.get(peer.peerId) ?? null,
            peer.cachedInputUsdPerMillion !== undefined,
            true,
            modelRouteTotalPrice(peer) === 0,
          )
        : normalizedReputationByPeerId.get(peer.peerId) ?? null
    }
    if (options.routingPreferences) {
      const ranked = rankModelRoutes(entry.peers.map((offer) => {
        const health = options.peerHealth?.get(offer.peerId)
          ?? options.peerHealth?.get(offer.peerId.toLowerCase())
        return {
          ...offer,
          sourceOffer: offer,
          peerCooldownUntil: health?.cooldownUntil ?? null,
          peerFailureStreak: health?.failureStreak ?? 0,
        }
      }), options.routingPreferences, nowMs)
      entry.peers = ranked.map(({ sourceOffer }) => sourceOffer)
    } else {
      entry.peers.sort(compareEffectiveModelReputation)
    }
    aggregateModelCapabilities(entry)
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return entries
}
