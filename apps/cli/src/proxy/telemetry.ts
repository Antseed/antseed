import { isExposedResponseHeader, type PeerInfo, type SerializedHttpRequest } from '@antseed/node'
import { ROUTE_SELECTION_HEADER } from './route-selection.js'
import { extractUsage, toNonNegativeInt } from '@antseed/api-adapter'
import { pickProviderForPeer } from './routing.js'
import { extractRequestedService } from './request-utils.js'

const decoder = new TextDecoder()

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

type UsageCounts = {
  inputTokens: number
  freshInputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
}

const EMPTY_USAGE: UsageCounts = {
  inputTokens: 0,
  freshInputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
}

function parseUsageObject(value: unknown): UsageCounts {
  if (!value || typeof value !== 'object') {
    return EMPTY_USAGE
  }

  // Cache hits arrive in two shapes — a subset of the input count (OpenAI) or
  // a sibling of it (Anthropic). The metering layer already discriminates
  // between them, so reuse it rather than guessing here: without the split,
  // a cached OpenAI response bills every cache hit at the full input rate and
  // a cached Anthropic response bills none of them at all.
  const canonical = extractUsage({ usage: value })

  const usage = value as Record<string, unknown>
  const total = toNonNegativeInt(usage.totalTokens ?? usage.total_tokens ?? usage.total_token_count)
  let input = toNonNegativeInt(
    usage.inputTokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.prompt_tokens
    ?? usage.input_token_count
    ?? usage.prompt_token_count
    ?? usage.cache_creation_input_tokens
    ?? usage.cache_read_input_tokens,
  )
  let output = toNonNegativeInt(
    usage.outputTokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.completion_tokens
    ?? usage.output_token_count
    ?? usage.completion_token_count,
  )

  // Prefer the canonical counts whenever the provider reported usage in a
  // shape the metering layer understands; the loose key matching above only
  // covers the stragglers that report nothing recognizable.
  if (canonical.inputTokens > 0) input = canonical.inputTokens
  if (canonical.outputTokens > 0) output = canonical.outputTokens

  if (total > 0) {
    if (input === 0 && output === 0) {
      output = total
    } else if (output === 0 && input > 0 && total >= input) {
      output = total - input
    } else if (input === 0 && output > 0 && total >= output) {
      input = total - output
    }
  }

  const cachedInputTokens = Math.min(canonical.cachedInputTokens, input)
  return {
    inputTokens: input,
    freshInputTokens: Math.max(0, input - cachedInputTokens),
    cachedInputTokens,
    outputTokens: output,
    totalTokens: input + output,
  }
}

/** Average ~4 bytes per token for English text; used when providers don't return usage counts. */
const BYTES_PER_TOKEN_ESTIMATE = 4

function estimateTokensFromBytes(inputBytes: number, outputBytes: number): TokenUsageSummary {
  const inputTokens = Math.max(1, Math.round(Math.max(0, inputBytes) / BYTES_PER_TOKEN_ESTIMATE))
  const outputTokens = Math.max(1, Math.round(Math.max(0, outputBytes) / BYTES_PER_TOKEN_ESTIMATE))
  return {
    inputTokens,
    freshInputTokens: inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: 'estimated',
  }
}

function parseSseUsage(body: Uint8Array): UsageCounts {
  const text = decoder.decode(body)
  const lines = text.split('\n')
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let cachedInputTokens = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue

    const payload = trimmed.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }

    const directUsage = parseUsageObject(parsed.usage)
    if (directUsage.totalTokens > 0) {
      inputTokens = Math.max(inputTokens, directUsage.inputTokens)
      outputTokens = Math.max(outputTokens, directUsage.outputTokens)
      totalTokens = Math.max(totalTokens, directUsage.totalTokens)
      cachedInputTokens = Math.max(cachedInputTokens, directUsage.cachedInputTokens)
    }

    const message = parsed.message
    const messageUsage = parseUsageObject(message && typeof message === 'object' ? (message as Record<string, unknown>).usage : undefined)
    if (messageUsage.totalTokens > 0) {
      inputTokens = Math.max(inputTokens, messageUsage.inputTokens)
      outputTokens = Math.max(outputTokens, messageUsage.outputTokens)
      totalTokens = Math.max(totalTokens, messageUsage.totalTokens)
      cachedInputTokens = Math.max(cachedInputTokens, messageUsage.cachedInputTokens)
    }
  }

  if (totalTokens <= 0) {
    totalTokens = inputTokens + outputTokens
  }

  const cached = Math.min(cachedInputTokens, inputTokens)
  return {
    inputTokens,
    freshInputTokens: Math.max(0, inputTokens - cached),
    cachedInputTokens: cached,
    outputTokens,
    totalTokens,
  }
}

function parseJsonUsage(body: Uint8Array): UsageCounts {
  try {
    const parsed = JSON.parse(decoder.decode(body)) as Record<string, unknown>
    const direct = parseUsageObject(parsed.usage)
    if (direct.totalTokens > 0) {
      return direct
    }

    const message = parsed.message
    if (message && typeof message === 'object') {
      const nested = parseUsageObject((message as Record<string, unknown>).usage)
      if (nested.totalTokens > 0) {
        return nested
      }
    }

    const result = parsed.result
    if (result && typeof result === 'object') {
      const nested = parseUsageObject((result as Record<string, unknown>).usage)
      if (nested.totalTokens > 0) {
        return nested
      }
    }

    return EMPTY_USAGE
  } catch {
    return EMPTY_USAGE
  }
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

export function computeResponseTelemetry(
  request: SerializedHttpRequest,
  responseHeaders: Record<string, string>,
  responseBody: Uint8Array,
  selectedPeer: PeerInfo,
): ResponseTelemetry {
  const provider = pickProviderForPeer(selectedPeer, request)
  const service = extractRequestedService(request)
  const pricing = resolvePeerPricing(selectedPeer, provider, service)
  const contentType = (responseHeaders['content-type'] ?? '').toLowerCase()

  const usageFromBody = contentType.includes('text/event-stream')
    ? parseSseUsage(responseBody)
    : parseJsonUsage(responseBody)

  let usage: TokenUsageSummary
  if (usageFromBody.totalTokens > 0) {
    usage = { ...usageFromBody, source: 'usage' }
  } else {
    usage = estimateTokensFromBytes(request.body.length, responseBody.length)
  }

  let estimatedCostUsd: number | null = null
  if (
    pricing.inputUsdPerMillion !== null &&
    pricing.outputUsdPerMillion !== null &&
    Number.isFinite(pricing.inputUsdPerMillion) &&
    Number.isFinite(pricing.outputUsdPerMillion)
  ) {
    // Sellers meter cache hits at their own rate; a seller that advertises no
    // cached rate charges them as fresh input.
    const cachedUsdPerMillion = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion
    estimatedCostUsd = (
      usage.freshInputTokens * pricing.inputUsdPerMillion
      + usage.cachedInputTokens * cachedUsdPerMillion
      + usage.outputTokens * pricing.outputUsdPerMillion
    ) / 1_000_000
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
  setPricingHeaders(headers, resolvePeerPricing(selectedPeer, pickProviderForPeer(selectedPeer, request), service))
  return headers
}
