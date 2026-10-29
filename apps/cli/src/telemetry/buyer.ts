/**
 * Buyer telemetry: `buyer_started`, `buyer_deposit_credited` when a deposit
 * lands, and one `buyer_request_finished` per proxied model request, the same whichever host runs the buyer (the
 * desktop, the gateway or `antseed buyer start` alone). This is where all
 * usage and reliability data comes from; hosts report only their own UI.
 * Each seller the request was sent to also gets one `buyer_seller_attempt`
 * with that attempt's result, so failure rates can be measured per seller.
 * Only enums, buckets and counts leave the process, plus the public peer ids
 * of the sellers tried, the exact token counts the seller reported, exact
 * timings and a listed-price cost estimate.
 *
 * The proxy tracks each request through a `RequestTrace`, found by its
 * `ServerResponse`, so the dispatch code needs no extra parameters.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { registeredModelIdFor } from '@antseed/node/model-metadata'
import {
  PUBLIC_MODEL_ID_PATTERN,
  TELEMETRY_HOST_ENV,
  TELEMETRY_HOST_SESSION_ID_ENV,
  attemptCountBucket,
  classifyFailureReason,
  createTelemetryClient,
  failureHttpStatus,
  normalizeBuyerHost,
  sellersTriedBucket,
  smallCountBucket,
  usdcAmountBucket,
  type BuyerHost,
  type FailureReason,
  type PostHogSender,
  type TelemetryClient,
} from '@antseed/telemetry'
import { CLI_EVENT_CATALOG, CLIENT_TOOLS, CONNECTED_APP_TOOLS, REQUEST_PROTOCOLS, ROUTING_VERSION, SELLER_ID_PATTERN } from './catalog.js'
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
/**
 * At most this many `buyer_seller_attempt` events per request: past it, the
 * first 9 and the final attempt, so the seller that answered is always sent.
 */
export const MAX_ATTEMPT_EVENTS = 10
/** Attempt numbers are real positions, capped here (the catalog's range). */
const MAX_ATTEMPT_NUMBER = 1_000

/** Why one seller attempt did not answer: the request taxonomy, plus an answer with no text or tool call. */
export type AttemptFailureReason = FailureReason | 'empty_answer'

/** What `_dispatchToPeer` returned for one attempt (the proxy's own result type, structurally). */
export type AttemptResultInput =
  | { done: true; emptyAnswer?: boolean; interrupted?: 'seller' | 'buyer' | 'cancelled' }
  | { done: false; statusCode: number; responseBody: Buffer; errorMessage: string | null; emptyAnswer?: boolean; timedOut?: boolean }

type AttemptRecord = {
  seller: string
  tier: SellerTier
  startedAtMs: number
  endedAtMs: number | null
  firstByteAtMs: number | null
  streamed: boolean
  result: { outcome: RequestOutcome; failureReason: AttemptFailureReason; httpStatus?: number; emptyAnswer: boolean } | null
}

/**
 * The model's one reviewed registry id, so every spelling of a model counts
 * as the same model (`anthropic/claude-opus-4-6` and `claude-opus-4.6` are
 * both `claude-opus-4.6`) and nothing the client typed is sent as is.
 */
export function publicModelId(serviceId: string | null): string {
  if (!serviceId) return 'custom_or_unknown'
  const registered = registeredModelIdFor(serviceId)?.toLowerCase()
  return registered && PUBLIC_MODEL_ID_PATTERN.test(registered) ? registered : 'custom_or_unknown'
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
  /** For a video request: starting the job, or a status poll or download of it. */
  videoAction: 'create' | 'retrieve' | null = null
  model: string | null = null
  routeMode: RouteMode = 'auto'
  clientTool = 'none'
  attempts = 0
  readonly sellers = new Set<string>()
  /** Random, per request: joins its `buyer_seller_attempt` events to its `buyer_request_finished`. */
  readonly requestId: string = randomUUID()
  /** Every seller attempt, in order, with its own result. */
  private readonly attemptLog: AttemptRecord[] = []
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

  /** When the final attempt was sent: the seller's own time to first byte is measured from here. */
  private attemptStartedAtMs: number
  /** Time lost before the final attempt: failed sellers and rate-limit waits. */
  private failedAttemptsMs = 0
  /** A seller answered 429 (rate limited) on some attempt of this request. */
  rateLimited = false

  constructor(readonly startedAtMs: number, readonly peersKnownAtSend: boolean) {
    this.attemptStartedAtMs = startedAtMs
  }

  noteAttempt(peerId: string, atMs: number = this.startedAtMs): void {
    if (this.attempts > 0) this.failedAttemptsMs += Math.max(0, atMs - this.attemptStartedAtMs)
    this.attemptStartedAtMs = atMs
    this.attempts += 1
    this.lastSeller = peerId.toLowerCase()
    this.sellers.add(this.lastSeller)
    this._closeOpenAttempt(atMs, null)
    this.attemptLog.push({
      seller: this.lastSeller,
      tier: this.sellerTier,
      startedAtMs: atMs,
      endedAtMs: null,
      firstByteAtMs: null,
      streamed: false,
      result: null,
    })
    // A later attempt answers for itself: an earlier seller's error reply is
    // not this answer's first byte, and its usage and finish are not this one's.
    this.firstByteAtMs = null
    this.streamed = false
    this.usage = null
    this.finishReason = null
    this.estimatedCostMicroUsd = null
  }

  /**
   * The result of the attempt now running, as the proxy's dispatch returned
   * it. `statusCode` is what the client was sent (for an answer written
   * directly). Ignored once the request has finished.
   */
  noteAttemptResult(result: AttemptResultInput, statusCode: number, atMs: number): void {
    const current = this.attemptLog.at(-1)
    if (this.finished || !current || current.result) return
    const hadOutput = this.firstByteAtMs !== null
    const context = { hadPartialOutput: hadOutput, peersDiscoveredAtSend: this.peersKnownAtSend, freeSellersKnown: this.freeSellersKnown }
    let outcome: RequestOutcome = 'failed'
    let failureReason: AttemptFailureReason = 'none'
    let httpStatus: number | undefined
    const emptyAnswer = result.emptyAnswer === true
    if (result.done) {
      if (result.interrupted === 'cancelled') {
        outcome = 'cancelled'
      } else if (result.interrupted === 'seller') {
        failureReason = hadOutput ? 'seller_dropped_mid_answer' : 'seller_dropped_before_output'
      } else if (result.interrupted === 'buyer') {
        failureReason = 'local_error'
      } else if (statusCode >= 400) {
        const signal = { kind: 'http_error', statusCode }
        failureReason = classifyFailureReason(signal, '', context)
        httpStatus = statusCode
      } else {
        // An empty answer that was sent anyway is still the answer; `empty_answer` marks it.
        outcome = 'success'
      }
    } else if (emptyAnswer) {
      failureReason = 'empty_answer'
    } else {
      const text = (result.errorMessage ?? result.responseBody.subarray(0, MAX_FAILURE_TEXT).toString('utf8'))
      const signal = { kind: result.timedOut ? 'timeout' : result.errorMessage !== null ? 'network_error' : 'http_error', statusCode: result.statusCode }
      const failureText = `${result.statusCode} ${text}`.slice(0, MAX_FAILURE_TEXT)
      failureReason = classifyFailureReason(signal, failureText, context)
      httpStatus = failureHttpStatus(signal, failureText)
    }
    this._closeOpenAttempt(atMs, { outcome, failureReason, ...(httpStatus !== undefined ? { httpStatus } : {}), emptyAnswer })
  }

  /** Ends the running attempt; with no result given, it failed in a way the proxy did not report. */
  private _closeOpenAttempt(atMs: number, result: AttemptRecord['result']): void {
    const current = this.attemptLog.at(-1)
    if (!current || current.result) return
    current.endedAtMs = atMs
    current.firstByteAtMs = this.firstByteAtMs
    current.streamed = this.streamed
    current.result = result ?? { outcome: 'failed', failureReason: 'unknown', emptyAnswer: false }
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

  /** The attempts so far, in order (read-only copies). */
  attemptRecords(): ReadonlyArray<Readonly<AttemptRecord>> {
    return this.attemptLog.map((attempt) => ({ ...attempt }))
  }

  noteFirstByte(atMs: number): void {
    if (this.firstByteAtMs === null) this.firstByteAtMs = atMs
    this.streamed = true
  }

  /**
   * A whole (non-streamed) reply arrived. Only an answer is a first byte: an
   * error reply is not output, and the request may still fall back.
   */
  noteAnswered(atMs: number, statusCode: number, freeTierRefusal = false): void {
    // A used-up free allowance is also a 429, but it is a limit, not a busy seller.
    if (statusCode === 429 && !freeTierRefusal) this.rateLimited = true
    if (statusCode < 400 && this.firstByteAtMs === null) this.firstByteAtMs = atMs
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
    // The client hung up before the answer finished: cancelled, whether or
    // not part of the answer had arrived. A stopped answer is the user's
    // choice, not a failure, and counting it as success would understate
    // tokens, speed and cost.
    const cancelled = this.interrupted === 'cancelled' || statusCode === 499 || (clientAborted && this.interrupted === null && statusCode < 400)
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
    // An attempt still open when the request ended (the client hung up, or
    // the proxy wrote the answer before reporting it) took the request's result.
    this._closeOpenAttempt(nowMs, {
      outcome,
      failureReason,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      emptyAnswer: false,
    })
    const { choice, reason } = this._sellerChoice(outcome)
    const usage = outcome === 'success' ? this.usage : null
    const ttftMs = this.firstByteAtMs === null ? null : Math.max(0, this.firstByteAtMs - this.startedAtMs)
    const sellerTtftMs = this.firstByteAtMs === null ? null : Math.max(0, this.firstByteAtMs - this.attemptStartedAtMs)
    const durationMs = Math.max(0, nowMs - this.startedAtMs)
    return {
      request_id: this.requestId,
      protocol: this.protocol,
      ...(this.videoAction ? { video_action: this.videoAction } : {}),
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
      ...(ttftMs !== null ? { ttft_ms: Math.round(ttftMs) } : {}),
      ...(sellerTtftMs !== null ? { seller_ttft_ms: Math.round(sellerTtftMs) } : {}),
      duration_ms: Math.round(durationMs),
      // A request that failed outright lost its final attempt too.
      failed_attempts_ms: Math.round(this.failedAttemptsMs + (outcome === 'failed' && this.attempts > 0 ? Math.max(0, nowMs - this.attemptStartedAtMs) : 0)),
      rate_limited: this.rateLimited,
      routing_version: ROUTING_VERSION,
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

/**
 * One `buyer_seller_attempt` per seller attempt of a finished request, in
 * order: which seller, and how that attempt went, so failure rates, speed
 * and fallbacks can be measured per seller, not only for the seller that
 * answered. Empty until `finish` has run.
 */
export function attemptEventProperties(trace: RequestTrace): Array<Record<string, unknown>> {
  const records = trace.attemptRecords().map((attempt, index) => ({ attempt, number: index + 1 }))
  // Past the cap, the first attempts and the final one: the final attempt
  // holds the request's result (often the seller that answered), so it is never dropped.
  const sent = records.length <= MAX_ATTEMPT_EVENTS
    ? records
    : [...records.slice(0, MAX_ATTEMPT_EVENTS - 1), records[records.length - 1]!]
  return sent.flatMap(({ attempt, number }) => {
    if (!attempt.result || !SELLER_ID_PATTERN.test(attempt.seller)) return []
    const endedAtMs = attempt.endedAtMs ?? attempt.startedAtMs
    return [{
      request_id: trace.requestId,
      attempt_number: Math.min(number, MAX_ATTEMPT_NUMBER),
      seller_id: attempt.seller,
      seller_tier: attempt.tier,
      protocol: trace.protocol,
      public_model_id: publicModelId(trace.model),
      route_mode: trace.routeMode,
      client_tool: trace.clientTool,
      routing_version: ROUTING_VERSION,
      outcome: attempt.result.outcome,
      failure_reason: attempt.result.failureReason,
      ...(attempt.result.httpStatus !== undefined ? { http_status: attempt.result.httpStatus } : {}),
      empty_answer: attempt.result.emptyAnswer,
      streamed: attempt.streamed,
      duration_ms: Math.round(Math.max(0, endedAtMs - attempt.startedAtMs)),
      ...(attempt.firstByteAtMs !== null ? { seller_ttft_ms: Math.round(Math.max(0, attempt.firstByteAtMs - attempt.startedAtMs)) } : {}),
    }]
  })
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
        if (this._enabled) {
          for (const attempt of attemptEventProperties(trace)) this._client.capture('buyer_seller_attempt', attempt)
        }
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
