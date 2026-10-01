import { randomUUID } from 'node:crypto'
import {
  MODEL_ROUTING_DESCRIBE_PATH,
  MODEL_ROUTING_PROTOCOL,
  MODEL_ROUTING_RANK_PATH,
  RoutingDescriptionChangedError,
  canonicalRoutingJson,
  completedRequestPrice,
  resolveServiceBillingOffer,
  validateRoutingDescribeResponse,
  validateRoutingRankRequest,
  validateRoutingRankResponse,
  type PeerInfo,
  type RouteRecommendation,
  type RouteSelectionContext,
  type RoutingCandidateV1,
  type RoutingDescribeContext,
  type RoutingDescribeResponseV1,
  type RoutingRankRequestV1,
  type RoutingRecommendationV1,
  type RoutingServiceTarget,
  type RoutingUsageObservation,
  type SerializedHttpRequest,
} from '@antseed/node'
import { CacheObservations } from './cache-observations.js'

const MAX_INPUT_TEXT_CHARS = 8192
const MAX_CACHED_CONVERSATIONS = 500

type CachedRoute = { text: string; fingerprint: string; routes: RouteRecommendation[] }

function decodeJson(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body))
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

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

/** Keeps the start and end of long prompts, where instructions usually live. */
function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars / 2) + text.slice(-maxChars / 2)
}

function estimateTokens(value: unknown): number {
  return Math.ceil(encodeJson(value).length / 4)
}

function findPeer(peers: PeerInfo[], target: RoutingServiceTarget): PeerInfo {
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

function resolveRoutingOffer(peer: PeerInfo, target: RoutingServiceTarget) {
  let offer
  try {
    offer = peer.metadata && resolveServiceBillingOffer(peer.metadata.providers, target.provider, target.serviceId)
  } catch {}
  if (!offer || offer.serviceApiProtocol !== MODEL_ROUTING_PROTOCOL) throw new Error('Selected service does not advertise a model-routing offer')
  return offer
}

function toRecommendations(entries: RoutingRecommendationV1[]): RouteRecommendation[] {
  return entries.map(entry => ({ serviceId: entry.model, peerId: entry.peer, provider: entry.provider }))
}

function rankFailure(statusCode: number): Error {
  switch (statusCode) {
    case 409: return new RoutingDescriptionChangedError()
    case 422: return new Error('Router cannot rank any allowed candidate. Update the allowed models or choose another router.')
    case 402: return new Error('Routing payment could not be completed. The channel may have unpaid or disputed work. Select a model or another router; no unaccepted response will be authorized.')
    default: return new Error(`Routing failed (${statusCode})`)
  }
}

/**
 * Buyer side of the generic `model-routing` protocol: describe the router for free, then pay
 * a fixed fee per rank call. The buyer decides which candidates are allowed; the router only
 * orders them.
 */
export class ModelRoutingClient {
  private readonly conversations = new Map<string, CachedRoute>()
  readonly observations = new CacheObservations()

  recordUsage(observation: RoutingUsageObservation): void {
    this.observations.record(observation)
  }

  async describe(target: RoutingServiceTarget, peers: PeerInfo[], context: RoutingDescribeContext): Promise<RoutingDescribeResponseV1> {
    const query = new URLSearchParams({ service: target.serviceId })
    const response = await context.sendRequest(findPeer(peers, target), {
      requestId: randomUUID(), method: 'GET', path: `${MODEL_ROUTING_DESCRIBE_PATH}?${query}`,
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
    const target = context.routingService
    const body = decodeJson(request.body) as Record<string, unknown>
    const text = latestUserText(body)
    if (!text.trim()) throw new Error('Routing requires user text in messages or Responses input')
    if (!context.candidates.length) throw new Error('No eligible candidates supported by this router')

    const rankRequest = this.buildRankRequest(body, text, context)
    validateRoutingRankRequest(rankRequest, context.description)

    // Tool continuations repeat the same user turn; reuse its recommendation instead of paying again.
    const fingerprint = canonicalRoutingJson({
      target, revision: rankRequest.revision, preferences: rankRequest.preferences,
      candidates: rankRequest.candidates.map(({ model, peer, provider }) => [peer, provider, model]),
    })
    const cached = this.cachedRoutes(context, text, fingerprint)
    if (cached) return cached

    const recommendations = await this.rank(rankRequest, findPeer(peers, target), context)
    this.cacheRoutes(context.conversationKey, { text, fingerprint, routes: structuredClone(recommendations) })
    return recommendations
  }

  private buildRankRequest(body: Record<string, unknown>, text: string, context: RouteSelectionContext): RoutingRankRequestV1 {
    const estimatedTokens = estimateTokens(body.messages ?? body.input ?? text)
    const candidates: RoutingCandidateV1[] = context.candidates.map(candidate => ({
      model: candidate.serviceId,
      peer: candidate.peerId,
      provider: candidate.provider,
      price: {
        inputUsdPerMillion: candidate.inputUsdPerMillion,
        outputUsdPerMillion: candidate.outputUsdPerMillion,
        ...(candidate.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: candidate.cachedInputUsdPerMillion } : {}),
      },
      expectedCachedInputTokens: this.observations.expectedCachedInputTokens(context.conversationKey, candidate, estimatedTokens),
    }))
    return {
      version: 1,
      service: context.routingService.serviceId,
      revision: context.description.revision,
      preferences: context.preferences,
      input: { text: truncateMiddle(text, MAX_INPUT_TEXT_CHARS), estimatedTokens },
      candidates,
    }
  }

  private async rank(rankRequest: RoutingRankRequestV1, routingPeer: PeerInfo, context: RouteSelectionContext): Promise<RouteRecommendation[]> {
    const offer = resolveRoutingOffer(routingPeer, context.routingService)
    let recommendations: RouteRecommendation[] | undefined
    const response = await context.sendRequest(routingPeer, {
      requestId: randomUUID(), method: 'POST', path: MODEL_ROUTING_RANK_PATH,
      headers: { 'content-type': 'application/json' },
      body: encodeJson(rankRequest),
    }, {
      signal: context.signal,
      unitBilling: offer,
      maxFeeMicroUsdc: completedRequestPrice(offer.unitModel).toString(),
      // Only pay for a response whose recommendations the buyer can actually use.
      acceptResponse: routeResponse => {
        const routes = toRecommendations(validateRoutingRankResponse(decodeJson(routeResponse.body), rankRequest.candidates))
        if (!context.acceptRecommendations(routes)) return false
        recommendations = routes
        return true
      },
    })
    context.signal.throwIfAborted()
    const succeeded = response.statusCode >= 200 && response.statusCode < 300
    if (!succeeded || !recommendations) throw rankFailure(response.statusCode)
    return recommendations
  }

  private cachedRoutes(context: RouteSelectionContext, text: string, fingerprint: string): RouteRecommendation[] | undefined {
    if (!context.conversationKey) return undefined
    const cached = this.conversations.get(context.conversationKey)
    if (cached?.text === text && cached.fingerprint === fingerprint && context.acceptRecommendations(cached.routes)) {
      return structuredClone(cached.routes)
    }
    this.conversations.delete(context.conversationKey)
    return undefined
  }

  private cacheRoutes(conversationKey: string | null | undefined, entry: CachedRoute): void {
    if (!conversationKey) return
    this.conversations.set(conversationKey, entry)
    if (this.conversations.size > MAX_CACHED_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!)
  }
}

/** The `ModelRoutingClient` surface the buyer proxy calls; tests can supply a stand-in. */
export type ModelRoutingClientApi = Pick<ModelRoutingClient, 'describe' | 'selectRoute'> & Partial<Pick<ModelRoutingClient, 'recordUsage'>>
