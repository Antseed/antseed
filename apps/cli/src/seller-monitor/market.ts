import { TRUST_FREE_MODELS_BONUS, TRUST_WEIGHTS } from '@antseed/node'
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status'
import { peerServices } from '../gateway/console-api/handlers/network-mapping.js'
import type { SellerMarket, SellerMarketOffer, SellerMarketService, SellerNetworkMeta, SellerReputation, SellerServicePricing, SellerTrust } from '../gateway/console-api/types.js'
import type { PeerRow } from './network.js'

const MAX_OFFERS = 25
const MAX_NOT_OFFERED = 10

export const peerKey = (peerId: string) => peerId.trim().toLowerCase().replace(/^0x/, '')

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** (3 × input + output) / 4, a typical chat mix; null without both prices. */
export function blended(input: number | null, output: number | null): number | null {
  return input === null || output === null ? null : (3 * input + output) / 4
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const present = (values: Array<number | null>) => values.filter((value): value is number => value !== null)

function trustOf(row: PeerRow): number | null {
  return num(record(row['trust'])['score']) ?? num(row['onChainReputationScore'])
}

function loadOf(row: PeerRow): number | null {
  const current = num(row['currentLoad'])
  const max = num(row['maxConcurrency'])
  return current !== null && max !== null && max > 0 ? Math.min(1, current / max) : null
}

/** Model ids compare case-insensitively; providers do not matter to a buyer choosing a model. */
const modelKey = (service: string) => service.trim().toLowerCase()

/**
 * This seller's services against every other seller offering the same model:
 * counts, cheapest and median prices, rank by blended price and the offers
 * themselves. `mine` are the seller's configured prices (they win over what the
 * network last saw, which lags a restart); without them the seller's announced
 * services are used.
 */
/** The fields of this seller's own services the market compares. */
export type MarketServicePrices = Pick<SellerServicePricing, 'provider' | 'service' | 'inputUsdPerMillion' | 'outputUsdPerMillion' | 'cachedInputUsdPerMillion'>

export function marketView(rows: readonly PeerRow[], myPeerId: string | null, mine: readonly MarketServicePrices[] | null, network: SellerNetworkMeta): SellerMarket {
  const me = myPeerId ? peerKey(myPeerId) : null
  const myRow = me ? rows.find((row) => peerKey(String(row['peerId'] ?? '')) === me) : undefined
  const offersByModel = new Map<string, SellerMarketOffer[]>()
  const modelNames = new Map<string, string>()
  for (const row of rows) {
    const peerId = String(row['peerId'] ?? '')
    if (!peerId || peerKey(peerId) === me) continue
    const tee = parseVerifierCapabilities(row['capabilities']).supported.includes(TEE_VERIFIER_ID)
    for (const service of peerServices(row)) {
      const key = modelKey(service.service)
      if (!modelNames.has(key)) modelNames.set(key, service.service)
      const list = offersByModel.get(key) ?? []
      // One offer per seller and model (a seller can list a model under two providers).
      if (list.some((offer) => offer.peerId === peerId)) continue
      list.push({
        peerId, name: typeof row['displayName'] === 'string' ? row['displayName'] : null, mine: false,
        inputUsdPerMillion: service.inputUsdPerMillion, outputUsdPerMillion: service.outputUsdPerMillion, cachedInputUsdPerMillion: service.cachedInputUsdPerMillion,
        blendedUsdPerMillion: blended(service.inputUsdPerMillion, service.outputUsdPerMillion), trustScore: trustOf(row), tee, load: loadOf(row),
      })
      offersByModel.set(key, list)
    }
  }

  const myServices: readonly MarketServicePrices[] = mine ?? (myRow ? peerServices(myRow) : [])
  const myModels = new Set(myServices.map((service) => modelKey(service.service)))
  const myTee = myRow ? parseVerifierCapabilities(myRow['capabilities']).supported.includes(TEE_VERIFIER_ID) : false
  const services: SellerMarketService[] = myServices.map((service) => {
    const others = offersByModel.get(modelKey(service.service)) ?? []
    const myBlended = blended(service.inputUsdPerMillion, service.outputUsdPerMillion)
    const myOffer: SellerMarketOffer = {
      peerId: myPeerId ?? '', name: myRow && typeof myRow['displayName'] === 'string' ? myRow['displayName'] : null, mine: true,
      inputUsdPerMillion: service.inputUsdPerMillion, outputUsdPerMillion: service.outputUsdPerMillion, cachedInputUsdPerMillion: service.cachedInputUsdPerMillion,
      blendedUsdPerMillion: myBlended, trustScore: myRow ? trustOf(myRow) : null, tee: myTee, load: myRow ? loadOf(myRow) : null,
    }
    const all = [...others, myOffer].sort((a, b) => (a.blendedUsdPerMillion ?? Infinity) - (b.blendedUsdPerMillion ?? Infinity) || Number(b.mine) - Number(a.mine))
    const otherBlended = present(others.map((offer) => offer.blendedUsdPerMillion))
    const medianBlended = median(otherBlended)
    const inputs = present(others.map((offer) => offer.inputUsdPerMillion))
    const outputs = present(others.map((offer) => offer.outputUsdPerMillion))
    const shown = all.slice(0, MAX_OFFERS)
    if (!shown.includes(myOffer)) shown.push(myOffer)
    return {
      provider: service.provider,
      service: service.service,
      mine: { inputUsdPerMillion: service.inputUsdPerMillion, outputUsdPerMillion: service.outputUsdPerMillion, cachedInputUsdPerMillion: service.cachedInputUsdPerMillion, blendedUsdPerMillion: myBlended },
      competitors: others.length,
      // Only you among sellers actually seen: with no network loaded nothing is known about others.
      unique: others.length === 0 && rows.length > 0,
      cheapest: others.length > 0 ? { inputUsdPerMillion: inputs.length ? Math.min(...inputs) : null, outputUsdPerMillion: outputs.length ? Math.min(...outputs) : null } : null,
      median: others.length > 0 ? { inputUsdPerMillion: median(inputs), outputUsdPerMillion: median(outputs) } : null,
      rank: myBlended === null || rows.length === 0 ? null : all.indexOf(myOffer) + 1,
      of: all.length,
      deltaPct: myBlended !== null && medianBlended !== null && medianBlended > 0 ? Math.round(((myBlended - medianBlended) / medianBlended) * 1000) / 10 : null,
      offers: shown,
    }
  })

  const notOffered = [...offersByModel.entries()]
    .filter(([key]) => !myModels.has(key))
    .map(([key, offers]) => ({ service: modelNames.get(key) ?? key, sellers: offers.length, cheapestOutputUsdPerMillion: present(offers.map((offer) => offer.outputUsdPerMillion)).reduce<number | null>((min, value) => (min === null || value < min ? value : min), null) }))
    .sort((a, b) => b.sellers - a.sellers || a.service.localeCompare(b.service))
    .slice(0, MAX_NOT_OFFERED)

  return { network, found: Boolean(myRow), services, notOffered }
}

/** The buyer-computed trust breakdown of a peer row, with each part's maximum. */
export function trustOfRow(row: PeerRow | undefined): SellerTrust | null {
  if (!row) return null
  const trust = record(row['trust'])
  const score = num(trust['score'])
  if (score === null) {
    const fallback = num(row['onChainReputationScore'])
    return fallback === null ? null : { score: fallback, history: null, usage: null, power: null, identity: null, freeModels: null, washFlagged: typeof row['onChainWashFlagged'] === 'boolean' ? row['onChainWashFlagged'] as boolean : null }
  }
  const part = <T extends object>(value: unknown, max: number, extra: (entry: Record<string, unknown>) => T) => {
    const entry = record(value)
    const partScore = num(entry['score'])
    return partScore === null ? null : { score: partScore, max, ...extra(entry) }
  }
  return {
    score,
    history: part(trust['history'], TRUST_WEIGHTS.history, (entry) => ({ channelCount: num(entry['channelCount']) ?? 0, volumeUsdc: (num(entry['totalVolumeUsdcMicros']) ?? 0) / 1_000_000 })),
    usage: part(trust['usage'], TRUST_WEIGHTS.usage, (entry) => ({ shareBps: num(entry['shareBps']) ?? 0, epoch: num(entry['epoch']) ?? 0 })),
    power: part(trust['power'], TRUST_WEIGHTS.power, (entry) => ({ shareBps: num(entry['shareBps']) ?? 0, epoch: num(entry['epoch']) ?? 0 })),
    identity: part(trust['identity'], TRUST_WEIGHTS.identity, (entry) => ({ kind: entry['kind'] === 'domain' ? 'domain' as const : 'github' as const, claim: String(entry['claim'] ?? '') })),
    freeModels: part(trust['freeModels'], TRUST_FREE_MODELS_BONUS, (entry) => ({ service: String(entry['service'] ?? '') })),
    washFlagged: typeof trust['washFlagged'] === 'boolean' ? trust['washFlagged'] as boolean : null,
  }
}

/** A plain next step for each part with room to grow, biggest gain first. */
export function trustSteps(trust: SellerTrust | null): SellerReputation['steps'] {
  if (!trust) return [{ part: 'history', text: 'Buyers have no trust score for this seller yet. It appears once the seller is discovered and its on-chain history is read; serving paid requests builds it.' }]
  if (trust.washFlagged) return [{ part: 'wash', text: 'The wash-trading registry flags this seller, so its trust score is 0 whatever else it has. Only genuine, independent buyers count.' }]
  const steps: Array<SellerReputation['steps'][number] & { gain: number }> = []
  const room = (part: { score: number; max: number } | null, max: number) => max - (part?.score ?? 0)
  if (room(trust.history, TRUST_WEIGHTS.history) > 1) steps.push({ part: 'history', gain: room(trust.history, TRUST_WEIGHTS.history), text: `Settle more paid sessions: history counts settled channels (full at 100) and settled volume (full at $100). Now ${trust.history?.channelCount ?? 0} channels, $${(trust.history?.volumeUsdc ?? 0).toFixed(2)}.` })
  if (!trust.identity) steps.push({ part: 'identity', gain: TRUST_WEIGHTS.identity, text: 'Verify a domain or a GitHub account under Promote. Up to 20 points, more for an older domain or a GitHub account with real history.' })
  else if (room(trust.identity, TRUST_WEIGHTS.identity) > 1) steps.push({ part: 'identity', gain: room(trust.identity, TRUST_WEIGHTS.identity), text: `Your ${trust.identity.kind === 'domain' ? 'domain' : 'GitHub'} claim (${trust.identity.claim}) earns ${trust.identity.score.toFixed(1)} of 20; an older domain or a GitHub account with more public history scores higher.` })
  if (room(trust.usage, TRUST_WEIGHTS.usage) > 1) steps.push({ part: 'usage', gain: room(trust.usage, TRUST_WEIGHTS.usage), text: 'Grow recognized usage: your pool\'s share of last week\'s usage points. Points need a seller pool and come from real paid traffic.' })
  if (room(trust.power, TRUST_WEIGHTS.power) > 1) steps.push({ part: 'power', gain: room(trust.power, TRUST_WEIGHTS.power), text: 'Attract stake to your pool (or stake ANTS into it yourself with antseed ants stake): power is the pool\'s share of all staking power.' })
  if (!trust.freeModels) steps.push({ part: 'freeModels', gain: TRUST_FREE_MODELS_BONUS, text: 'Offer one model for free (input and output at $0) for a 5-point bonus.' })
  return steps.sort((a, b) => b.gain - a.gain).map(({ part, text }) => ({ part, text }))
}

/** Position by trust score among the scored sellers in the snapshot. */
export function trustRank(rows: readonly PeerRow[], myPeerId: string | null): SellerReputation['rank'] {
  if (!myPeerId) return null
  const me = peerKey(myPeerId)
  const scored = rows.map((row) => ({ key: peerKey(String(row['peerId'] ?? '')), score: trustOf(row) })).filter((entry): entry is { key: string; score: number } => entry.score !== null)
  const mine = scored.find((entry) => entry.key === me)
  if (!mine) return null
  return { position: scored.filter((entry) => entry.score > mine.score).length + 1, of: scored.length }
}
