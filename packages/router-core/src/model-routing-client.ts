import { randomUUID } from 'node:crypto'
import {
  MODEL_ROUTING_DESCRIBE_PATH,
  MODEL_ROUTING_PROTOCOL,
  MODEL_ROUTING_RANK_PATH,
  RoutingDescriptionChangedError,
  detectRequestServiceApiProtocol,
  renderRequestBodyAsOpenAIChat,
  validateRoutingDescribeResponse,
  validateRoutingRankRequest,
  validateRoutingRankResponse,
  type PeerInfo,
  type RouteRecommendation,
  type RouteSelectionContext,
  type RoutingCandidateV1,
  type RoutingDescribeContext,
  type RoutingDescribeResponseV1,
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

function rankFailure(statusCode: number): Error {
  switch (statusCode) {
    case 409: return new RoutingDescriptionChangedError()
    case 422: return new Error('Router cannot rank any allowed candidate. Update the allowed models or choose another router.')
    case 402: return new Error('Routing payment could not be completed. The channel may have unpaid or disputed work. Select a model or another router.')
    default: return new Error(`Routing failed (${statusCode})`)
  }
}

/**
 * Buyer side of the generic `model-routing` protocol:
 * - `describe`: free; the router's supported models and settings.
 * - `selectRoute`: paid once per user turn; the router orders the buyer's allowed candidates.
 * - `recordUsage`: observed prompt-cache reuse, sent to the router with later candidates.
 * It never sends inference; the buyer proxy dispatches the returned recommendations.
 */
export class ModelRoutingClient {
  private readonly lastRoutes = new Map<string, CachedRoute>()
  readonly observations = new CacheObservations()

  recordUsage(observation: RoutingUsageObservation): void {
    this.observations.record(observation)
  }

  async describe(target: RoutingServiceTarget, peers: PeerInfo[], context: RoutingDescribeContext): Promise<RoutingDescribeResponseV1> {
    const response = await context.sendRequest(findRouterPeer(peers, target), {
      requestId: randomUUID(), method: 'GET',
      path: `${MODEL_ROUTING_DESCRIBE_PATH}?${new URLSearchParams({ service: target.serviceId })}`,
      headers: { accept: 'application/json', 'x-antseed-provider': target.provider }, body: new Uint8Array(),
    })
    context.signal.throwIfAborted()
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Router description unavailable (${response.statusCode})`)
    const description = decodeJson(response.body)
    validateRoutingDescribeResponse(description)
    return description
  }

  async selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null> {
    context.signal.throwIfAborted()
    const body = decodeJson(request.body) as Record<string, unknown>
    const text = latestUserText(body)
    if (!text.trim()) throw new Error('Routing requires user text in messages or Responses input')
    if (!context.candidates.length) throw new Error('No eligible candidates supported by this router')
    const rankRequest = this.buildRankRequest(routingInferenceRequest(request, body), context)
    validateRoutingRankRequest(rankRequest, context.description)

    // Tool-loop continuations repeat the same user turn: reuse its recommendation instead of paying again.
    const key = context.conversationKey
    const fingerprint = JSON.stringify([context.routingService, rankRequest.revision, rankRequest.preferences,
      rankRequest.candidates.map(({ model, peer, provider }) => [peer, provider, model])])
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
      service: context.routingService.serviceId,
      revision: context.description.revision,
      preferences: context.preferences,
      request: inference,
      candidates: context.candidates.map((candidate): RoutingCandidateV1 => {
        const cacheReadTokens = this.observations.expectedCachedInputTokens(context.conversationKey, candidate, estimatedTokens)
        return {
          model: candidate.serviceId,
          peer: candidate.peerId,
          provider: candidate.provider,
          price: {
            inputUsdPerMillion: candidate.inputUsdPerMillion,
            outputUsdPerMillion: candidate.outputUsdPerMillion,
            ...(candidate.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: candidate.cachedInputUsdPerMillion } : {}),
          },
          // Absent means 0, so only send what was observed.
          ...(cacheReadTokens > 0 ? { expected_usage: { cache_read_tokens: cacheReadTokens } } : {}),
        }
      }),
    }
  }

  /** The paid call. Keeps only recommendations naming a sent candidate, in the router's order. */
  private async rank(rankRequest: RoutingRankRequestV1, routerPeer: PeerInfo, context: RouteSelectionContext): Promise<RouteRecommendation[]> {
    const response = await context.sendRequest(routerPeer, {
      requestId: randomUUID(), method: 'POST', path: MODEL_ROUTING_RANK_PATH,
      headers: { 'content-type': 'application/json', 'x-antseed-provider': context.routingService.provider },
      body: encodeJson(rankRequest),
    }, { signal: context.signal })
    context.signal.throwIfAborted()
    if (response.statusCode < 200 || response.statusCode >= 300) throw rankFailure(response.statusCode)
    const routes = validateRoutingRankResponse(decodeJson(response.body), rankRequest.candidates)
      .map(({ model, peer, provider }) => ({ serviceId: model, peerId: peer, provider }))
    if (!context.acceptRecommendations(routes)) throw new Error('Router returned no usable recommendation')
    return routes
  }
}

/** The `ModelRoutingClient` surface the buyer proxy calls; tests can supply a stand-in. */
export type ModelRoutingClientApi = Pick<ModelRoutingClient, 'describe' | 'selectRoute'> & Partial<Pick<ModelRoutingClient, 'recordUsage'>>
