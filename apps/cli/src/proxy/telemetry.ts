import { computeCostUsdc, isExposedResponseHeader, usageForBilling, type PeerInfo, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node'
import { ROUTE_SELECTION_HEADER } from './route-selection.js'
import { pickProviderForPeer } from './routing.js'
import { extractRequestedService } from './request-utils.js'
import { FREE_TIER_SERVED_COVERED, FREE_TIER_SERVED_HEADER } from '@antseed/node/free-tier-program'

/** Whether the seller marked a response as covered by its free allowance (nothing charged). */
export function coveredByFreeAllowance(headers: Record<string, string | string[] | undefined>): boolean {
  return Object.entries(headers).some(([name, value]) =>
    name.toLowerCase() === FREE_TIER_SERVED_HEADER
    && (Array.isArray(value) ? value : [value]).some((entry) => entry?.trim().toLowerCase() === FREE_TIER_SERVED_COVERED))
}

export type TokenUsageSummary = {
  /** Total input tokens, cache hits included. */
  inputTokens: number
  /** Input tokens billed at the full rate (total minus cache hits). */
  freshInputTokens: number
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
  source: 'usage' | 'estimated'
}

type RoutingPricing = {
  provider: string
  service: string | null
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  cachedInputUsdPerMillion: number | null
}

export type ResponseTelemetry = {
  usage: TokenUsageSummary
  pricing: RoutingPricing
  estimatedCostUsd: number | null
}

function toFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function setFiniteNumberHeader(
  headers: Record<string, string>,
  name: string,
  value: unknown,
): void {
  const finite = toFiniteNumberOrNull(value)
  if (finite !== null) {
    headers[name] = String(finite)
  }
}

function setPeerIdentityHeaders(headers: Record<string, string>, selectedPeer: PeerInfo): void {
  headers['x-antseed-peer-id'] = selectedPeer.peerId
  if (selectedPeer.publicAddress) {
    headers['x-antseed-peer-address'] = selectedPeer.publicAddress
  }
  if (selectedPeer.providers.length > 0) {
    headers['x-antseed-peer-providers'] = selectedPeer.providers.join(',')
  }
}

type ResolvedPricing = {
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  cachedInputUsdPerMillion: number | null
}

function setPricingHeaders(headers: Record<string, string>, pricing: ResolvedPricing): void {
  setFiniteNumberHeader(headers, 'x-antseed-input-usd-per-million', pricing.inputUsdPerMillion)
  setFiniteNumberHeader(headers, 'x-antseed-output-usd-per-million', pricing.outputUsdPerMillion)
  setFiniteNumberHeader(headers, 'x-antseed-cached-input-usd-per-million', pricing.cachedInputUsdPerMillion)
}

/**
 * Tells a gateway whether the service also charges per unit (image, video
 * second, speech character), so zero token prices alone do not make it free:
 * `1` when a published unit price is positive, `0` when none is.
 */
function setUnitPricedHeader(headers: Record<string, string>, peer: PeerInfo, provider: string, service: string | null): void {
  if (!service) return
  const models = peer.providerServiceUnitBillingModels?.[provider]?.services?.[service]
  const priced = Object.values(models ?? {}).some((model) => (model?.components ?? []).some((component) => component.priceUsd > 0))
  headers['x-antseed-unit-priced'] = priced ? '1' : '0'
}

function resolvePeerPricing(peer: PeerInfo, provider: string, service: string | null): ResolvedPricing {
  const providerPricing = peer.providerPricing?.[provider]
  if (providerPricing) {
    const servicePricing = service ? providerPricing.services?.[service] : undefined
    if (servicePricing) {
      return {
        inputUsdPerMillion: toFiniteNumberOrNull(servicePricing.inputUsdPerMillion),
        outputUsdPerMillion: toFiniteNumberOrNull(servicePricing.outputUsdPerMillion),
        cachedInputUsdPerMillion: toFiniteNumberOrNull(servicePricing.cachedInputUsdPerMillion),
      }
    }
    return {
      inputUsdPerMillion: toFiniteNumberOrNull(providerPricing.defaults.inputUsdPerMillion),
      outputUsdPerMillion: toFiniteNumberOrNull(providerPricing.defaults.outputUsdPerMillion),
      cachedInputUsdPerMillion: toFiniteNumberOrNull(providerPricing.defaults.cachedInputUsdPerMillion),
    }
  }

  return {
    inputUsdPerMillion: toFiniteNumberOrNull(peer.defaultInputUsdPerMillion),
    outputUsdPerMillion: toFiniteNumberOrNull(peer.defaultOutputUsdPerMillion),
    cachedInputUsdPerMillion: toFiniteNumberOrNull(peer.defaultCachedInputUsdPerMillion),
  }
}

/**
 * The usage and cost of a seller's response, as the buyer signs for it: `response` is the seller's
 * own answer, before it is translated for the client, since that is what the charge is computed on.
 */
export function computeResponseTelemetry(
  request: SerializedHttpRequest,
  response: Pick<SerializedHttpResponse, 'statusCode' | 'headers' | 'body'>,
  selectedPeer: PeerInfo,
): ResponseTelemetry {
  const provider = pickProviderForPeer(selectedPeer, request)
  const service = extractRequestedService(request)
  const pricing = resolvePeerPricing(selectedPeer, provider, service)
  // The seller bills the same figure from the same bytes.
  const { usage: billed, estimated } = usageForBilling(request.body, response)
  const totalTokens = billed.inputTokens + billed.outputTokens
  const usage: TokenUsageSummary = { ...billed, totalTokens, source: estimated || totalTokens === 0 ? 'estimated' : 'usage' }

  let estimatedCostUsd: number | null = null
  if (response.statusCode >= 400 || coveredByFreeAllowance(response.headers)) {
    // Nothing is signed for an error reply, nor charged for one the seller's free allowance covered.
    estimatedCostUsd = 0
  } else if (
    pricing.inputUsdPerMillion !== null &&
    pricing.outputUsdPerMillion !== null &&
    Number.isFinite(pricing.inputUsdPerMillion) &&
    Number.isFinite(pricing.outputUsdPerMillion)
  ) {
    // Priced and rounded to base units as the buyer signs: a seller that advertises
    // no cached rate charges cache hits as fresh input.
    const prices = {
      inputUsdPerMillion: pricing.inputUsdPerMillion,
      outputUsdPerMillion: pricing.outputUsdPerMillion,
      ...(pricing.cachedInputUsdPerMillion !== null ? { cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion } : {}),
    }
    estimatedCostUsd = Number(computeCostUsdc(usage.freshInputTokens, usage.outputTokens, prices, usage.cachedInputTokens)) / 1_000_000
  }

  return {
    usage,
    pricing: {
      provider,
      service,
      inputUsdPerMillion: pricing.inputUsdPerMillion,
      outputUsdPerMillion: pricing.outputUsdPerMillion,
      cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion,
    },
    estimatedCostUsd,
  }
}

/**
 * Response headers of a request a routing service ranked: the router's peer
 * and service, and which of its recommendations (1 = its first pick) was tried
 * last: it served the request, unless the response is the last refusal. A
 * failed ranking carries the router's peer and service only.
 */
export const ROUTER_PEER_ID_HEADER = 'x-antseed-router-peer-id'
export const ROUTER_SERVICE_HEADER = 'x-antseed-router-service'
export const ROUTER_RANK_HEADER = 'x-antseed-router-rank'

/** Headers only the buyer sets: which router ranked a request, and why routing picked its seller. */
const BUYER_ROUTING_HEADERS = new Set([ROUTER_PEER_ID_HEADER, ROUTER_SERVICE_HEADER, ROUTER_RANK_HEADER, ROUTE_SELECTION_HEADER])

/**
 * The seller's headers a buyer passes on to its client: Antseed's own and the
 * generic ones clients act on, without the buyer's routing headers (only the
 * buyer says which router ranked a request and why its seller was picked, so a
 * seller can neither change nor invent that). Anything else a seller relays
 * from its upstream API, such as that account's usage or session ids, is
 * dropped here too, so sellers on older versions that still pass it on are
 * covered (`isExposedResponseHeader` is the same rule a seller applies).
 */
export function withoutRouterHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    isExposedResponseHeader(name) && !BUYER_ROUTING_HEADERS.has(name.toLowerCase())))
}

export function attachAntseedTelemetryHeaders(
  upstreamHeaders: Record<string, string>,
  selectedPeer: PeerInfo,
  telemetry: ResponseTelemetry,
  requestId: string,
  latencyMs: number,
): Record<string, string> {
  const headers: Record<string, string> = withoutRouterHeaders(upstreamHeaders)
  headers['x-antseed-request-id'] = requestId
  headers['x-antseed-latency-ms'] = String(Math.max(0, Math.floor(latencyMs)))
  setPeerIdentityHeaders(headers, selectedPeer)
  setFiniteNumberHeader(headers, 'x-antseed-peer-reputation', selectedPeer.reputationScore)
  setFiniteNumberHeader(headers, 'x-antseed-peer-current-load', selectedPeer.currentLoad)
  setFiniteNumberHeader(headers, 'x-antseed-peer-max-concurrency', selectedPeer.maxConcurrency)
  headers['x-antseed-provider'] = telemetry.pricing.provider
  if (telemetry.pricing.service) {
    headers['x-antseed-service'] = telemetry.pricing.service
  }
  setPricingHeaders(headers, telemetry.pricing)
  setUnitPricedHeader(headers, selectedPeer, telemetry.pricing.provider, telemetry.pricing.service)
  headers['x-antseed-token-source'] = telemetry.usage.source
  headers['x-antseed-input-tokens'] = String(telemetry.usage.inputTokens)
  headers['x-antseed-cached-input-tokens'] = String(telemetry.usage.cachedInputTokens)
  headers['x-antseed-output-tokens'] = String(telemetry.usage.outputTokens)
  headers['x-antseed-total-tokens'] = String(telemetry.usage.totalTokens)
  if (telemetry.estimatedCostUsd !== null && Number.isFinite(telemetry.estimatedCostUsd)) {
    headers['x-antseed-estimated-cost-usd'] = telemetry.estimatedCostUsd.toFixed(6)
  }
  return headers
}

/**
 * Streamed responses carry the seller's advertised prices too (a gateway tells
 * a free seller by them), and the time from sending to the seller's first frame.
 */
export function attachStreamingAntseedHeaders(
  upstreamHeaders: Record<string, string>,
  selectedPeer: PeerInfo,
  request: SerializedHttpRequest,
  firstTokenMs?: number,
): Record<string, string> {
  const headers: Record<string, string> = withoutRouterHeaders(upstreamHeaders)
  headers['x-antseed-request-id'] = request.requestId
  if (firstTokenMs !== undefined) headers['x-antseed-first-token-ms'] = String(Math.max(0, Math.floor(firstTokenMs)))
  setPeerIdentityHeaders(headers, selectedPeer)
  const service = extractRequestedService(request)
  if (service) headers['x-antseed-service'] = service
  const provider = pickProviderForPeer(selectedPeer, request)
  setPricingHeaders(headers, resolvePeerPricing(selectedPeer, provider, service))
  setUnitPricedHeader(headers, selectedPeer, provider, service)
  return headers
}
