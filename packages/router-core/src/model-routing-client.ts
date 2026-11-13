import {
  routingProtocolOf,
  routingWireProtocol,
  type PeerInfo,
  type RouteRecommendation,
  type RouterModelEntry,
  type RouterOptions,
  type RouteSelectionContext,
  type RoutingModelsContext,
  type RoutingProtocol,
  type RoutingServiceTarget,
  type RoutingUsageObservation,
  type SerializedHttpRequest,
} from '@antseed/node'
import { CacheObservations } from './cache-observations.js'
import { routingClientAdapter } from './routing-adapters/index.js'
import { validateRouterOptions, type RoutingClientAdapter } from './routing-adapters/types.js'

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
function latestUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = contentText(message.content)
    if (text.trim()) return text
  }
  return typeof body.input === 'string' ? body.input : ''
}

/** The routing protocol a target service advertises on its peer. */
export function routingProtocolOfTarget(peers: PeerInfo[], target: RoutingServiceTarget): RoutingProtocol | null {
  const peer = peers.find(entry => entry.peerId === target.peerId)
  const provider = peer?.metadata?.providers?.find(entry => entry.provider === target.provider && entry.services.includes(target.serviceId))
  return routingProtocolOf(provider?.serviceApiProtocols?.[target.serviceId])
}

/** The selected router peer, checked to advertise this exact routing service, and its protocol. */
function findRouterPeer(peers: PeerInfo[], target: RoutingServiceTarget): { peer: PeerInfo; protocol: RoutingProtocol } {
  const peer = peers.find(entry => entry.peerId === target.peerId)
  if (peer && !Array.isArray(peer.metadata?.providers)) {
    throw new Error('Selected router metadata is not available yet. Wait for discovery or restart the router.')
  }
  const provider = peer?.metadata?.providers?.find(entry => entry.provider === target.provider && entry.services.includes(target.serviceId))
  if (!peer || !provider) throw new Error('Selected routing service is not advertised by the selected peer')
  const protocol = routingProtocolOf(provider.serviceApiProtocols?.[target.serviceId])
  if (!protocol) throw new Error('Selected service does not advertise a routing protocol')
  // Protocols whose paths name no service need the router peer to offer exactly one service of that protocol.
  if (routingWireProtocol(protocol).oneServicePerSeller) {
    const sameProtocol = peer.metadata!.providers.flatMap(entry => entry.services
      .filter(service => routingProtocolOf(entry.serviceApiProtocols?.[service]) === protocol))
    if (sameProtocol.length !== 1) throw new Error(`Selected peer advertises more than one ${protocol} routing service`)
  }
  return { peer, protocol }
}

/**
 * Buyer side of routing services, independent of any routing protocol:
 * - `listModels`: the models the router can rank (free).
 * - `selectRoute`: one paid ranking per user turn; the router orders the buyer's allowed candidates.
 * - `recordUsage`: observed prompt-cache reuse, given to the router with later candidates.
 * The router's advertised protocol picks the adapter that speaks its wire format
 * (`routing-adapters/`). It never sends inference; the buyer proxy dispatches the result.
 */
export class ModelRoutingClient {
  private readonly lastRoutes = new Map<string, CachedRoute>()
  readonly observations = new CacheObservations()

  recordUsage(observation: RoutingUsageObservation): void {
    this.observations.record(observation)
  }

  /** The adapter for a target's routing protocol, e.g. to read the options it accepts. */
  adapterFor(target: RoutingServiceTarget, peers: PeerInfo[]): RoutingClientAdapter {
    return routingClientAdapter(findRouterPeer(peers, target).protocol)
  }

  /** Validate router options for a target before any ranking is bought; throws `InvalidRouterOptionsError`. */
  validateOptions(target: RoutingServiceTarget, peers: PeerInfo[], options: RouterOptions | undefined): RouterOptions {
    return validateRouterOptions(this.adapterFor(target, peers).options, options)
  }

  async listModels(target: RoutingServiceTarget, peers: PeerInfo[], context: RoutingModelsContext): Promise<RouterModelEntry[]> {
    const { peer, protocol } = findRouterPeer(peers, target)
    return routingClientAdapter(protocol).listModels(peer, context)
  }

  async selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null> {
    context.signal.throwIfAborted()
    const { peer: router, protocol } = findRouterPeer(peers, context.routingService)
    const adapter = routingClientAdapter(protocol)
    const options = validateRouterOptions(adapter.options, context.options)
    const body = decodeJson(request.body) as Record<string, unknown>
    const text = latestUserText(body)
    if (!text.trim()) throw new Error('Routing requires user text in messages or Responses input')
    if (!context.candidates.length) throw new Error('No eligible candidates supported by this router')

    // Tool-loop continuations repeat the same user turn: reuse its recommendation instead of paying
    // again, even when the candidate set changed in between (a peer refresh reorders, adds or drops
    // sellers). A new ranking is bought only when none of the saved picks is still usable.
    const key = context.conversationKey
    const fingerprint = JSON.stringify([context.routingService, Object.entries(options).sort(([a], [b]) => a.localeCompare(b))])
    const cached = key ? this.lastRoutes.get(key) : undefined
    if (cached?.text === text && cached.fingerprint === fingerprint && context.acceptRecommendations(cached.routes)) {
      return structuredClone(cached.routes)
    }
    if (key) this.lastRoutes.delete(key)

    // Rough prompt size (characters / 4), used only to cap expected cache reuse.
    const estimatedTokens = Math.ceil(encodeJson(body.messages ?? body.input ?? '').length / 4)
    const candidates = context.candidates.map(candidate => ({
      ...candidate,
      expectedCachedInputTokens: this.observations.expectedCachedInputTokens(context.conversationKey, candidate, estimatedTokens),
    }))
    const routes = await adapter.rank({ request, body, router, candidates, options, context })
    if (!context.acceptRecommendations(routes)) throw new Error('Router returned no usable recommendation')
    if (key) {
      this.lastRoutes.set(key, { text, fingerprint, routes: structuredClone(routes) })
      if (this.lastRoutes.size > MAX_CACHED_CONVERSATIONS) this.lastRoutes.delete(this.lastRoutes.keys().next().value!)
    }
    return routes
  }
}

/** The `ModelRoutingClient` surface the buyer proxy calls; tests can supply a stand-in. */
export type ModelRoutingClientApi = Pick<ModelRoutingClient, 'listModels' | 'selectRoute'> & Partial<Pick<ModelRoutingClient, 'recordUsage'>>
