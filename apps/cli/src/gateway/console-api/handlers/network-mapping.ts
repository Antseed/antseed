/** Pure mapping from the buyer's peer, health and verification views to the console's `Peer`. */
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status'
import type { Peer, RoutePreview } from '../types.js'

type Row = Record<string, unknown>

function rows(value: unknown): Row[] {
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

function peerKey(peerId: string): string {
  return peerId.trim().toLowerCase().replace(/^0x/, '')
}

export interface PeerStat {
  peerId: string
  requests: number
  latencyMsP50: number | null
}

/** One entry per advertised service, priced from the service's own entry or the provider default. */
export function peerServices(row: Row): Peer['services'] {
  const pricing = asRecord(row['providerPricing'])
  const categories = asRecord(row['providerServiceCategories'])
  const protocols = asRecord(row['providerServiceApiProtocols'])
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
      services.push({
        provider,
        service,
        inputUsdPerMillion: num(price['inputUsdPerMillion']),
        outputUsdPerMillion: num(price['outputUsdPerMillion']),
        cachedInputUsdPerMillion: num(price['cachedInputUsdPerMillion']),
        categories: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
        ...(Array.isArray(apis) ? { apiProtocols: apis.filter((api): api is string => typeof api === 'string') } : {}),
      })
    }
  }
  return services
}

/** Peer ids with a current, passing TEE attestation in a `/_antseed/verification` snapshot. */
export function teeVerifiedPeers(snapshot: unknown, now: number): Set<string> {
  const verified = new Set<string>()
  for (const evidence of rows(asRecord(snapshot)['evidence'])) {
    if (evidence['verifierId'] !== TEE_VERIFIER_ID || evidence['sellerNodeVerified'] !== true) continue
    if (evidence['checking'] === true || evidence['unavailable'] === true) continue
    const expiresAt = num(evidence['expiresAt'])
    if (expiresAt !== null && expiresAt <= now) continue
    const peerId = str(evidence['peerId'])
    if (peerId) verified.add(peerKey(peerId))
  }
  return verified
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
  const teeVerified = input.verification ? teeVerifiedPeers(input.verification, input.now) : null
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
    const coolingDown = healthRow?.['coolingDown'] === true
    return [{
      peerId,
      displayName: str(row['displayName']),
      services: peerServices(row),
      trustScore: num(trust['score']) ?? num(row['onChainReputationScore']),
      // The reputation the buyer's `minPeerReputation` compares against: its own trust score,
      // else the seller-reported one; null when the buyer knows neither.
      reputationScore: num(row['onChainReputationScore']) ?? num(trust['score']) ?? num(row['reputationScore']),
      verified,
      tee,
      stakeAnts: stake === null ? null : String(stake),
      usageShareBps: num(row['onChainUsageShareBps']),
      washFlagged: row['onChainWashFlagged'] === true || trust['washFlagged'] === true,
      lastSeen: num(row['lastSeen']),
      health: {
        failureStreak: num(healthRow?.['failureStreak']) ?? 0,
        coolingDownUntil: coolingDown ? num(healthRow?.['cooldownUntil']) : null,
      },
      latencyMsP50: stat?.latencyMsP50 ?? null,
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
    }]
  })
}
