import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRoutingSelection, type RoutingSelection, type RoutingServiceTarget } from '@antseed/node'
import { isCursorEnvironmentSnippet, sanitizeStoredSnippet } from './conversation-identity.js'

/**
 * File-backed store for tool conversations seen by the buyer proxy.
 *
 * Each record maps one tool chat session (identified on the wire — see
 * conversation-identity.ts) to a display label and an optional per-chat
 * routed-model affinity. Persists as `conversations.json` in the buyer data dir,
 * written atomically (tmp + rename) with writes serialized behind a queue,
 * mirroring how buyer.state.json is handled. No database involved.
 */

export type ConversationRouterSelection = Extract<RoutingSelection, { kind: 'router' }> & { service: RoutingServiceTarget }

export type StoredConversation = {
  routingSelection: ConversationRouterSelection | null
  /** `${tool}:${sessionKey}` — unique per tool chat. */
  id: string
  tool: string
  sessionKey: string
  /** First genuine user prompt, captured when the conversation is first seen. */
  snippet: string
  /** User-assigned name; overrides the snippet for display when set. */
  label: string | null
  /** Per-chat route as `<peerId>@<service>`. Automatic routes are soft
      affinity; user-selected routes are hard pins. Null only until the
      chat's first resolved request. */
  pinnedModel: string | null
  /** How the route's peer was chosen. 'auto' means routing picked it (first
      request affinity, or the desktop re-pointing chats when a seller is
      pinned for the model); 'user' means the user chose this seller for this
      specific chat, which nothing overrides until they clear it. */
  peerSource: 'auto' | 'user'
  /** Model that served the most recent request (`<peerId>@<service>`), for display. */
  lastModel: string | null
  /** USDC base units authorized for this chat's requests (bigint as string).
      Subagent traffic rolls up into the parent chat, same as everything else
      here. This is what the chat has cost, not what has settled on-chain. */
  spentUsdc: string
  /** Cumulative tokens across this chat's requests (bigint as string).
      `cachedInputTokens` is the cached SUBSET of `inputTokens`, not a separate
      bucket — fresh input is `inputTokens - cachedInputTokens`. */
  inputTokens: string
  cachedInputTokens: string
  outputTokens: string
  /** Requests whose spend was attributed to this chat. */
  requestCount: number
  createdAt: number
  lastActiveAt: number
}

export const CONVERSATIONS_FILE = 'conversations.json'
/** LRU cap — oldest by lastActiveAt beyond this are pruned. */
const MAX_CONVERSATIONS = 50
/** Conversations idle longer than this are pruned. */
const MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_LABEL_CHARS = 120
const LEGACY_DROID_TITLE_MAX_INPUT_TOKENS = 1_500n
const LEGACY_DROID_CHAT_MIN_INPUT_TOKENS = 5_000n

export function conversationId(tool: string, sessionKey: string): string {
  return `${tool}:${sessionKey}`
}

/** Reads a persisted bigint-as-string counter, healing anything unparseable to '0'. */
function sanitizeCounter(value: unknown): string {
  if (typeof value !== 'string') return '0'
  try {
    const parsed = BigInt(value)
    return parsed > 0n ? parsed.toString() : '0'
  } catch {
    return '0'
  }
}

function sanitizeRecord(value: unknown): StoredConversation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const tool = typeof record.tool === 'string' ? record.tool : ''
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey : ''
  if (!tool || !sessionKey) return null
  const rawSnippet = typeof record.snippet === 'string' ? record.snippet : ''
  const normalizedTool = tool === 'public-tunnel' && isCursorEnvironmentSnippet(rawSnippet) ? 'cursor' : tool
  return {
    id: conversationId(normalizedTool, sessionKey),
    tool: normalizedTool,
    sessionKey,
    // Persisted snippets are re-cleaned so rows written by older extraction
    // rules (raw XML wrappers, title-request text) heal on reload.
    snippet: sanitizeStoredSnippet(rawSnippet),
    label: typeof record.label === 'string' && record.label.length > 0 ? record.label : null,
    pinnedModel: typeof record.pinnedModel === 'string' && record.pinnedModel.length > 0 ? record.pinnedModel : null,
    peerSource: record.peerSource === 'user' ? 'user' : 'auto',
    routingSelection: record.peerSource !== 'user' && isRoutingSelection(record.routingSelection)
      && record.routingSelection.kind === 'router' && record.routingSelection.service
      ? structuredClone(record.routingSelection) as ConversationRouterSelection : null,
    lastModel: typeof record.lastModel === 'string' && record.lastModel.length > 0 ? record.lastModel : null,
    spentUsdc: sanitizeCounter(record.spentUsdc),
    inputTokens: sanitizeCounter(record.inputTokens),
    cachedInputTokens: sanitizeCounter(record.cachedInputTokens),
    outputTokens: sanitizeCounter(record.outputTokens),
    requestCount: typeof record.requestCount === 'number' && record.requestCount > 0 ? record.requestCount : 0,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    lastActiveAt: typeof record.lastActiveAt === 'number' ? record.lastActiveAt : Date.now(),
  }
}

/** Droid used to send its title helper under a separate synthetic session,
    leaving two persisted rows with the same snippet. Its body-derived helper
    key is reused across launches, so the two records may have distant creation
    times even though both are reactivated together.
    New requests are filtered before storage; this only heals those legacy
    pairs, using the captured helper/full-prompt average token sizes to avoid merging
    genuine chats that happen to start with the same text. */
function removeLegacyDroidTitleDuplicates(records: StoredConversation[]): StoredConversation[] {
  const duplicateIds = new Set<string>()
  for (const candidate of records) {
    if (candidate.tool !== 'droid' || !candidate.snippet || candidate.label) continue
    const candidateRequests = BigInt(Math.max(candidate.requestCount, 1))
    if (BigInt(candidate.inputTokens) > LEGACY_DROID_TITLE_MAX_INPUT_TOKENS * candidateRequests) continue
    const matchingChat = records.some((record) => (
      record.id !== candidate.id
      && record.tool === 'droid'
      && record.snippet === candidate.snippet
      && BigInt(record.inputTokens) >= LEGACY_DROID_CHAT_MIN_INPUT_TOKENS * BigInt(Math.max(record.requestCount, 1))
    ))
    if (matchingChat) duplicateIds.add(candidate.id)
  }
  return duplicateIds.size === 0 ? records : records.filter((record) => !duplicateIds.has(record.id))
}

export class ConversationStore {
  private readonly _dir: string
  private readonly _file: string
  private readonly _byId = new Map<string, StoredConversation>()
  private _writeQueue: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this._dir = dataDir
    this._file = join(dataDir, CONVERSATIONS_FILE)
    this._loadSync()
  }

  private _loadSync(): void {
    let raw: string
    try {
      raw = readFileSync(this._file, 'utf8')
    } catch {
      return // first run — no file yet
    }
    try {
      const parsed = JSON.parse(raw) as { conversations?: unknown[] }
      const records = removeLegacyDroidTitleDuplicates((parsed.conversations ?? [])
        .map(sanitizeRecord)
        .filter((record): record is StoredConversation => record !== null)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt)) // map order tracks recency
      for (const record of records) {
        this._byId.set(record.id, record)
      }
    } catch { /* corrupted file — start clean, next write repairs it */ }
    this._prune()
  }

  /* The map's insertion order tracks recency (touch() re-inserts), so ties
     on lastActiveAt — e.g. many chats touched in the same millisecond —
     still evict oldest-first. */
  private _prune(): void {
    const cutoff = Date.now() - MAX_IDLE_MS
    for (const [id, record] of this._byId) {
      if (record.lastActiveAt < cutoff) this._byId.delete(id)
    }
    while (this._byId.size > MAX_CONVERSATIONS) {
      const oldest = this._byId.keys().next().value
      if (oldest === undefined) break
      this._byId.delete(oldest)
    }
  }

  /** Serialized atomic write; returns the queued write promise. */
  private _persist(): Promise<void> {
    this._writeQueue = this._writeQueue.then(async () => {
      const payload = JSON.stringify({ conversations: [...this._byId.values()] }, null, 2)
      await mkdir(this._dir, { recursive: true })
      const tmp = `${this._file}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this._file)
    }).catch(() => { /* keep the queue alive after a failed write */ })
    return this._writeQueue
  }

  /** Wait for pending writes (tests / shutdown). */
  flush(): Promise<void> {
    return this._writeQueue
  }

  /**
   * Record activity for a conversation, creating it on first sight. The
   * snippet only sticks at creation — later turns keep the original label.
   *
   * The first model that actually serves the chat becomes its pin: the
   * session default only steers chats that haven't resolved a request yet,
   * so changing the default never re-routes an existing conversation.
   */
  touch(input: { tool: string; sessionKey: string; snippet?: string | null; lastModel?: string | null }): StoredConversation {
    const id = conversationId(input.tool, input.sessionKey)
    const existing = this._byId.get(id)
    const now = Date.now()
    let record: StoredConversation
    if (existing) {
      record = {
        ...existing,
        lastActiveAt: now,
        lastModel: input.lastModel ?? existing.lastModel,
        pinnedModel: existing.pinnedModel ?? input.lastModel ?? null,
        snippet: existing.snippet || (input.snippet ?? ''),
      }
    } else {
      record = {
        id,
        tool: input.tool,
        sessionKey: input.sessionKey,
        snippet: input.snippet ?? '',
        label: null,
        pinnedModel: input.lastModel ?? null,
        peerSource: 'auto',
        routingSelection: null,
        lastModel: input.lastModel ?? null,
        spentUsdc: '0',
        inputTokens: '0',
        cachedInputTokens: '0',
        outputTokens: '0',
        requestCount: 0,
        createdAt: now,
        lastActiveAt: now,
      }
    }
    this._byId.delete(id) // re-insert so map order tracks recency
    this._byId.set(id, record)
    this._prune()
    void this._persist()
    return record
  }

  /**
   * Add one signed spend delta to a conversation. No-ops for unknown ids —
   * a chat pruned mid-request should not resurrect as a spend-only row.
   *
   * A single request can produce several deltas (the buyer- and seller-driven
   * auth paths both advance the cumulative), so `countRequest` is the caller's
   * to decide: it knows which delta was the first for a given request id.
   *
   * Not persisted immediately: touch() already rewrites the file on every
   * turn, so the counters ride along with the next write. At most the last
   * request's cost is lost on a hard kill.
   */
  addSpend(
    id: string,
    delta: { amountUsdc: string; inputTokens: string; cachedInputTokens: string; outputTokens: string },
    countRequest = true,
  ): void {
    const existing = this._byId.get(id)
    if (!existing) return
    let amount: bigint
    let input: bigint
    let cachedInput: bigint
    let output: bigint
    try {
      amount = BigInt(delta.amountUsdc || '0')
      input = BigInt(delta.inputTokens || '0')
      cachedInput = BigInt(delta.cachedInputTokens || '0')
      output = BigInt(delta.outputTokens || '0')
    } catch {
      return
    }
    // Cached input is a subset of input, so a delta reporting only cached
    // tokens is malformed — clamp rather than let the subset exceed the whole.
    if (cachedInput > input) cachedInput = input
    if (amount <= 0n && input <= 0n && output <= 0n) return
    this._byId.set(id, {
      ...existing,
      spentUsdc: (BigInt(existing.spentUsdc) + (amount > 0n ? amount : 0n)).toString(),
      inputTokens: (BigInt(existing.inputTokens) + (input > 0n ? input : 0n)).toString(),
      cachedInputTokens: (BigInt(existing.cachedInputTokens) + (cachedInput > 0n ? cachedInput : 0n)).toString(),
      outputTokens: (BigInt(existing.outputTokens) + (output > 0n ? output : 0n)).toString(),
      requestCount: existing.requestCount + (countRequest ? 1 : 0),
    })
  }

  /** Newest-activity first (stable sort over reversed insertion order keeps
      same-millisecond ties in true recency order). */
  list(): StoredConversation[] {
    return [...this._byId.values()].reverse().sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  get(id: string): StoredConversation | null {
    return this._byId.get(id) ?? null
  }

  getPinnedModel(tool: string, sessionKey: string): string | null {
    return this._byId.get(conversationId(tool, sessionKey))?.pinnedModel ?? null
  }

  recordRoutedModel(id: string, routedModel: string): StoredConversation | null {
    const existing = this._byId.get(id)
    if (!existing) return null
    const record = {
      ...existing,
      pinnedModel: existing.peerSource === 'user' && existing.pinnedModel
        ? existing.pinnedModel
        : routedModel,
      lastModel: routedModel,
      lastActiveAt: Date.now(),
    }
    this._byId.set(id, record)
    void this._persist()
    return record
  }

  setLabel(id: string, label: string | null): StoredConversation | null {
    const existing = this._byId.get(id)
    if (!existing) return null
    const clean = label?.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS) || null
    const record = { ...existing, label: clean }
    this._byId.set(id, record)
    void this._persist()
    return record
  }

  setPinnedModel(id: string, pinnedModel: string | null, peerSource: 'auto' | 'user' = 'auto'): StoredConversation | null {
    const existing = this._byId.get(id)
    if (!existing) return null
    // A cleared pin has no peer to attribute, so the source resets with it.
    const record = {
      ...existing,
      pinnedModel: pinnedModel || null,
      peerSource: pinnedModel ? peerSource : 'auto' as const,
      routingSelection: pinnedModel && peerSource === 'user' ? null : existing.routingSelection,
    }
    this._byId.set(id, record)
    void this._persist()
    return record
  }

  setRoutingSelection(id: string, selection: ConversationRouterSelection | null): StoredConversation | null {
    if (selection !== null && (!isRoutingSelection(selection) || selection.kind !== 'router' || !selection.service)) {
      throw new Error('Conversation routing requires a router and an exact routing-service target')
    }
    const existing = this._byId.get(id)
    if (!existing) return null
    const record: StoredConversation = {
      ...existing, routingSelection: structuredClone(selection), pinnedModel: null, peerSource: 'auto',
    }
    this._byId.set(id, record)
    void this._persist()
    return record
  }

  remove(id: string): boolean {
    const removed = this._byId.delete(id)
    if (removed) void this._persist()
    return removed
  }
}
