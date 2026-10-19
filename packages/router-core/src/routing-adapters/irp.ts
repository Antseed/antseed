import { createHash, randomUUID } from 'node:crypto'
import {
  IRP_ANY_MODEL,
  IRP_DEFAULT_COST_QUALITY_TRADEOFF,
  IRP_MAX_CANDIDATE_ID_LENGTH,
  IRP_MODELS_PATH,
  IRP_RANK_PATH,
  IRP_SUGGEST_PROTOCOL,
  ROUTER_ANY_MODEL,
  detectRequestServiceApiProtocol,
  parseIrpModelEntries,
  parseIrpProblem,
  renderRequestBodyAsOpenAIChat,
  validateIrpRankRequest,
  validateIrpRankResponse,
  type IrpCandidate,
  type IrpInferenceRequest,
  type IrpPricing,
  type IrpRankRequest,
  type RouteCandidate,
  type RouteRecommendation,
  type RouterModelEntry,
  type RouterPricing,
  type SerializedHttpRequest,
} from '@antseed/node'
import { candidatePricing, RouterCannotRankError, type RoutingClientAdapter } from './types.js'

const decodeJson = (body: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(body))
const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

/**
 * IRP candidate `id`: `provider:model@peer`, readable in buyer and router logs. IDs longer than
 * 128 characters become a SHA-256 of the same string. The buyer always maps IDs back through the
 * candidates it sent and never parses them.
 */
export function irpCandidateId(candidate: Pick<RouteCandidate, 'peerId' | 'provider' | 'serviceId'>): string {
  const id = `${candidate.provider}:${candidate.serviceId}@${candidate.peerId}`
  return id.length <= IRP_MAX_CANDIDATE_ID_LENGTH ? id : `sha256:${createHash('sha256').update(id).digest('hex')}`
}

function toIrpPricing(pricing: RouterPricing): IrpPricing {
  return { input: pricing.inputUsdPerMillion, cache_read: pricing.cachedInputUsdPerMillion, output: pricing.outputUsdPerMillion }
}

function fromIrpPricing(pricing: Partial<IrpPricing>): Partial<RouterPricing> {
  return {
    ...(pricing.input !== undefined ? { inputUsdPerMillion: pricing.input } : {}),
    ...(pricing.cache_read !== undefined ? { cachedInputUsdPerMillion: pricing.cache_read } : {}),
    ...(pricing.output !== undefined ? { outputUsdPerMillion: pricing.output } : {}),
  }
}

/**
 * The request being routed as an OpenAI Chat Completions body (IRP `request`). Anthropic Messages
 * and Responses bodies run through the same adapters used for dispatch. `model` and `stream` are
 * dropped: routers ignore them and never forward the request.
 */
function irpInferenceRequest(request: SerializedHttpRequest, body: Record<string, unknown>): IrpInferenceRequest {
  const protocol = detectRequestServiceApiProtocol(request)
  const chat = protocol ? renderRequestBodyAsOpenAIChat(protocol, body) : null
  if (!chat) throw new Error('Routing supports Chat Completions, Anthropic Messages and Responses requests')
  delete chat.model
  delete chat.stream
  delete chat.stream_options
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) throw new Error('Routing requires at least one message')
  return chat as IrpInferenceRequest
}

/** Error text for a non-2xx router response, using IRP problem details when present. */
function routerFailure(action: string, statusCode: number, body: Uint8Array): Error {
  let problem: ReturnType<typeof parseIrpProblem> = null
  try { problem = parseIrpProblem(decodeJson(body)) } catch { /* not JSON */ }
  const detail = problem?.detail ?? problem?.title
  const suffix = detail ? `: ${detail}` : ''
  switch (statusCode) {
    case 400: return new Error(`Router rejected the ${action} request${suffix}`)
    case 402: return new Error('Routing payment could not be completed. The channel may have unpaid or disputed work. Select a model or another router.')
    // IRP 422: no candidate could be scored; the buyer's model list may be stale.
    case 422: return new RouterCannotRankError(`Router cannot rank any allowed candidate. Update the allowed models or choose another router${suffix}`)
    case 503: return new Error(`Router is temporarily unavailable${suffix}`)
    default: return new Error(`Routing ${action} failed (${statusCode})${suffix}`)
  }
}

/**
 * `irp-suggest`: Inference Routing Protocol suggest-only mode.
 * - catalog: free `GET /v1/routing/models`; `*` means any model, with optional `max_pricing`.
 * - rank: paid `POST /v1/routing/rank`; the router orders the buyer's allowed candidates.
 * - options: `cost_quality_tradeoff`, 0 (best quality) to 10 (cheapest), router default 5.
 */
export const irpSuggestAdapter: RoutingClientAdapter = {
  protocol: IRP_SUGGEST_PROTOCOL,
  options: [{
    key: 'cost_quality_tradeoff',
    type: 'integer',
    label: 'Cost vs. quality',
    description: '0 picks the best quality regardless of price; 10 picks the cheapest acceptable model.',
    minimum: 0,
    maximum: 10,
    default: IRP_DEFAULT_COST_QUALITY_TRADEOFF,
  }],

  async listModels(router, context) {
    const response = await context.sendRequest(router, {
      requestId: randomUUID(), method: 'GET', path: IRP_MODELS_PATH,
      headers: { accept: 'application/json' },
      body: new Uint8Array(),
    })
    context.signal.throwIfAborted()
    if (response.statusCode < 200 || response.statusCode >= 300) throw routerFailure('models', response.statusCode, response.body)
    return parseIrpModelEntries(decodeJson(response.body)).map((entry): RouterModelEntry => ({
      id: entry.id === IRP_ANY_MODEL ? ROUTER_ANY_MODEL : entry.id,
      ...(entry.max_pricing ? { maxPricing: fromIrpPricing(entry.max_pricing) } : {}),
    }))
  },

  async rank({ request, body, router, candidates, options, context }) {
    const sent = candidates.map((candidate): IrpCandidate => ({
      id: irpCandidateId(candidate),
      model: candidate.routerModel ?? candidate.serviceId,
      pricing: toIrpPricing(candidatePricing(candidate)),
      // Absent means 0, so only send what was observed.
      ...(candidate.expectedCachedInputTokens > 0 ? { expected_usage: { cache_read_tokens: candidate.expectedCachedInputTokens } } : {}),
    }))
    const rankRequest: IrpRankRequest = {
      request: irpInferenceRequest(request, body),
      routing: {
        ...(typeof options.cost_quality_tradeoff === 'number' ? { cost_quality_tradeoff: options.cost_quality_tradeoff } : {}),
        candidates: sent,
      },
    }
    validateIrpRankRequest(rankRequest)
    const response = await context.sendRequest(router, {
      requestId: randomUUID(), method: 'POST', path: IRP_RANK_PATH,
      headers: { 'content-type': 'application/json' },
      body: encodeJson(rankRequest),
    }, { signal: context.signal })
    context.signal.throwIfAborted()
    if (response.statusCode < 200 || response.statusCode >= 300) throw routerFailure('rank', response.statusCode, response.body)
    const byId = new Map(sent.map((candidate, index) => [candidate.id, candidates[index]!]))
    return validateIrpRankResponse(decodeJson(response.body), sent).map((entry): RouteRecommendation => {
      const { serviceId, peerId, provider } = byId.get(entry.candidate_id)!
      return { serviceId, peerId, provider, ...(entry.reasoning_effort ? { reasoningEffort: entry.reasoning_effort } : {}) }
    })
  },
}

