/**
 * The gateway's chat: the Vercel AI SDK agent loop, running in the gateway
 * process, for the console's Chat page and `antseed chat` alike.
 *
 *   GET    /chat/models?workspace=<id>   → ChatModel[]  (text models, tool-capable first, with their peers)
 *   GET    /chat/context?workspace=<id>  → ChatContext  (the key that pays, with its limits and usage)
 *   POST   /chat  { id, messages, model, peerId?, workspaceId? } → UI message stream (SSE)
 *   GET    /chat/threads?workspace=<id>  → ChatThread[]  (the caller's conversations, newest first)
 *   GET    /chat/threads/:id             → ChatThreadDetail  (with its UIMessages)
 *   DELETE /chat/threads/:id             → 204
 *
 * Callers are console members (their "Web chat" key in the workspace pays)
 * and API-key sessions (`antseed chat`: that key pays, within its caps). The
 * model calls go to the gateway's own `/v1` as that key, by id (see
 * GATEWAY_INTERNAL_KEY_HEADER), so chat is accounted, budgeted, routed and
 * logged exactly like any request with the key.
 *
 * History follows the AI SDK's chat-persistence pattern: the stored thread is
 * the source of truth, the client's newest message is appended to it, and the
 * conversation is saved as soon as a message arrives (so it is listed while
 * the answer streams) and again, whole, when the answer finishes.
 *
 * Which peer answered is always visible: a pinned peer goes to the buyer as
 * `peerId@model`, and every answer's message metadata names the peer(s) that
 * served it, from the `x-antseed-peer-id` header of each model call, with
 * the tokens used and an estimated cost at that peer's advertised prices.
 */
import { join } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { convertToModelMessages, createIdGenerator, stepCountIs, streamText, type UIMessage } from 'ai'
import { GATEWAY_CONTROL_HEADER } from '../../routing-policy/policy.js'
import { isOrgAdmin, requestActor, requireWorkspaceAccess } from '../console-api/access.js'
import type { ConsoleDeps } from '../console-api/deps.js'
import { ConsoleError, respond, type ConsoleRequest, type ConsoleRouter } from '../console-api/router.js'
import { apiKeyDto } from '../console-api/serialize.js'
import type { ChatContext, ChatMessageMetadata, ChatModel, ChatModelPeer, ChatThread, ChatThreadDetail } from '../console-api/types.js'
import { GATEWAY_INTERNAL_KEY_HEADER } from '../server.js'
import { createKey } from '../services/keys.js'
import type { ChatThreadOwner, ChatThreadSummary } from '../store.js'
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status'
import { chatTools } from './tools.js'

export const CHAT_KEY_LABEL = 'Web chat'
/** Names the conversation for the buyer (`x-<tool>-session-id`, see proxy/conversation-identity.ts). */
export const CHAT_SESSION_HEADER = 'x-antseed-chat-session-id'
/** Tool rounds per answer: enough for search → read → write → run, bounded so a loop cannot spend forever. */
const MAX_STEPS = 12
const MODELS_TTL_MS = 60_000
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const PEER_ID_RE = /^(0x)?[0-9a-fA-F]{40}$/
const newMessageId = createIdGenerator({ prefix: 'msg', size: 16 })

const SYSTEM_PROMPT = `You are the assistant of an Antseed gateway. Antseed is a peer-to-peer network of AI providers; this chat runs on the organization's gateway, on a model the user picked.

You can use tools. Search and read the web for anything current or factual you are unsure about, and cite the pages you used. You also have a private scratch directory for this conversation: write files there when a result is long or the user asks for one.

Answer in Markdown. Be direct.`

export interface ChatRouteOptions {
  /** The gateway's listen port, known once it is listening. */
  gatewayPort: () => number
  /** Optional Brave Search key (ANTSEED_BRAVE_API_KEY); DuckDuckGo otherwise. */
  braveApiKey?: string | null
}

/** Who is chatting, the key that pays, and where their history lives. */
interface Chatter {
  owner: ChatThreadOwner
  keyId: string
  /** Org admins get the shell tool. */
  admin: boolean
  /** For the scratch directory. */
  dirName: string
}

export function chatRouteRegistrar(options: ChatRouteOptions) {
  return (router: ConsoleRouter, deps: ConsoleDeps): void => {
    /** Per chat key: the listing follows the key's routing policy. */
    const modelsCache = new Map<string, { at: number; models: ChatModel[] }>()
    /** Peer id → display name, from the models list, to name the peer that answered. */
    const peerNames = new Map<string, string>()

    /**
     * The member's Web chat key in the workspace, created on first use. It is
     * theirs (their caps and policies apply) when they belong to the
     * workspace; an org admin opening a workspace they are not in gets an
     * unowned key labelled with their name, since keys can only be owned by
     * workspace members.
     */
    const memberChatKeyId = (request: ConsoleRequest, memberId: string, workspaceId: string): string => {
      const usable = (key: { status: string; expiresAt: number | null }) => key.status === 'active' && (key.expiresAt === null || key.expiresAt > deps.now())
      if (deps.store.memberWorkspaceRoles(memberId).has(workspaceId)) {
        const existing = deps.store.listKeys({ workspaceId, ownerMemberId: memberId }).find((key) => key.label === CHAT_KEY_LABEL && usable(key))
        if (existing) return existing.id
        return createKey(deps, requestActor(deps, request), { label: CHAT_KEY_LABEL, workspaceId, ownerMemberId: memberId }, { as: 'owner', self: memberId }).key.id
      }
      const label = `${CHAT_KEY_LABEL} (${deps.store.getMember(memberId)?.label ?? memberId})`.slice(0, 200)
      const existing = deps.store.listKeys({ workspaceId }).find((key) => key.ownerMemberId === null && key.label === label && usable(key))
      if (existing) return existing.id
      return createKey(deps, requestActor(deps, request), { label, workspaceId, ownerMemberId: null }, { as: 'admin' }).key.id
    }

    /** The caller as a chatter in `workspaceId` (members) or in their key's workspace (key sessions). */
    const chatter = (request: ConsoleRequest, workspaceId: string | null): Chatter => {
      const { principal } = request
      if (principal?.kind === 'member') {
        if (!workspaceId) throw new ConsoleError(400, 'invalid_workspace', 'Name the workspace')
        requireWorkspaceAccess(deps.store, principal, workspaceId)
        return {
          owner: { kind: 'member', id: principal.memberId, workspaceId },
          keyId: memberChatKeyId(request, principal.memberId, workspaceId),
          admin: isOrgAdmin(deps.store, principal),
          dirName: principal.memberId,
        }
      }
      if (principal?.kind === 'key') {
        const key = deps.store.getKey(principal.keyId)
        if (!key || key.status !== 'active') throw new ConsoleError(401, 'unauthorized', 'This API key cannot be used')
        if (workspaceId && workspaceId !== key.workspaceId) throw new ConsoleError(403, 'forbidden', 'This API key belongs to another workspace')
        return { owner: { kind: 'key', id: key.id, workspaceId: key.workspaceId }, keyId: key.id, admin: false, dirName: `key-${key.id}` }
      }
      throw new ConsoleError(403, 'forbidden', 'Sign in to the console, or use an API key, to chat')
    }

    const gatewayBase = () => {
      const port = options.gatewayPort()
      if (!port) throw new ConsoleError(503, 'gateway_starting', 'The gateway is still starting')
      return `http://127.0.0.1:${port}/v1`
    }
    /** Headers that make a `/v1` call count as `keyId` (loopback only, with the control secret). */
    const asKey = (keyId: string) => ({ [GATEWAY_INTERNAL_KEY_HEADER]: keyId, [GATEWAY_CONTROL_HEADER]: deps.controlSecret })

    const ownThread = (owner: ChatThreadOwner, id: string) => {
      const thread = deps.store.getChatThread(id)
      if (!thread || thread.owner.kind !== owner.kind || thread.owner.id !== owner.id || thread.workspaceId !== owner.workspaceId) return null
      return thread
    }

    const allow = { allow: ['member', 'key'] as const }

    router.add('GET', '/chat/models', async (request): Promise<ChatModel[]> => {
      const caller = chatter(request, request.query.get('workspace'))
      const cached = modelsCache.get(caller.keyId)
      if (cached && deps.now() - cached.at < MODELS_TTL_MS) return cached.models
      const response = await fetch(`${gatewayBase()}/models`, { headers: asKey(caller.keyId), signal: AbortSignal.timeout(15_000) })
        .catch((error: unknown) => { throw new ConsoleError(502, 'models_unavailable', `Models could not be listed: ${String(error)}`) })
      if (!response.ok) throw new ConsoleError(502, 'models_unavailable', `The gateway answered ${response.status} listing models`)
      const models = mapChatModels(await response.json())
      for (const [keyId, entry] of modelsCache) if (deps.now() - entry.at >= MODELS_TTL_MS) modelsCache.delete(keyId)
      modelsCache.set(caller.keyId, { at: deps.now(), models })
      for (const model of models) for (const peer of model.peers) if (peer.name) peerNames.set(peer.peerId, peer.name)
      return models
    }, allow)

    router.add('GET', '/chat/context', async (request): Promise<ChatContext> => {
      const caller = chatter(request, request.query.get('workspace'))
      const key = deps.store.getKey(caller.keyId)
      if (!key) throw new ConsoleError(404, 'not_found', 'The chat key is gone')
      return { key: apiKeyDto(deps.store, key, deps.now()), workspaceName: deps.store.getWorkspace(key.workspaceId)?.name ?? key.workspaceId }
    }, allow)

    router.add('GET', '/chat/threads', async (request): Promise<ChatThread[]> => {
      const caller = chatter(request, request.query.get('workspace'))
      return deps.store.listChatThreads(caller.owner).map(threadDto)
    }, allow)

    router.add('GET', '/chat/threads/:id', async (request): Promise<ChatThreadDetail> => {
      const caller = chatter(request, request.query.get('workspace'))
      const thread = ownThread(caller.owner, request.params['id'] ?? '')
      if (!thread) throw new ConsoleError(404, 'not_found', 'Conversation not found')
      return { ...threadDto(thread), messages: thread.messages }
    }, allow)

    router.add('DELETE', '/chat/threads/:id', async (request) => {
      const caller = chatter(request, request.query.get('workspace'))
      const thread = ownThread(caller.owner, request.params['id'] ?? '')
      if (!thread) throw new ConsoleError(404, 'not_found', 'Conversation not found')
      deps.store.deleteChatThread(thread.id)
      return respond(204)
    }, allow)

    router.add('POST', '/chat', async (request) => {
      const body = (request.body ?? {}) as { id?: unknown; workspaceId?: unknown; model?: unknown; peerId?: unknown; messages?: unknown }
      const caller = chatter(request, typeof body.workspaceId === 'string' ? body.workspaceId : null)
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!model || model.length > 200) throw new ConsoleError(400, 'invalid_model', 'Pick a model')
      if (!Array.isArray(body.messages) || body.messages.length === 0) throw new ConsoleError(400, 'invalid_messages', 'messages must be a non-empty array')
      const threadId = typeof body.id === 'string' && THREAD_ID_RE.test(body.id) ? body.id : null
      if (!threadId) throw new ConsoleError(400, 'invalid_thread', 'id must name the conversation')
      const pinnedPeerId = typeof body.peerId === 'string' && PEER_ID_RE.test(body.peerId) ? body.peerId.toLowerCase().replace(/^0x/, '') : null

      // The stored thread is the source of truth; only the client's newest message is taken from the request.
      const existing = deps.store.getChatThread(threadId)
      if (existing && !ownThread(caller.owner, threadId)) throw new ConsoleError(404, 'not_found', 'Conversation not found')
      const incoming = body.messages[body.messages.length - 1] as UIMessage
      if (!incoming || typeof incoming !== 'object' || incoming.role !== 'user' || !Array.isArray(incoming.parts)) {
        throw new ConsoleError(400, 'invalid_messages', 'The last message must be the user\'s')
      }
      const stored = (existing?.messages ?? []) as UIMessage[]
      // Re-sending a stored message (a retry) replaces everything after it.
      const at = stored.findIndex((message) => message.id === incoming.id)
      const messages: UIMessage[] = at >= 0 ? [...stored.slice(0, at), incoming] : [...stored, incoming]

      // A model (or pinned peer) that cannot call tools gets a plain chat: some sellers reject tool definitions.
      const known = modelsCache.get(caller.keyId)?.models.find((entry) => entry.id === model)
      const pinned = pinnedPeerId ? known?.peers.find((peer) => peer.peerId === pinnedPeerId) : undefined
      const canUseTools = known ? (pinned ? pinned.toolUse : known.toolUse) : true
      const tools = canUseTools
        ? chatTools({
          sandboxDir: join(deps.dataDir, 'gateway', 'chat', caller.dirName, threadId),
          allowShell: caller.admin,
          braveApiKey: options.braveApiKey ?? null,
        })
        : {}

      // The thread id is the conversation the buyer tracks (its seller affinity
      // and chat list): without it the buyer keys a conversation on its first
      // message, so two chats that open alike would share one route.
      const provider = createOpenAICompatible({
        name: 'antseed-gateway',
        baseURL: gatewayBase(),
        headers: { ...asKey(caller.keyId), [CHAT_SESSION_HEADER]: threadId },
        includeUsage: true,
      })
      const abort = new AbortController()
      request.res.once('close', () => { if (!request.res.writableFinished) abort.abort() })
      const result = streamText({
        model: provider.chatModel(pinnedPeerId ? `${pinnedPeerId}@${model}` : model),
        system: SYSTEM_PROMPT,
        messages: await convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true }),
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: abort.signal,
        onError: ({ error }) => deps.log(`gateway chat: ${model}: ${String(error instanceof Error ? error.message : error)}`),
      })

      const title = existing?.title ?? threadTitle(incoming)
      // Listed at once, while the answer streams; saved again, whole, when it finishes.
      try {
        deps.store.saveChatThread({ id: threadId, owner: caller.owner, title, model, peerId: pinnedPeerId, messages })
      } catch (error) {
        deps.log(`gateway chat: could not save conversation ${threadId}: ${String(error)}`)
      }

      const served: ChatMessageMetadata['peers'] = []
      const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
      let costUsd: number | null = 0
      const metadata = (): ChatMessageMetadata => ({ model, pinnedPeerId, peers: [...served], usage: { ...usage }, costUsd })
      result.pipeUIMessageStreamToResponse(request.res, {
        originalMessages: messages,
        generateMessageId: newMessageId,
        sendReasoning: true,
        messageMetadata: ({ part }): ChatMessageMetadata | undefined => {
          if (part.type === 'start' || part.type === 'finish') return metadata()
          if (part.type !== 'finish-step') return undefined
          const peerId = (part.response.headers?.['x-antseed-peer-id'] ?? '').toLowerCase()
          if (peerId && served[served.length - 1]?.peerId !== peerId) served.push({ peerId, name: peerNames.get(peerId) ?? null })
          const step = stepTokens(part.usage)
          usage.inputTokens += step.inputTokens
          usage.cachedInputTokens += step.cachedInputTokens
          usage.outputTokens += step.outputTokens
          const stepCost = estimateCost(step, known?.peers.find((peer) => peer.peerId === peerId))
          costUsd = costUsd === null || stepCost === null ? null : costUsd + stepCost
          return metadata()
        },
        onFinish: ({ messages: finished }) => {
          try {
            deps.store.saveChatThread({ id: threadId, owner: caller.owner, title, model, peerId: pinnedPeerId, messages: finished })
          } catch (error) {
            deps.log(`gateway chat: could not save conversation ${threadId}: ${String(error)}`)
          }
        },
        onError: (error) => (error instanceof Error ? error.message : String(error)),
      })
      return undefined
    }, allow)
  }
}

type StepTokens = NonNullable<ChatMessageMetadata['usage']>

/** One model call's tokens, from the AI SDK's usage (missing counts are 0). */
function stepTokens(usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } } | undefined): StepTokens {
  const count = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    inputTokens: count(usage?.inputTokens),
    cachedInputTokens: count(usage?.inputTokenDetails?.cacheReadTokens),
    outputTokens: count(usage?.outputTokens),
  }
}

/**
 * A call's cost at the serving peer's advertised prices (USD per million
 * tokens; cached input at the input price when none is advertised). Null when
 * the peer or its prices are unknown.
 */
export function estimateCost(tokens: StepTokens, peer: Pick<ChatModelPeer, 'inputUsdPerMillion' | 'outputUsdPerMillion' | 'cachedInputUsdPerMillion'> | undefined): number | null {
  if (tokens.inputTokens === 0 && tokens.outputTokens === 0) return 0
  if (!peer || peer.inputUsdPerMillion === null || peer.outputUsdPerMillion === null) return null
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens)
  const cachedPrice = peer.cachedInputUsdPerMillion ?? peer.inputUsdPerMillion
  return ((tokens.inputTokens - cached) * peer.inputUsdPerMillion + cached * cachedPrice + tokens.outputTokens * peer.outputUsdPerMillion) / 1_000_000
}

function threadDto(thread: ChatThreadSummary): ChatThread {
  return { id: thread.id, title: thread.title, model: thread.model, peerId: thread.peerId, createdAt: thread.createdAt, updatedAt: thread.updatedAt }
}

/** A conversation's title: its first message, on one line, shortened. */
export function threadTitle(message: UIMessage): string {
  const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return 'New conversation'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/** Text models from the gateway's `/v1/models`, the ones that can use tools first, each with its cheapest offer. */
export function mapChatModels(body: unknown): ChatModel[] {
  const rows = (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : []) as Array<Record<string, unknown>>
  const models: ChatModel[] = []
  for (const row of rows) {
    if (typeof row['id'] !== 'string' || (row['type'] !== undefined && row['type'] !== 'text')) continue
    const coverage = (row['capability_coverage'] ?? {}) as Record<string, unknown>
    const peers = Array.isArray(row['peers']) ? row['peers'] as Array<Record<string, unknown>> : []
    const price = (field: string) => {
      const values = peers.map((peer) => peer[field]).filter((value): value is number => typeof value === 'number' && value >= 0)
      return values.length ? Math.min(...values) : null
    }
    const offers: ChatModelPeer[] = peers
      .filter((peer) => typeof peer['peerId'] === 'string')
      .map((peer) => {
        const capabilities = (peer['capabilities'] ?? {}) as Record<string, unknown>
        const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
        const inputs = Array.isArray(capabilities['inputs']) ? capabilities['inputs'] : []
        const verifiers = Array.isArray(peer['advertisedVerifierIds']) ? peer['advertisedVerifierIds'] : []
        return {
          peerId: String(peer['peerId']).toLowerCase(),
          name: typeof peer['displayName'] === 'string' && peer['displayName'].trim() ? peer['displayName'].trim() : null,
          toolUse: capabilities['toolUse'] === true,
          reasoning: capabilities['reasoning'] === true,
          vision: inputs.includes('image'),
          tee: verifiers.includes(TEE_VERIFIER_ID),
          inputUsdPerMillion: number(peer['inputUsdPerMillion']),
          outputUsdPerMillion: number(peer['outputUsdPerMillion']),
          cachedInputUsdPerMillion: number(peer['cachedInputUsdPerMillion']),
          reputation: number(peer['effectiveReputationScore'] ?? peer['reputationScore']),
        }
      })
      .sort((a, b) => (b.reputation ?? -1) - (a.reputation ?? -1))
    models.push({
      id: row['id'],
      name: typeof row['name'] === 'string' ? row['name'] : row['id'],
      toolUse: Number(coverage['tool_use'] ?? 0) > 0,
      reasoning: Number(coverage['reasoning'] ?? 0) > 0 || offers.some((offer) => offer.reasoning),
      vision: offers.some((offer) => offer.vision),
      free: offers.some((offer) => offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0),
      tee: offers.some((offer) => offer.tee),
      offers: peers.length,
      inputUsdPerMillion: price('inputUsdPerMillion'),
      outputUsdPerMillion: price('outputUsdPerMillion'),
      peers: offers,
    })
  }
  return models.sort((a, b) => Number(b.toolUse) - Number(a.toolUse) || b.offers - a.offers || a.name.localeCompare(b.name))
}
