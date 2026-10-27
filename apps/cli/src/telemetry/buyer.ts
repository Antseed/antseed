/**
 * Buyer telemetry: `buyer_started`, `buyer_deposit_credited` when a deposit
 * lands, and one `buyer_request_finished` per proxied model request, the same whichever host runs the buyer (the
 * desktop, the gateway or `antseed buyer start` alone). This is where all
 * usage and reliability data comes from; hosts report only their own UI.
 * Only enums, buckets and counts leave the process, plus (approved, so cache
 * and failure rates can be measured per seller) the public peer id of the
 * seller that handled the request and the exact input and cached token counts
 * the seller reported.
 *
 * The proxy tracks each request through a `RequestTrace`, found by its
 * `ServerResponse`, so the dispatch code needs no extra parameters.
 */
import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { modelMetadataFor } from '@antseed/node/model-metadata'
import {
  PUBLIC_MODEL_ID_PATTERN,
  TELEMETRY_HOST_ENV,
  TELEMETRY_HOST_SESSION_ID_ENV,
  attemptCountBucket,
  classifyFailureReason,
  createTelemetryClient,
  failureHttpStatus,
  normalizeBuyerHost,
  requestDurationBucket,
  sellersTriedBucket,
  smallCountBucket,
  ttftBucket,
  usdcAmountBucket,
  type BuyerHost,
  type FailureReason,
  type PostHogSender,
  type TelemetryClient,
} from '@antseed/telemetry'
import { CLI_EVENT_CATALOG, CLIENT_TOOLS, CONNECTED_APP_TOOLS, REQUEST_PROTOCOLS, SELLER_ID_PATTERN } from './catalog.js'
import { posthogConfig, resolveCliConsent } from './settings.js'
import { detectInstallMethod } from '../update/install-method.js'
import pkg from '../../package.json' with { type: 'json' }

export type RouteMode = 'auto' | 'pinned' | 'router'
export type SellerTier = 'free' | 'paid' | 'unknown'
export type RequestOutcome = 'success' | 'failed' | 'cancelled'
/** How the proxy could tell which conversation a request belongs to. */
export type ConversationKeySource = 'tool_session' | 'prompt_cache_key' | 'prompt_prefix' | 'none'
/** Whether the request stayed on its conversation's previous seller. */
export type SellerChoice = 'first_turn' | 'kept_previous' | 'switched' | 'no_conversation' | 'no_answer'
/**
 * Why a conversation's previous seller did not answer this turn. The proxy
 * sets it while routing; `previous_failed` (it was tried and failed) is found
 * when the request finishes.
 */
export type SwitchReason =
  | 'previous_failed'
  | 'previous_cooling_down'
  | 'previous_unhealthy'
  | 'previous_unavailable'
  | 'previous_excluded'
  | 'needs_funds'
  | 'policy_route'
  | 'pinned_elsewhere'
  | 'router_choice'
  | 'other'
/** Why the answer ended, from the response's own finish or stop reason. */
export type FinishReason = 'stop' | 'length' | 'tool_call' | 'content_filter' | 'refusal' | 'other' | 'unknown'

/** Raw failure text read for classification; never sent. */
const MAX_FAILURE_TEXT = 2_048

export function publicModelId(serviceId: string | null): string {
  if (!serviceId) return 'custom_or_unknown'
  const normalized = serviceId.trim().toLowerCase()
  return modelMetadataFor(serviceId) !== null && PUBLIC_MODEL_ID_PATTERN.test(normalized)
    ? normalized
    : 'custom_or_unknown'
}

export function telemetryProtocol(protocol: string | null, isVideo: boolean): string {
  if (isVideo) return 'video'
  return protocol && REQUEST_PROTOCOLS.has(protocol) ? protocol : 'unknown'
}

/** Tool slugs carry client variants, e.g. Codex reports `codex-exec` (the same rule as the proxy's model-picker check). */
function toolMatchesApp(tool: string, app: string): boolean {
  return tool === app || tool.startsWith(`${app}-`)
}

/**
 * The client tool as reported: a connected app's name when the request's tool
 * slug is one of that app's slugs or a variant of one (`codex-exec`,
 * `codex-desktop` → `codex`; `hermes-agent` → `hermes`), so requests join the
 * desktop's `app_connect` for the same app. Other recognized tools keep their
 * slug; anything else is `custom`.
 */
export function telemetryClientTool(tool: string | null | undefined): string {
  if (!tool) return 'none'
  const normalized = tool.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (!normalized) return 'none'
  for (const app of CONNECTED_APP_TOOLS) {
    if (app.slugs.some((slug) => toolMatchesApp(normalized, slug.toLowerCase()))) return app.name
  }
  // Claude Code's user agent names it `claude-cli`.
  if (toolMatchesApp(normalized, 'claude-cli')) return 'claude-code'
  return CLIENT_TOOLS.has(normalized) ? normalized : 'custom'
}

/** What one proxied request did, filled in as it is routed. */
export class RequestTrace {
  protocol = 'unknown'
  model: string | null = null
  routeMode: RouteMode = 'auto'
  clientTool = 'none'
  attempts = 0
  readonly sellers = new Set<string>()
  sellerTier: SellerTier = 'unknown'
  firstByteAtMs: number | null = null
  streamed = false
  interrupted: 'seller' | 'buyer' | 'cancelled' | null = null
  failureText = ''
  failureKind: 'http_error' | 'network_error' | 'timeout' = 'http_error'
  freeSellersKnown = 0
  /** The seller of the final attempt: the one that answered, or the last to fail. */
  lastSeller: string | null = null
  conversationKeySource: ConversationKeySource = 'none'
  /** In-memory only, never sent: the key that groups this conversation's requests. */
  conversationKey: string | null = null
  /** 1-based turn in this conversation, or null when it began before the buyer started. */
  turn: number | null = null
  previousSeller: string | null = null
  /** Set while routing when the previous seller was passed over before any attempt. */
  previousSkipped: SwitchReason | null = null
  /** Eligible sellers for the model, and the 1-based rank of the one tried last. */
  candidates: number | null = null
  rank: number | null = null
  /** Usage of the final attempt's response. */
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reported: boolean } | null = null
  finishReason: FinishReason | null = null
  /** The client sent this same request again after its last copy did not succeed. */
  clientRetry = false
  /** In-memory only, never sent: the fingerprint `RetryMemory` matches repeats by. */
  requestFingerprint: string | null = null
  /** The seller's listed price for the final answer, in millionths of a USD; null when unknown. */
  estimatedCostMicroUsd: number | null = null
  private finished = false

  constructor(readonly startedAtMs: number, readonly peersKnownAtSend: boolean) {}

  noteAttempt(peerId: string): void {
    this.attempts += 1
    this.lastSeller = peerId.toLowerCase()
    this.sellers.add(this.lastSeller)
    // A later attempt answers for itself.
    this.usage = null
    this.finishReason = null
    this.estimatedCostMicroUsd = null
  }

  noteUsage(usage: { inputTokens: number; cachedInputTokens: number; outputTokens?: number; source: 'usage' | 'estimated' }): void {
    this.usage = {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens ?? 0,
      reported: usage.source === 'usage',
    }
  }

  /** Why the answer ended, and its cost at the seller's listed price (null when the price is unknown). */
  noteAnswerDetails(details: { finishReason: FinishReason; estimatedCostUsd: number | null }): void {
    this.finishReason = details.finishReason
    this.estimatedCostMicroUsd = details.estimatedCostUsd !== null && Number.isFinite(details.estimatedCostUsd) && details.estimatedCostUsd >= 0
      ? Math.round(details.estimatedCostUsd * 1_000_000)
      : null
  }

  /** Why this turn's seller differs from the previous one; null when it does not. */
  private _sellerChoice(outcome: RequestOutcome): { choice: SellerChoice; reason: SwitchReason | null } {
    if (this.conversationKey === null) return { choice: 'no_conversation', reason: null }
    if (outcome !== 'success' || this.lastSeller === null) return { choice: 'no_answer', reason: null }
    if (this.previousSeller === null) return { choice: 'first_turn', reason: null }
    if (this.previousSeller === this.lastSeller) return { choice: 'kept_previous', reason: null }
    const reason = this.sellers.has(this.previousSeller) ? 'previous_failed' : this.previousSkipped ?? 'other'
    return { choice: 'switched', reason }
  }

  noteFirstByte(atMs: number): void {
    if (this.firstByteAtMs === null) this.firstByteAtMs = atMs
    this.streamed = true
  }

  /** A whole (non-streamed) answer arrived. */
  noteAnswered(atMs: number): void {
    if (this.firstByteAtMs === null) this.firstByteAtMs = atMs
  }

  noteFailure(failure: { statusCode: number; responseBody: Buffer; errorMessage: string | null; timedOut?: boolean }): void {
    const text = failure.errorMessage ?? failure.responseBody.subarray(0, MAX_FAILURE_TEXT).toString('utf8')
    this.failureText = `${failure.statusCode} ${text}`.slice(0, MAX_FAILURE_TEXT)
    this.failureKind = failure.timedOut ? 'timeout' : failure.errorMessage !== null ? 'network_error' : 'http_error'
  }

  /** Once per request; later calls return null. */
  finish(statusCode: number, clientAborted: boolean, nowMs: number): Record<string, unknown> | null {
    if (this.finished) return null
    this.finished = true
    const cancelled = this.interrupted === 'cancelled' || statusCode === 499 || (clientAborted && this.interrupted === null && statusCode < 400 && this.firstByteAtMs === null)
    const failed = !cancelled && (statusCode >= 400 || this.interrupted !== null)
    const outcome: RequestOutcome = cancelled ? 'cancelled' : failed ? 'failed' : 'success'
    let failureReason: FailureReason = 'none'
    let httpStatus: number | undefined
    if (outcome === 'failed') {
      if (this.interrupted !== null && statusCode < 400) {
        failureReason = this.interrupted === 'buyer' ? 'local_error' : 'seller_dropped_mid_answer'
      } else {
        const signal = { kind: this.failureKind, statusCode }
        failureReason = classifyFailureReason(signal, this.failureText, {
          hadPartialOutput: this.firstByteAtMs !== null,
          peersDiscoveredAtSend: this.peersKnownAtSend,
          freeSellersKnown: this.freeSellersKnown,
        })
        httpStatus = failureHttpStatus(signal, this.failureText)
      }
    }
    const { choice, reason } = this._sellerChoice(outcome)
    const usage = outcome === 'success' ? this.usage : null
    const ttftMs = this.firstByteAtMs === null ? null : Math.max(0, this.firstByteAtMs - this.startedAtMs)
    const durationMs = Math.max(0, nowMs - this.startedAtMs)
    return {
      protocol: this.protocol,
      public_model_id: publicModelId(this.model),
      route_mode: this.routeMode,
      client_tool: this.clientTool,
      outcome,
      failure_reason: failureReason,
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
      attempt_count: attemptCountBucket(Math.max(1, this.attempts)),
      sellers_tried: sellersTriedBucket(this.sellers.size),
      fell_back: this.sellers.size > 1,
      seller_tier: this.sellerTier,
      ttft_bucket: ttftBucket(ttftMs),
      duration_bucket: requestDurationBucket(durationMs),
      ...(ttftMs !== null ? { ttft_ms: Math.round(ttftMs) } : {}),
      duration_ms: Math.round(durationMs),
      streamed: this.streamed,
      client_retry: this.clientRetry,
      ...(this.lastSeller && SELLER_ID_PATTERN.test(this.lastSeller) ? { seller_id: this.lastSeller } : {}),
      conversation_key_source: this.conversationKeySource,
      ...(this.conversationKey !== null ? { turn_bucket: this.turn === null ? 'unknown' : turnBucket(this.turn) } : {}),
      seller_choice: choice,
      ...(reason ? { switch_reason: reason } : {}),
      ...(this.candidates !== null ? { candidates_bucket: smallCountBucket(this.candidates) } : {}),
      ...(this.rank !== null ? { chosen_rank: this.rank >= 3 ? '3_plus' : String(this.rank) } : {}),
      ...(usage ? { usage_reported: usage.reported } : {}),
      // Exact counts, only as the seller reported them: an estimate from the
      // body size cannot see the cache, so it is not sent as if it were real.
      ...(usage?.reported
        ? {
            input_tokens: usage.inputTokens,
            cached_input_tokens: Math.min(usage.cachedInputTokens, usage.inputTokens),
            output_tokens: usage.outputTokens,
            ...(this.estimatedCostMicroUsd !== null ? { estimated_cost_micro_usd: this.estimatedCostMicroUsd } : {}),
          }
        : {}),
      ...(outcome === 'success' && this.finishReason ? { finish_reason: this.finishReason } : {}),
    }
  }
}

function turnBucket(turn: number): string {
  if (turn <= 1) return '1'
  if (turn <= 5) return '2_5'
  if (turn <= 20) return '6_20'
  return '21_plus'
}

/**
 * Each conversation's turn count and last answering seller, so a request can
 * say whether it kept its seller. In memory only and bounded: nothing here is
 * sent or written to disk, and a restart starts it over.
 */
export class ConversationMemory {
  /** `turns` is null when the conversation began before this buyer started. */
  private readonly _entries = new Map<string, { turns: number | null; seller: string | null }>()

  constructor(private readonly _max = 5_000) {}

  /**
   * Counts a new turn and returns the seller that answered the last one.
   * `storedSeller` (from the saved conversation list) stands in after a restart.
   */
  nextTurn(key: string, storedSeller: string | null): { turn: number | null; previousSeller: string | null } {
    let entry = this._entries.get(key)
    if (entry) {
      this._entries.delete(key)
      if (entry.turns !== null) entry.turns += 1
    } else {
      if (this._entries.size >= this._max) this._entries.delete(this._entries.keys().next().value!)
      entry = { turns: storedSeller ? null : 1, seller: storedSeller }
    }
    this._entries.set(key, entry)
    return { turn: entry.turns, previousSeller: entry.seller }
  }

  /** The current turn again (a client retry), counting nothing new. */
  sameTurn(key: string, storedSeller: string | null): { turn: number | null; previousSeller: string | null } {
    const entry = this._entries.get(key)
    if (!entry) return this.nextTurn(key, storedSeller)
    return { turn: entry.turns, previousSeller: entry.seller }
  }

  answered(key: string, seller: string): void {
    const entry = this._entries.get(key)
    if (entry) entry.seller = seller
  }
}

/**
 * Recent requests by fingerprint, so a client's retry of a request that did
 * not succeed (Codex, for example, retries up to five times) is marked as a
 * retry instead of looking like a new request. In memory only and bounded;
 * the fingerprint is a hash of the request and never leaves the process.
 */
export class RetryMemory {
  private readonly _entries = new Map<string, { atMs: number; succeeded: boolean }>()

  constructor(private readonly _windowMs = 2 * 60_000, private readonly _max = 2_000) {}

  /** Whether this request repeats one that did not succeed within the window; records it either way. */
  seen(fingerprint: string, nowMs: number): boolean {
    const previous = this._entries.get(fingerprint)
    const retry = previous !== undefined && !previous.succeeded && nowMs - previous.atMs <= this._windowMs
    this._entries.delete(fingerprint)
    if (this._entries.size >= this._max) this._entries.delete(this._entries.keys().next().value!)
    this._entries.set(fingerprint, { atMs: nowMs, succeeded: false })
    return retry
  }

  finished(fingerprint: string, succeeded: boolean, nowMs: number): void {
    const entry = this._entries.get(fingerprint)
    if (entry) {
      entry.succeeded = succeeded
      entry.atMs = nowMs
    }
  }
}

/** JSON with every object's keys sorted, so the same content always gives the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const traces = new WeakMap<ServerResponse, RequestTrace>()

export function traceFor(res: ServerResponse): RequestTrace | undefined {
  return traces.get(res)
}

export type BuyerTelemetryOptions = {
  configPath: string | null
  getDistinctId: () => string | null
  env?: NodeJS.ProcessEnv
  /** Test seam. */
  sender?: PostHogSender
  /** Test seam: forces consent on. */
  forceEnabled?: boolean
  nowMs?: () => number
}

/** The buyer's telemetry. Every method is safe to call when telemetry is off. */
export class BuyerTelemetry {
  readonly buyerHost: BuyerHost
  private readonly _client: TelemetryClient
  private readonly _env: NodeJS.ProcessEnv
  private readonly _now: () => number
  private readonly _conversations = new ConversationMemory()
  private readonly _retries = new RetryMemory()
  private _enabled: boolean
  /** Per wallet: the amount of a credited deposit whose tx hash has not arrived yet. */
  private readonly _awaitingTxHash = new Map<string, string | undefined>()

  constructor(private readonly _options: BuyerTelemetryOptions) {
    this._env = _options.env ?? process.env
    this._now = _options.nowMs ?? (() => Date.now())
    this.buyerHost = normalizeBuyerHost(this._env[TELEMETRY_HOST_ENV])
    this._enabled = this._resolveEnabled()
    const posthog = posthogConfig(this._env)
    this._client = createTelemetryClient({
      product: 'buyer',
      appVersion: pkg.version,
      installSource: this.buyerHost === 'desktop' ? 'desktop' : detectInstallMethod({ env: this._env }).kind,
      catalog: CLI_EVENT_CATALOG,
      getDistinctId: _options.getDistinctId,
      isEnabled: () => this._enabled,
      ...(_options.sender ? { sender: _options.sender } : { posthog }),
      buyerHost: this.buyerHost,
      hostSessionId: this._env[TELEMETRY_HOST_SESSION_ID_ENV] ?? null,
      nowMs: this._now,
    })
  }

  get enabled(): boolean {
    return this._enabled
  }

  private _resolveEnabled(): boolean {
    if (this._options.forceEnabled) return true
    return this._options.configPath
      ? resolveCliConsent(this._options.configPath, this._env).enabled
      : false
  }

  /** Re-reads `telemetry.enabled` (the proxy calls this when its config file changes). */
  reloadConsent(): void {
    const before = this._enabled
    this._enabled = this._resolveEnabled()
    if (before && !this._enabled) void this._client.flush()
  }

  started(props: { paymentsEnabled: boolean; verifierEnabled: boolean; ownsProxyPort: boolean }): void {
    this._client.capture('buyer_started', {
      payments_enabled: props.paymentsEnabled,
      verifier_enabled: props.verifierEnabled,
      owns_proxy_port: props.ownsProxyPort,
    })
  }

  /**
   * A deposit was credited to one of this buyer's wallets (workspace wallets
   * too: for a gateway this is "money added"), sent as a coarse amount bucket.
   * A deposit credited before its tx hash was known is reported again when
   * the hash arrives (same amount, now with the hash); that repeat is skipped.
   */
  depositCredited(wallet: string, event: { amountBaseUnits?: string; txHash?: string }): void {
    try {
      const key = wallet.toLowerCase()
      if (event.txHash) {
        const backfill = this._awaitingTxHash.has(key) && this._awaitingTxHash.get(key) === event.amountBaseUnits
        this._awaitingTxHash.delete(key)
        if (backfill) return
      } else {
        this._awaitingTxHash.set(key, event.amountBaseUnits)
      }
      if (!event.amountBaseUnits || !/^\d+$/.test(event.amountBaseUnits)) return
      this._client.capture('buyer_deposit_credited', { amount_bucket: usdcAmountBucket(BigInt(event.amountBaseUnits)) })
    } catch {
      // Telemetry never affects deposits.
    }
  }

  /** Starts tracing a model request; reports it once the response closes. */
  beginRequest(res: ServerResponse, peersKnown: boolean): RequestTrace | null {
    if (!this._enabled) return null
    const trace = new RequestTrace(this._now(), peersKnown)
    traces.set(res, trace)
    let clientAborted = false
    res.once('close', () => {
      // Telemetry never throws into the proxy, whatever the trace holds.
      try {
        if (!res.writableFinished) clientAborted = true
        const props = trace.finish(res.statusCode, clientAborted, this._now())
        if (!props) return
        if (props['outcome'] === 'success' && trace.conversationKey && trace.lastSeller) {
          this._conversations.answered(trace.conversationKey, trace.lastSeller)
        }
        if (trace.requestFingerprint) this._retries.finished(trace.requestFingerprint, props['outcome'] === 'success', this._now())
        this._record(props)
      } catch {
        // Dropped: this request goes unreported.
      }
    })
    return trace
  }

  /**
   * Marks a request the client is sending again after its last copy did not
   * succeed. Call before `noteConversation`, so a retry is not counted as a new turn.
   * A parsed JSON body is compared by content with its keys sorted, because
   * clients do not keep key order: Codex resends a turn with the same content
   * but its `client_metadata` keys reordered. Other bodies compare byte for byte.
   */
  noteRequestBody(trace: RequestTrace, method: string, path: string, body: Uint8Array, parsedBody?: Record<string, unknown> | null): void {
    try {
      const content = parsedBody ? canonicalJson(parsedBody) : body
      const fingerprint = createHash('sha256').update(method).update('\0').update(path).update('\0').update(content).digest('base64url')
      trace.requestFingerprint = fingerprint
      trace.clientRetry = this._retries.seen(fingerprint, this._now())
    } catch {
      // Unmarked: counted as a new request.
    }
  }

  /**
   * Links a request to its conversation: how it was grouped, which turn it is
   * and the seller that answered the turn before. The key never leaves the process.
   */
  noteConversation(trace: RequestTrace, key: { value: string; source: ConversationKeySource } | null, storedSeller: string | null): void {
    if (!key) return
    trace.conversationKey = key.value
    trace.conversationKeySource = key.source
    if (trace.clientRetry) {
      // The same turn again: keep its turn number and the seller before it.
      const { turn, previousSeller } = this._conversations.sameTurn(key.value, storedSeller)
      trace.turn = turn
      trace.previousSeller = previousSeller
      return
    }
    const { turn, previousSeller } = this._conversations.nextTurn(key.value, storedSeller)
    trace.turn = turn
    trace.previousSeller = previousSeller
  }

  private _record(props: Record<string, unknown>): void {
    if (!this._enabled) return
    this._client.capture('buyer_request_finished', props)
  }

  async close(timeoutMs = 750): Promise<void> {
    await this._client.close(timeoutMs)
  }
}
