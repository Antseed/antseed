import { createHash, randomUUID } from 'node:crypto'
import {
  MAX_ROUTING_CANDIDATE_ID_LENGTH,
  MODEL_ROUTING_MODELS_PATH,
  MODEL_ROUTING_PROTOCOL,
  MODEL_ROUTING_RANK_PATH,
  ROUTING_SERVICE_HEADER,
  detectRequestServiceApiProtocol,
  parseRoutingModelsResponse,
  parseRoutingProblem,
  renderRequestBodyAsOpenAIChat,
  validateRoutingRankRequest,
  validateRoutingRankResponse,
  type PeerInfo,
  type RouteCandidate,
  type RouteRecommendation,
  type RouteSelectionContext,
  type RoutingCandidateV1,
  type RoutingModelsContext,
  type RoutingInferenceRequestV1,
  type RoutingRankRequestV1,
  type RoutingServiceTarget,
  type RoutingUsageObservation,
  type SerializedHttpRequest,
} from '@antseed/node'
import { CacheObservations } from './cache-observations.js'

const MAX_CACHED_CONVERSATIONS = 500

/** The last paid recommendation per conversation, reused while the turn and its inputs are unchanged. */
type CachedRoute = { text: string; fingerprint: string; routes: RouteRecommendation[] }

const decodeJson = (body: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(body))
const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n')
}

/**
 * The latest user-written text in a Chat Completions, Messages or Responses body. User messages
 * without text (e.g. Anthropic `tool_result`-only turns) are skipped, so a tool loop keeps
 * resolving to the prompt that started it.
 */
export function latestUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = contentText(message.content)
    if (text.trim()) return text
  }
  return typeof body.input === 'string' ? body.input : ''
}

/**
 * The request being routed as an OpenAI Chat Completions body. Anthropic Messages and Responses
 * bodies run through the same adapters used for dispatch. `model` and `stream` are dropped:
 * routers ignore them and never forward the request.
 */
export function routingInferenceRequest(request: SerializedHttpRequest, body: Record<string, unknown>): RoutingInferenceRequestV1 {
  const protocol = detectRequestServiceApiProtocol(request)
  const chat = protocol ? renderRequestBodyAsOpenAIChat(protocol, body) : null
  if (!chat) throw new Error('Routing supports Chat Completions, Anthropic Messages and Responses requests')
  delete chat.model
  delete chat.stream
  delete chat.stream_options
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) throw new Error('Routing requires at least one message')
  return chat as RoutingInferenceRequestV1
}

/** The selected router peer, checked to advertise this exact model-routing service. */
function findRouterPeer(peers: PeerInfo[], target: RoutingServiceTarget): PeerInfo {
  const peer = peers.find(entry => entry.peerId === target.peerId)
  if (peer && !Array.isArray(peer.metadata?.providers)) {
    throw new Error('Selected router metadata is not available yet. Wait for discovery or restart the router.')
  }
  const provider = peer?.metadata?.providers.find(entry => entry.provider === target.provider && entry.services.includes(target.serviceId))
  if (!peer || !provider) throw new Error('Selected routing service is not advertised by the selected peer')
  if (!provider.serviceApiProtocols?.[target.serviceId]?.includes(MODEL_ROUTING_PROTOCOL)) {
    throw new Error('Selected service does not advertise model-routing')
  }
  return peer
}

/** Error text for a non-2xx router response, using IRP problem details when present. */
function routerFailure(action: string, statusCode: number, body: Uint8Array): Error {
  let problem: ReturnType<typeof parseRoutingProblem> = null
  try { problem = parseRoutingProblem(decodeJson(body)) } catch { /* not JSON */ }
  const detail = problem?.detail ?? problem?.title
  const suffix = detail ? `: ${detail}` : ''
  switch (statusCode) {
    case 400: return new Error(`Router rejected the ${action} request${suffix}`)
    case 402: return new Error('Routing payment could not be completed. The channel may have unpaid or disputed work. Select a model or another router.')
    case 422: return new RouterCannotRankError(`Router cannot rank any allowed candidate. Update the allowed models or choose another router${suffix}`)
    case 503: return new Error(`Router is temporarily unavailable${suffix}`)
    default: return new Error(`Routing ${action} failed (${statusCode})${suffix}`)
  }
}

/** IRP 422: no candidate could be scored. The host may refresh the model list and retry once. */
export class RouterCannotRankError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouterCannotRankError'
  }
}

/**
 * IRP candidate `id`: `provider:model@peer`, readable in buyer and router logs. IDs longer than
 * 128 characters become a SHA-256 of the same string. The buyer always maps IDs back through the
 * candidates it sent and never parses them.
 */
export function routingCandidateId(candidate: Pick<RouteCandidate, 'peerId' | 'provider' | 'serviceId'>): string {
  const id = `${candidate.provider}:${candidate.serviceId}@${candidate.peerId}`
  return id.length <= MAX_ROUTING_CANDIDATE_ID_LENGTH ? id : `sha256:${createHash('sha256').update(id).digest('hex')}`
}

/**
 * Buyer side of `model-routing`, AntSeed's binding of Inference Routing Protocol suggest-only mode:
 * - `listModels`: free `GET /v1/routing/models`; the models the router can score.
 * - `selectRoute`: paid `POST /v1/routing/rank` once per user turn; the router orders the buyer's allowed candidates.
 * - `recordUsage`: observed prompt-cache reuse, sent to the router with later candidates.
 * It never sends inference; the buyer proxy dispatches the returned recommendations.
 */
export class ModelRoutingClient {
  private readonly lastRoutes = new Map<string, CachedRoute>()
  readonly observations = new CacheObservations()

  recordUsage(observation: RoutingUsageObservation): void {
    this.observations.record(observation)
  }

  async listModels(target: RoutingServiceTarget, peers: PeerInfo[], context: RoutingModelsContext): Promise<string[]> {
    const response = await context.sendRequest(findRouterPeer(peers, target), {
      requestId: randomUUID(), method: 'GET', path: MODEL_ROUTING_MODELS_PATH,
      headers: { accept: 'application/json', 'x-antseed-provider': target.provider, [ROUTING_SERVICE_HEADER]: target.serviceId },
      body: new Uint8Array(),
    })
    context.signal.throwIfAborted()
    if (response.statusCode < 200 || response.statusCode >= 300) throw routerFailure('models', response.statusCode, response.body)
    return parseRoutingModelsResponse(decodeJson(response.body))
  }

  async selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null> {
    context.signal.throwIfAborted()
    const body = decodeJson(request.body) as Record<string, unknown>
    const text = latestUserText(body)
    if (!text.trim()) throw new Error('Routing requires user text in messages or Responses input')
    if (!context.candidates.length) throw new Error('No eligible candidates supported by this router')
    const rankRequest = this.buildRankRequest(routingInferenceRequest(request, body), context)
    validateRoutingRankRequest(rankRequest)

    // Tool-loop continuations repeat the same user turn: reuse its recommendation instead of paying again.
    const key = context.conversationKey
    const fingerprint = JSON.stringify([context.routingService, context.costQualityTradeoff ?? null,
      rankRequest.routing.candidates.map(({ id }) => id)])
    const cached = key ? this.lastRoutes.get(key) : undefined
    if (cached?.text === text && cached.fingerprint === fingerprint && context.acceptRecommendations(cached.routes)) {
      return structuredClone(cached.routes)
    }
    if (key) this.lastRoutes.delete(key)

    const routes = await this.rank(rankRequest, findRouterPeer(peers, context.routingService), context)
    if (key) {
      this.lastRoutes.set(key, { text, fingerprint, routes: structuredClone(routes) })
      if (this.lastRoutes.size > MAX_CACHED_CONVERSATIONS) this.lastRoutes.delete(this.lastRoutes.keys().next().value!)
    }
    return routes
  }

  private buildRankRequest(inference: RoutingInferenceRequestV1, context: RouteSelectionContext): RoutingRankRequestV1 {
    // Rough prompt size (characters / 4), used only to cap expected cache reuse.
    const estimatedTokens = Math.ceil(encodeJson(inference.messages).length / 4)
    return {
      request: inference,
      routing: {
        ...(context.costQualityTradeoff !== undefined ? { cost_quality_tradeoff: context.costQualityTradeoff } : {}),
        candidates: context.candidates.map((candidate): RoutingCandidateV1 => {
          const cacheReadTokens = this.observations.expectedCachedInputTokens(context.conversationKey, candidate, estimatedTokens)
          return {
            id: routingCandidateId(candidate),
            model: candidate.routerModel ?? candidate.serviceId,
            // Sellers without a cached-input price bill cache reads at the input price.
            pricing: {
              input: candidate.inputUsdPerMillion,
              cache_read: candidate.cachedInputUsdPerMillion ?? candidate.inputUsdPerMillion,
              output: candidate.outputUsdPerMillion,
            },
            // Absent means 0, so only send what was observed.
            ...(cacheReadTokens > 0 ? { expected_usage: { cache_read_tokens: cacheReadTokens } } : {}),
          }
        }),
      },
    }
  }

  /** The paid call. Keeps only ranked entries naming a sent candidate, in the router's order. */
  private async rank(rankRequest: RoutingRankRequestV1, routerPeer: PeerInfo, context: RouteSelectionContext): Promise<RouteRecommendation[]> {
    const response = await context.sendRequest(routerPeer, {
      requestId: randomUUID(), method: 'POST', path: MODEL_ROUTING_RANK_PATH,
      headers: {
        'content-type': 'application/json',
        'x-antseed-provider': context.routingService.provider,
        [ROUTING_SERVICE_HEADER]: context.routingService.serviceId,
      },
      body: encodeJson(rankRequest),
    }, { signal: context.signal })
    context.signal.throwIfAborted()
    if (response.statusCode < 200 || response.statusCode >= 300) throw routerFailure('rank', response.statusCode, response.body)
    const candidates = rankRequest.routing.candidates
    const byId = new Map(candidates.map((candidate, index) => [candidate.id, context.candidates[index]!]))
    const routes = validateRoutingRankResponse(decodeJson(response.body), candidates).map((entry): RouteRecommendation => {
      const { serviceId, peerId, provider } = byId.get(entry.candidate_id)!
      return { serviceId, peerId, provider, ...(entry.reasoning_effort ? { reasoningEffort: entry.reasoning_effort } : {}) }
    })
    if (!context.acceptRecommendations(routes)) throw new Error('Router returned no usable recommendation')
    return routes
  }
}

/** The `ModelRoutingClient` surface the buyer proxy calls; tests can supply a stand-in. */
export type ModelRoutingClientApi = Pick<ModelRoutingClient, 'listModels' | 'selectRoute'> & Partial<Pick<ModelRoutingClient, 'recordUsage'>>
