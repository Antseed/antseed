/** Pure mapping from the buyer's peer, health and verification views to the console's `Peer`. */
import { isNativeVideoProtocol, parseServiceHealth, parseServicePerformance } from '@antseed/node'
import { collectPeerVerificationLinks } from '@antseed/node/discovery'
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { freeTierProgramForService, isPricedService, normalizeFreeTierProgram, parseFreeTierProgram } from '@antseed/node/free-tier-program'
import { modelTagsFor } from '@antseed/node/model-metadata'
import { TEE_VERIFIER_ID, teeScope, type TeeClaim, type TeeScope } from '@antseed/node/tee-status'
import type { NetworkModel, NetworkModelCapability, NetworkModelOffer, NetworkModelType, NetworkRouter, NetworkRouterOption, Peer, RoutePreview, ServiceHealthView, ServicePerformanceView } from '../types.js'
import { parseRouteSelection } from '../../../proxy/route-selection.js'

type Row = Record<string, unknown>

/** Objects of a JSON array (the buyer's peer rows). */
export function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row)) : []
}

function asRecord(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** A seller's announced self health check with every field present, as a `health` property; none when not announced. */
export function serviceHealthField(value: unknown): { health?: ServiceHealthView } {
  const health = parseServiceHealth(value)
  if (!health) return {}
  return { health: {
    status: health.status,
    checkedAt: health.checkedAt ?? null,
    source: health.source ?? null,
    failingSince: health.failingSince ?? null,
    consecutiveFailures: health.consecutiveFailures ?? null,
    reason: health.reason ?? null,
    httpStatus: health.httpStatus ?? null,
  } }
}

/** A seller's announced performance with every field present, as a `performance` property; none when not announced. */
export function servicePerformanceField(value: unknown): { performance?: ServicePerformanceView } {
  const performance = parseServicePerformance(value)
  if (!performance) return {}
  return { performance: {
    requests: performance.requests,
    successRate: performance.successRate,
    firstTokenMsP50: performance.firstTokenMsP50 ?? null,
    firstTokenMsP90: performance.firstTokenMsP90 ?? null,
    tokensPerSecondP50: performance.tokensPerSecondP50 ?? null,
  } }
}

function peerKey(peerId: string): string {
  return peerId.trim().toLowerCase().replace(/^0x/, '')
}

export interface PeerStat {
  peerId: string
  requests: number
  latencyMsP50: number | null
  firstTokenMsP50?: number | null
  tokensPerSecondP50?: number | null
}

/** One entry per advertised service, priced from the service's own entry or the provider default. */
export function peerServices(row: Row): Peer['services'] {
  const pricing = asRecord(row['providerPricing'])
  const categories = asRecord(row['providerServiceCategories'])
  const protocols = asRecord(row['providerServiceApiProtocols'])
  const unitModels = asRecord(row['providerServiceUnitBillingModels'])
  const health = asRecord(row['providerServiceHealth'])
  const performance = asRecord(row['providerServicePerformance'])
  const capabilities = strings(row['capabilities'])
  const providers = new Set<string>([
    ...(Array.isArray(row['providers']) ? row['providers'].filter((p): p is string => typeof p === 'string') : []),
    ...Object.keys(pricing),
    ...Object.keys(categories),
  ])
  const services: Peer['services'] = []
  for (const provider of providers) {
    const entry = asRecord(pricing[provider])
    const defaults = asRecord(entry['defaults'])
    const priced = asRecord(entry['services'])
    const tagged = asRecord(asRecord(categories[provider])['services'])
    const spoken = asRecord(asRecord(protocols[provider])['services'])
    for (const service of new Set([...Object.keys(priced), ...Object.keys(tagged)])) {
      const price = { ...defaults, ...asRecord(priced[service]) }
      const tags = tagged[service]
      const apis = spoken[service]
      const billing = asRecord(asRecord(unitModels[provider])['services'])[service]
      const paid = isPricedService({
        inputUsdPerMillion: num(price['inputUsdPerMillion']),
        outputUsdPerMillion: num(price['outputUsdPerMillion']),
        cachedInputUsdPerMillion: num(price['cachedInputUsdPerMillion']),
        unitBillingModels: billing && typeof billing === 'object' ? billing as Record<string, { components?: Array<{ priceUsd: number }> }> : null,
      })
      const video = Array.isArray(apis) && apis.some(isNativeVideoProtocol)
      services.push({
        provider,
        service,
        inputUsdPerMillion: num(price['inputUsdPerMillion']),
        outputUsdPerMillion: num(price['outputUsdPerMillion']),
        cachedInputUsdPerMillion: num(price['cachedInputUsdPerMillion']),
        categories: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
        ...(Array.isArray(apis) ? { apiProtocols: apis.filter((api): api is string => typeof api === 'string') } : {}),
        paid,
        // A priced service only has a free allowance of its own; the seller-wide program covers free services.
        freeTier: freeTierProgramForService(capabilities, service, paid, { video }),
        ...serviceHealthField(asRecord(asRecord(health[provider])['services'])[service]),
        ...servicePerformanceField(asRecord(asRecord(performance[provider])['services'])[service]),
      })
    }
  }
  return services
}

/**
 * Peer ids with a current, passing TEE attestation in a `/_antseed/verification` snapshot,
 * mapped to how far it reaches: the seller node only, or end to end through its provider.
 */
export function teeScopes(snapshot: unknown, now: number): Map<string, TeeScope> {
  const scopes = new Map<string, TeeScope>()
  for (const evidence of rows(asRecord(snapshot)['evidence'])) {
    if (evidence['verifierId'] !== TEE_VERIFIER_ID || evidence['sellerNodeVerified'] !== true) continue
    if (evidence['checking'] === true || evidence['unavailable'] === true) continue
    const expiresAt = num(evidence['expiresAt'])
    if (expiresAt !== null && expiresAt <= now) continue
    const peerId = str(evidence['peerId'])
    const claims = rows(evidence['claims']).filter((claim): claim is Row & TeeClaim => typeof claim['claim'] === 'string')
    if (peerId) scopes.set(peerKey(peerId), teeScope({ claims }))
  }
  return scopes
}

/** Peer ids with a current, passing TEE attestation in a `/_antseed/verification` snapshot. */
export function teeVerifiedPeers(snapshot: unknown, now: number): Set<string> {
  return new Set(teeScopes(snapshot, now).keys())
}

/**
 * Merges the buyer's `/_antseed/peers`, `/_antseed/peer-health` and (when the
 * buyer lets the gateway read it) `/_antseed/verification` with the gateway's
 * own 24 h request stats.
 */
export function mapPeers(input: {
  peers: unknown
  health: unknown
  verification: unknown | null
  stats: readonly PeerStat[]
  now: number
}): Peer[] {
  const health = new Map(rows(asRecord(input.health)['peers']).map((row) => [peerKey(String(row['peerId'] ?? '')), row]))
  const stats = new Map(input.stats.map((row) => [peerKey(row.peerId), row]))
  const teeVerified = input.verification ? teeScopes(input.verification, input.now) : null
  return rows(asRecord(input.peers)['peers']).flatMap((row): Peer[] => {
    const peerId = str(row['peerId'])
    if (!peerId) return []
    const key = peerKey(peerId)
    const trust = asRecord(row['trust'])
    const healthRow = health.get(key)
    const stat = stats.get(key)
    // TEE-capable is what a policy's `requireTee` filters on: the seller advertises the TEE verifier.
    const tee = parseVerifierCapabilities(row['capabilities']).supported.includes(TEE_VERIFIER_ID)
    // Verified: every ownership claim (domain, GitHub) checked out, or a current TEE attestation
    // when the buyer shares its verification snapshot.
    const verified = asRecord(row['verificationResults'])['verified'] === true || (teeVerified?.has(key) ?? false)
    const stake = num(row['onChainPoolStakeAnts'])
    const agentId = num(row['onChainAgentId'])
    const coolingDown = healthRow?.['coolingDown'] === true
    const diffServices = strings(row['onChainDiffServices'])
    return [{
      peerId,
      displayName: str(row['displayName']),
      services: peerServices(row),
      trustScore: num(trust['score']) ?? num(row['onChainReputationScore']),
      // The reputation the buyer's `minPeerReputation` compares against: its own trust score,
      // else the seller-reported one; null when the buyer knows neither.
      reputationScore: num(row['onChainReputationScore']) ?? num(trust['score']) ?? num(row['reputationScore']),
      verified,
      verificationLinks: collectPeerVerificationLinks(row),
      tee,
      teeScope: tee ? teeVerified?.get(key) ?? null : null,
      stakeAnts: stake === null ? null : String(stake),
      agentId: agentId !== null && agentId > 0 ? agentId : null,
      freeTier: parseFreeTierProgram(strings(row['capabilities'])),
      usageShareBps: num(row['onChainUsageShareBps']),
      washFlagged: row['onChainWashFlagged'] === true || trust['washFlagged'] === true,
      ...(diffServices.length > 0 ? { diffServices } : {}),
      lastSeen: num(row['lastSeen']),
      health: {
        failureStreak: num(healthRow?.['failureStreak']) ?? 0,
        coolingDownUntil: coolingDown ? num(healthRow?.['cooldownUntil']) : null,
      },
      latencyMsP50: stat?.latencyMsP50 ?? null,
      firstTokenMsP50: stat?.firstTokenMsP50 ?? null,
      tokensPerSecondP50: stat?.tokensPerSecondP50 ?? null,
      requests24h: stat?.requests ?? 0,
    }]
  })
}

/** Normalizes the buyer's route-preview candidates and fills names and trust from its peer list. */
export function enrichCandidates(candidates: unknown, peers: unknown): RoutePreview['candidates'] {
  const known = new Map(rows(asRecord(peers)['peers']).map((row) => [peerKey(String(row['peerId'] ?? '')), row]))
  return rows(candidates).flatMap((row): RoutePreview['candidates'] => {
    const peerId = str(row['peerId'])
    if (!peerId) return []
    const peer = known.get(peerKey(peerId))
    const trust = peer ? num(asRecord(peer['trust'])['score']) ?? num(peer['onChainReputationScore']) : null
    return [{
      peerId,
      displayName: str(row['displayName']) ?? (peer ? str(peer['displayName']) : null),
      rank: num(row['rank']),
      eligible: row['eligible'] === true,
      reasons: Array.isArray(row['reasons']) ? row['reasons'].filter((reason): reason is string => typeof reason === 'string') : [],
      inputUsdPerMillion: num(row['inputUsdPerMillion']),
      outputUsdPerMillion: num(row['outputUsdPerMillion']),
      trustScore: num(row['trustScore']) ?? trust,
      selection: parseRouteSelection(row['selection']),
      ...serviceHealthField(row['health']),
    }]
  })
}

const MODEL_TYPES: readonly NetworkModelType[] = ['text', 'image', 'decision', 'video']

function range(values: Array<number | null>): { min: number; max: number } | null {
  const known = values.filter((value): value is number => value !== null)
  return known.length ? { min: Math.min(...known), max: Math.max(...known) } : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

const ROUTER_OPTION_TYPES = new Set(['integer', 'number', 'boolean', 'string'])

function routerOptions(value: unknown): NetworkRouterOption[] {
  return rows(value).flatMap((row): NetworkRouterOption[] => {
    const key = str(row['key'])
    const type = str(row['type'])
    if (!key || !type || !ROUTER_OPTION_TYPES.has(type)) return []
    return [{ ...row, key, label: str(row['label']) ?? key, type } as NetworkRouterOption]
  })
}

/**
 * The buyer's `/v1/models?type=router` (one entry per routing service, each
 * seller offering it under `peers`) as one router per seller, with trust and
 * verification from the console's peer list.
 */
export function mapNetworkRouters(body: unknown, peers: readonly Peer[]): NetworkRouter[] {
  const known = new Map(peers.map((peer) => [peerKey(peer.peerId), peer]))
  return rows(asRecord(body)['data']).flatMap((row) => rows(row['peers']).flatMap((offer): NetworkRouter[] => {
    const peerId = str(offer['peerId'])
    const serviceId = str(offer['serviceId']) ?? str(row['id'])
    if (!peerId || !serviceId) return []
    const peer = known.get(peerKey(peerId))
    const price = num(offer['priceUsdPerRequest'])
    return [{
      id: str(offer['model']) ?? `${peerId}@${serviceId}`,
      peerId,
      serviceId,
      provider: str(offer['provider']) ?? '',
      name: str(row['name']) ?? serviceId,
      sellerName: str(offer['displayName']) ?? peer?.displayName ?? null,
      protocol: str(offer['protocol']) ?? '',
      options: routerOptions(offer['options']),
      priceUsdPerRequest: price,
      free: price === 0,
      models: Array.isArray(offer['models']) ? strings(offer['models']) : null,
      trustScore: peer?.trustScore ?? null,
      verified: peer?.verified ?? false,
      verificationLinks: peer?.verificationLinks ?? [],
    }]
  }))
}

/**
 * The buyer's `/v1/models` (one entry per model, each seller's offer under
 * `peers`) for the console, with verification, trust and this gateway's
 * latency filled from the console's own peer list.
 */
export function mapNetworkModels(body: unknown, peers: readonly Peer[]): NetworkModel[] {
  const known = new Map(peers.map((peer) => [peerKey(peer.peerId), peer]))
  return rows(asRecord(body)['data']).flatMap((row): NetworkModel[] => {
    const id = str(row['id'])
    if (!id) return []
    const offers = rows(row['peers']).flatMap((offer): NetworkModelOffer[] => {
      const peerId = str(offer['peerId'])
      if (!peerId) return []
      const peer = known.get(peerKey(peerId))
      const capabilities = asRecord(offer['capabilities'])
      const input = num(offer['inputUsdPerMillion'])
      const output = num(offer['outputUsdPerMillion'])
      const minImage = num(offer['minImageUsdPerImage'])
      const maxImage = num(offer['maxImageUsdPerImage']) ?? minImage
      const tokenPriced = input !== null || output !== null
      return [{
        peerId,
        displayName: str(offer['displayName']) ?? peer?.displayName ?? null,
        serviceId: str(offer['serviceId']) ?? id,
        provider: str(offer['provider']) ?? '',
        protocols: [...new Set([str(offer['protocol']), ...strings(offer['protocols'])].filter((value): value is string => value !== null))],
        inputUsdPerMillion: input,
        outputUsdPerMillion: output,
        cachedInputUsdPerMillion: num(offer['cachedInputUsdPerMillion']),
        usdPerImage: minImage !== null && maxImage !== null ? { min: Math.min(minImage, maxImage), max: Math.max(minImage, maxImage) } : null,
        contextLength: num(capabilities['contextWindow']),
        // Free when every advertised price is zero, and at least one is advertised.
        free: (tokenPriced || minImage !== null) && (input ?? 0) === 0 && (output ?? 0) === 0 && (maxImage ?? 0) === 0,
        agentId: peer?.agentId ?? null,
        // The program this model is served under: its own, else the seller-wide
        // one, which only covers free models. A priced model's own program is a free allowance.
        // The buyer's catalog classifies the offer (prices, unit billing, video) the way the seller does.
        freeTier: normalizeFreeTierProgram(offer['freeTier']),
        reputationScore: num(offer['effectiveReputationScore']) ?? num(offer['reputationScore']),
        trustScore: peer?.trustScore ?? num(offer['onChainReputationScore']),
        verified: peer?.verified ?? false,
        verificationLinks: peer?.verificationLinks ?? [],
        tee: strings(offer['advertisedVerifierIds']).includes(TEE_VERIFIER_ID) || (peer?.tee ?? false),
        teeScope: peer?.teeScope ?? null,
        latencyMsP50: peer?.latencyMsP50 ?? null,
        firstTokenMsP50: peer?.firstTokenMsP50 ?? null,
        tokensPerSecondP50: peer?.tokensPerSecondP50 ?? null,
        ...serviceHealthField(offer['health']),
        ...servicePerformanceField(offer['performance']),
      }]
    })
    const capabilityRows = rows(row['peers']).map((offer) => asRecord(offer['capabilities']))
    const capabilities: NetworkModelCapability[] = []
    if (capabilityRows.some((caps) => caps['toolUse'] === true)) capabilities.push('toolUse')
    if (capabilityRows.some((caps) => caps['reasoning'] === true)) capabilities.push('reasoning')
    if (capabilityRows.some((caps) => caps['structuredOutput'] === true)) capabilities.push('structuredOutput')
    if (capabilityRows.some((caps) => strings(caps['inputs']).includes('image'))) capabilities.push('vision')
    const type = MODEL_TYPES.find((value) => value === row['type']) ?? 'text'
    return [{
      id,
      name: str(row['name']) ?? id,
      aliases: strings(row['aliases']).filter((alias) => alias !== id),
      type,
      tags: modelTagsFor(id),
      contextLength: range(offers.map((offer) => offer.contextLength))?.max ?? num(row['context_length']),
      capabilities,
      sellers: new Set(offers.map((offer) => peerKey(offer.peerId))).size,
      inputUsdPerMillion: range(offers.map((offer) => offer.inputUsdPerMillion)),
      outputUsdPerMillion: range(offers.map((offer) => offer.outputUsdPerMillion)),
      // Free to everyone: a stakers-only offer is free only to its seller's stakers.
      free: offers.some((offer) => offer.free && !offer.freeTier?.base.stakersOnly),
      freeForStakers: offers.some((offer) => offer.freeTier?.base.stakersOnly === true),
      freeAllowance: offers.some((offer) => !offer.free && offer.freeTier !== null && !offer.freeTier.base.stakersOnly),
      teeSellers: offers.filter((offer) => offer.tee).length,
      fullTeeSellers: offers.filter((offer) => offer.teeScope === 'end-to-end').length,
      verifiedSellers: offers.filter((offer) => offer.verified).length,
      offers,
    }]
  })
}
