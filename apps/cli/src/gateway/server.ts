import { timingSafeEqual } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { nativeVideoAcceptance, nativeVideoRoute, type NativeVideoRoute } from '@antseed/api-adapter'
import { DEFAULT_BUYER_IDENTITY, VIDEO_JOB_RETIRED_HEADER, VIDEO_PRICE_HEADER } from '@antseed/node'
import { SPEND_ATTRIBUTION_HEADER } from '../proxy/spend-attribution.js'
import { decodeServedSelection, ROUTE_SELECTION_HEADER, type ServedSelection } from '../proxy/route-selection.js'
import { ROUTER_PEER_ID_HEADER, ROUTER_RANK_HEADER, ROUTER_SERVICE_HEADER } from '../proxy/telemetry.js'
import { BUYER_IDENTITY_HEADER, MAX_VIDEO_COST_HEADER } from '../proxy/request-utils.js'
import { GATEWAY_CONTROL_HEADER, ROUTING_POLICY_HEADER, encodePolicyHeader, meaningfulPolicy, policyAllowsModel, type RoutingPolicy } from '../routing-policy/policy.js'
import { effectiveKeyLimits, newRequestTag, videoJobKey, type AdmitOptions, type GatewayAccounting, type KeyContext } from './accounting.js'
import { errorMessage } from './errors.js'
import { isClientCredentialHeader } from '../proxy/credential-headers.js'
import { isBrowserContextHeader } from '../proxy/local-request-guard.js'
import { parseBearerToken } from './keys.js'
import { BUDGET_PERIODS, type LimitBreach } from './limits.js'
import { formatUsdc, optionalUsdcToDecimalString, parseUsdToUsdc, usdcToDecimalString } from './money.js'
import { OtlpExporter, observabilitySettings } from './observability.js'
import { isEmptyPolicy, resolvePolicy } from './policy-resolver.js'
import { END_USER_HEADER, applyPreset, effectiveRequestModel, extractEndUser, presetSlug } from './request-shaping.js'
import { ResponseUsageReader } from './response-usage.js'
import { SPEND_FEED_UNAUTHORIZED_HINT, type SpendFeedState } from './spend-feed.js'
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  X402_VERSION,
  buildPaymentRequirements,
  checkPaymentPayload,
  decodeHeaderJson,
  encodeHeaderJson,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type X402Asset,
  type X402Facilitator,
} from './x402.js'
import type { ApiKeyRecord, GatewayStore, PresetRecord, RequestError, RequestRouter } from './store.js'

/**
 * The gateway's own components (the console chat agent) call `/v1` as a key
 * by its id, without its secret: this header plus the control secret, from
 * loopback only. Stripped from everything forwarded to the buyer.
 */
export const GATEWAY_INTERNAL_KEY_HEADER = 'x-antseed-gateway-key'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

/**
 * Largest request body the gateway accepts, matching the buyer's default
 * upload limit. Every accepted body is parsed to read its model, the way the
 * buyer reads it: that model decides the preset, the allow list and the
 * accounting, so the two must never disagree about it.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024
/** How much of a failed response is read for its error code and message. */
const MAX_ERROR_BODY_BYTES = 16 * 1024
const MAX_ERROR_MESSAGE_CHARS = 500
/** Request and response bodies kept per request while content logging is on. */
const MAX_LOGGED_CONTENT_BYTES = 64 * 1024
/**
 * A buyer that refuses connections is restarting (an update, a console
 * restart): requests wait this long for it instead of failing. It covers the
 * buyer's shutdown drain and its startup.
 */
const BUYER_RESTART_HOLD_MS = 120_000
const BUYER_RETRY_INTERVAL_MS = 500
/** On shutdown, requests in flight get this long to finish before they are closed. */
const SHUTDOWN_DRAIN_MS = 60_000
const RETENTION_SWEEP_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** Why a key with caps cannot be served while its buyer's spend feed is not reporting. */
const SPEND_FEED_UNAVAILABLE_MESSAGES: Record<Exclude<SpendFeedState, 'reporting'>, string> = {
  unsupported: 'The buyer for this API key does not report spend; upgrade it to enforce spend limits',
  unauthorized: `The buyer for this API key does not report spend to this gateway; ${SPEND_FEED_UNAUTHORIZED_HINT}`,
  unreachable: 'The buyer for this API key is not reachable',
}
const KEY_INFO_PATH = '/v1/key'
const TOPUP_PATH = '/v1/key/topup'

/**
 * `paid` routes reach a seller; the others are answered by the buyer for
 * free, or (`local`) by the gateway itself.
 */
const ALLOWED_ROUTES: ReadonlyArray<{ method: string; prefix: string; paid: boolean; local?: boolean }> = [
  { method: 'GET', prefix: KEY_INFO_PATH, paid: false, local: true },
  { method: 'POST', prefix: TOPUP_PATH, paid: false, local: true },
  { method: 'GET', prefix: '/v1/models', paid: false },
  { method: 'POST', prefix: '/v1/messages', paid: true },
  { method: 'POST', prefix: '/v1/messages/count_tokens', paid: false },
  { method: 'POST', prefix: '/v1/chat/completions', paid: true },
  { method: 'POST', prefix: '/v1/responses', paid: true },
  { method: 'POST', prefix: '/v1/images/generations', paid: true },
  { method: 'POST', prefix: '/v1/images/edits', paid: true },
  // Native video jobs, as the buyer serves them: queue, then poll retrieve until it streams the MP4 (charged on delivery).
  { method: 'POST', prefix: '/api/v1/video/queue', paid: true },
  { method: 'POST', prefix: '/api/v1/video/retrieve', paid: true },
  { method: 'POST', prefix: '/fal/v1/video/queue', paid: true },
  { method: 'POST', prefix: '/fal/v1/video/retrieve', paid: true },
]

interface CanonicalRoute {
  /** The allowed route's path plus the request's query. */
  path: string
  prefix: string
  paid: boolean
  local: boolean
}

/** An admitted request on its way to the buyer. */
interface ForwardedRequest {
  tag: string
  key: ApiKeyRecord
  method: string
  /** As the client sent it, for the log. */
  path: string
  /** The canonical path, query included, sent to the buyer. */
  buyerPath: string
  /** `buyerPath` without the query (the route's prefix), as recorded and exported. */
  requestPath: string
  model: string | null
  endUser: string | null
  startedAt: number
  body: Buffer
  /** The routing policy and the secret that vouches for it; empty without a policy. */
  policyHeaders: Record<string, string>
  /**
   * For `GET /v1/models` under a model allow list: the policy the listing is
   * narrowed to here, since without a control secret the buyer never sees it.
   */
  modelListPolicy: RoutingPolicy | null
  /** A native video create or retrieve: only the retrieve that delivers the file is charged. */
  video: NativeVideoRoute | null
  /** Room left under the key's caps at admission (a video create's reserved allowance); null when nothing is capped. */
  remainingUsdc: number | null
}

export interface GatewayServerOptions {
  store: GatewayStore
  accounting: GatewayAccounting
  buyerPort: number
  /** Wallet address of a buyer identity, for key holders' usage view. */
  identityAddress: (buyerIdentity: string) => Promise<string | null>
  spendFeedState: () => SpendFeedState
  refreshSpendFeed: () => Promise<void>
  /**
   * Whether the buyer refuses a video priced above the room it is told about
   * (older buyers ignore it). Without it, video creates of capped keys are
   * refused: the price must be checked before a job starts.
   */
  videoBudgetEnforced?: () => boolean
  /** x402 top-ups into a key's buyer wallet; null disables `POST /v1/key/topup`. */
  topup?: GatewayTopupOptions | null
  /** Observes each settle attempt's outcome, for anonymous telemetry. Never changes the answer. */
  onTopupOutcome?: (outcome: 'settled' | 'rejected', amountUsdc: number) => void
  listenPort?: number
  listenHost?: string
  onLog?: (message: string) => void
  /**
   * Secret the buyer trusts routing policies with (see buyer-control.ts).
   * Without it no policy header is sent, and keys whose policy restricts
   * sellers are refused rather than routed unrestricted.
   */
  controlSecret?: string | null
  /** True while the buyer has not confirmed it applies routing policies (see buyer-policy-probe.ts). */
  buyerPolicyUnsupported?: () => boolean
  /** Console (`/console`, `/console/api/*`), answered before API-key auth. */
  console?: { handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> } | null
  /** Span exporter; defaults to one reading the observability settings from the store. */
  exporter?: OtlpExporter
  /** How long a request waits for a buyer that refuses connections (restarting); default BUYER_RESTART_HOLD_MS. */
  buyerRestartHoldMs?: number
  /** How long `stop()` lets requests in flight finish before closing them; default SHUTDOWN_DRAIN_MS. */
  shutdownDrainMs?: number
}

export interface GatewayTopupOptions {
  asset: () => Promise<X402Asset>
  facilitator: X402Facilitator
  minUsdc: number
  maxUsdc: number
}

/**
 * Authenticated front door to a buyer. Each API key names the buyer identity
 * (wallet) that pays for it, carries optional spend caps, and gets its signed
 * spend attributed back through the buyer's spend feed.
 */
export class GatewayServer {
  private _server: http.Server | null = null
  private _port = 0
  private _retentionTimer: ReturnType<typeof setInterval> | null = null
  private _pruning: Promise<number> | null = null
  private readonly _exporter: OtlpExporter

  constructor(private readonly _options: GatewayServerOptions) {
    this._exporter = _options.exporter ?? new OtlpExporter(() => observabilitySettings(_options.store), { onLog: (m) => this._log(m) })
  }

  get port(): number {
    return this._port
  }

  async start(): Promise<number> {
    if (this._server) return this._port
    this._server = http.createServer((req, res) => {
      this._handle(req, res).catch((error: unknown) => {
        this._log(`gateway error: ${errorMessage(error)}`)
        if (!res.headersSent) sendError(res, 500, 'api_error', 'internal_error', 'Gateway error')
        else res.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      this._server!.once('error', reject)
      this._server!.listen(this._options.listenPort ?? 0, this._options.listenHost ?? '127.0.0.1', () => resolve())
    })
    this._port = (this._server.address() as AddressInfo).port
    void this.pruneRequestLog()
    this._retentionTimer = setInterval(() => { void this.pruneRequestLog() }, RETENTION_SWEEP_MS)
    this._retentionTimer.unref?.()
    return this._port
  }

  /**
   * Applies the request-log retention setting; resolves to rows removed. A
   * large backlog is pruned one chunk per event-loop turn, and a sweep that
   * is still running is joined rather than started twice.
   */
  pruneRequestLog(now = Date.now()): Promise<number> {
    if (this._pruning) return this._pruning
    const { retentionDays } = observabilitySettings(this._options.store)
    if (!retentionDays) return Promise.resolve(0)
    this._pruning = this._options.store.pruneRequests(now - retentionDays * DAY_MS)
      .then((removed) => {
        if (removed > 0) this._log(`pruned ${removed} request log row(s) older than ${retentionDays} day(s)`)
        return removed
      }, (error: unknown) => {
        this._log(`gateway could not prune the request log: ${errorMessage(error)}`)
        return 0
      })
      .finally(() => { this._pruning = null })
    return this._pruning
  }

  async stop(): Promise<void> {
    const server = this._server
    this._server = null
    this._port = 0
    if (this._retentionTimer) clearInterval(this._retentionTimer)
    this._retentionTimer = null
    if (!server) {
      await this._exporter.stop()
      return
    }
    // Stop accepting (a proxy in front retries elsewhere or waits for the next
    // process), let requests in flight finish, then close what is left.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    const drain = setTimeout(() => server.closeAllConnections(), this._options.shutdownDrainMs ?? SHUTDOWN_DRAIN_MS)
    drain.unref?.()
    await closed
    clearTimeout(drain)
    await this._exporter.stop()
  }

  /** Whether the gateway should keep waiting for a buyer that has refused connections since `since`. */
  private _holdForBuyer(since: number): boolean {
    return this._server !== null && Date.now() - since < (this._options.buyerRestartHoldMs ?? BUYER_RESTART_HOLD_MS)
  }

  private _log(message: string): void {
    this._options.onLog?.(message)
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'
    const pathname = path.split('?')[0]!
    if (this._options.console && (pathname === '/console' || pathname.startsWith('/console/'))) {
      if (await this._options.console.handle(req, res)) return
    }
    const route = canonicalizeRoute(method, path)
    if (!route) {
      this._log(`gateway rejected route: ${method} ${path}`)
      sendError(res, 404, 'invalid_request_error', 'not_found', 'Not found')
      return
    }
    const authenticated = this._authenticate(req, res, `${method} ${path}`)
    if (!authenticated) return
    const { key, context } = authenticated

    if (route.local) {
      if (route.prefix === TOPUP_PATH) await this._topup(req, res, key)
      else sendJson(res, 200, { data: await this._keyInfo(key) })
      return
    }

    // Caps are only as good as the spend that reaches the ledger, so a key
    // with caps fails closed while its buyer is not reporting spend.
    if (route.paid && this._options.accounting.hasBudgets(key, context)) {
      if (!await this._spendFeedReporting(res)) return
      // Caps count accepted video jobs; refuse rather than admit against commitments that could be lost.
      if (!this._options.accounting.videoCommitmentsReady()) {
        sendError(res, 503, 'api_error', 'spend_tracking_unavailable', 'Spend limits cannot be applied right now: video jobs could not be stored. Try again shortly.')
        return
      }
    }

    let body = await readBody(req)
    if (!body) return sendBodyTooLarge(res)
    const contentType = req.headers['content-type']
    let parsed = parseJsonBody(body, contentType)
    // What the buyer routes by (`service ?? model`), so the allow list and
    // the request log see the model that is actually bought.
    let model = effectiveRequestModel(parsed, body, contentType)

    // `model: "@preset/<slug>"` runs the workspace's (or org's) preset.
    const slug = presetSlug(model)
    const preset = slug ? this._options.store.findPresetBySlug(slug, key.workspaceId) : null
    if (slug) {
      if (!parsed) {
        sendError(res, 400, 'invalid_request_error', 'preset_requires_json', 'Presets can only be used with JSON request bodies')
        return
      }
      if (!preset) {
        sendError(res, 400, 'invalid_request_error', 'preset_not_found', `No preset named "${slug}"`)
        return
      }
      parsed = applyPreset(parsed, preset, route.prefix)
      body = Buffer.from(JSON.stringify(parsed), 'utf8')
      model = preset.model
    }

    const policy = this._routingPolicy(res, route, key, context, preset, model)
    if (!policy.allowed) return
    const video = nativeVideoRoute({ method, path: route.prefix, body })
    const videoJob = video?.action === 'retrieve' && video.resourceId ? videoJobKey(video.protocol, video.resourceId) : undefined
    // Only the key that created a video job may retrieve it: its delivery is charged to the key that downloads it.
    if (video?.action === 'retrieve' && !this._ownsVideoJob(key, videoJob, video.resourceId)) {
      sendError(res, 404, 'invalid_request_error', 'video_route_not_found', 'Unknown video job')
      return
    }
    // Read from the buyer now, not from the last poll: a buyer just replaced by an older one must not start the job.
    if (video?.action === 'create' && route.paid && this._options.accounting.hasBudgets(key, context) && !await this._videoBudgetEnforced()) {
      sendError(res, 503, 'api_error', 'buyer_upgrade_required', 'Videos cannot be started on a key with spend limits until the Antseed buyer is updated: this buyer cannot check a video\'s price against the limit before it starts.')
      return
    }
    const admission = this._admit(res, route, key, context, { videoCreate: video?.action === 'create', ...(videoJob ? { videoJob } : {}) })
    if (!admission) return
    const { tag } = admission

    const request: ForwardedRequest = {
      tag,
      key,
      method,
      path,
      buyerPath: route.path,
      requestPath: route.prefix,
      model: model ? model.slice(0, 200) : null,
      endUser: extractEndUser(parsed, firstHeader(req.headers[END_USER_HEADER]) || undefined),
      startedAt: Date.now(),
      body,
      policyHeaders: policy.headers,
      modelListPolicy: route.prefix === '/v1/models' && policy.policy.allowedModels ? policy.policy : null,
      video,
      remainingUsdc: admission.remainingUsdc,
    }
    try {
      this._options.store.startRequest({
        tag,
        keyId: key.id,
        buyerIdentity: key.buyerIdentity,
        method,
        path: request.requestPath,
        model: request.model,
        startedAt: request.startedAt,
        workspaceId: key.workspaceId,
        memberId: key.ownerMemberId,
        endUser: request.endUser,
        video: request.video && { action: request.video.action === 'create' ? 'create' : 'poll', jobId: request.video.resourceId ?? null },
      })
      this._options.store.touchKey(key.id)
    } catch (error) {
      // Nothing was sent; the hold (and a create's reservation) must not keep counting against the caps.
      this._options.accounting.videoNotAccepted(tag)
      this._options.accounting.release(tag)
      throw error
    }
    this._forward(req, res, request)
  }

  /** The request's active API key and who it is accounted to; answers 401 itself otherwise. */
  private _authenticate(req: http.IncomingMessage, res: http.ServerResponse, requestLine: string): { key: ApiKeyRecord; context: KeyContext } | null {
    const store = this._options.store
    const key = this._requestKey(req)
    if (!key || key.status !== 'active') {
      this._log(`gateway rejected authentication: ${requestLine}`)
      if (key) sendUnauthorized(res, 'key_revoked', 'API key has been revoked')
      else sendUnauthorized(res, 'invalid_api_key', 'Invalid API key')
      return null
    }
    if (key.expiresAt !== null && key.expiresAt <= Date.now()) {
      sendUnauthorized(res, 'key_expired', 'API key has expired')
      return null
    }
    // Loaded once and shared by policy resolution and budget admission.
    const member = key.ownerMemberId ? store.getMember(key.ownerMemberId) : null
    if (member?.status === 'disabled') {
      sendUnauthorized(res, 'key_revoked', 'API key has been revoked')
      return null
    }
    return { key, context: { member, workspace: store.getWorkspace(key.workspaceId) } }
  }

  /**
   * The key a request names: by id for the gateway's own components (see
   * GATEWAY_INTERNAL_KEY_HEADER), else by its Bearer secret. The id header is
   * only honored from an internal caller; from anyone else it is ignored, so
   * it can neither stand in for a key nor block a valid Bearer one.
   */
  private _requestKey(req: http.IncomingMessage): ApiKeyRecord | null {
    const internalKeyId = firstHeader(req.headers[GATEWAY_INTERNAL_KEY_HEADER])
    if (internalKeyId && this._internalCaller(req)) return this._options.store.getKey(internalKeyId)
    const secret = parseBearerToken(req.headers.authorization)
    return secret ? this._options.store.findKeyBySecret(secret) : null
  }

  /** A request from the gateway process itself: loopback, carrying the control secret. */
  private _internalCaller(req: http.IncomingMessage): boolean {
    const expected = this._options.controlSecret
    const sent = firstHeader(req.headers[GATEWAY_CONTROL_HEADER])
    if (!expected || !sent || !isLoopback(req.socket.remoteAddress)) return false
    const a = Buffer.from(sent)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Whether the buyer reports spend, refreshing the feed once; answers 503 itself when it does not. */
  private async _spendFeedReporting(res: http.ServerResponse): Promise<boolean> {
    if (this._options.spendFeedState() === 'reporting') return true
    await this._options.refreshSpendFeed()
    let state = this._options.spendFeedState()
    // A buyer that is restarting reports again once it is back.
    const since = Date.now()
    while (state === 'unreachable' && !res.destroyed && this._holdForBuyer(since)) {
      await new Promise((resolve) => setTimeout(resolve, BUYER_RETRY_INTERVAL_MS))
      await this._options.refreshSpendFeed()
      state = this._options.spendFeedState()
    }
    if (res.destroyed) return false
    if (state === 'reporting') return true
    sendError(res, 503, 'api_error', 'spend_tracking_unavailable', SPEND_FEED_UNAVAILABLE_MESSAGES[state])
    return false
  }

  /**
   * The key's effective routing policy: refuses (answering itself) a model
   * it does not allow, or a seller restriction the buyer would not apply.
   * Settings that change nothing (the default sort, flags set to false) are
   * not sent: a request without restrictions reaches the buyer exactly like
   * one through a gateway without policies.
   */
  private _routingPolicy(
    res: http.ServerResponse,
    route: CanonicalRoute,
    key: ApiKeyRecord,
    context: KeyContext,
    preset: PresetRecord | null,
    model: string | null,
  ): { allowed: false } | { allowed: true; headers: Record<string, string>; policy: RoutingPolicy } {
    const { policy } = resolvePolicy(this._options.store, { key, preset, member: context.member, workspace: context.workspace })
    if ((route.paid || model) && !policyAllowsModel(policy, model)) {
      sendError(res, 403, 'permission_error', 'model_not_allowed', model
        ? `Model "${model}" is not allowed for this API key`
        : 'This API key may only use specific models; name one in the request')
      return { allowed: false }
    }
    const routed = meaningfulPolicy(policy)
    if (isEmptyPolicy(routed)) return { allowed: true, headers: {}, policy }
    const controlSecret = this._options.controlSecret ?? null
    const sellersRestricted = restrictsSellers(routed)
    if (!controlSecret && sellersRestricted) {
      sendError(res, 503, 'api_error', 'routing_policy_unavailable', 'This API key has a routing policy the gateway cannot pass to the buyer')
      return { allowed: false }
    }
    if (route.paid && sellersRestricted && this._options.buyerPolicyUnsupported?.()) {
      sendError(res, 503, 'api_error', 'buyer_policy_unsupported', "The buyer does not apply this API key's routing policy; upgrade it or check the gateway control secret")
      return { allowed: false }
    }
    if (!controlSecret) return { allowed: true, headers: {}, policy }
    return { allowed: true, headers: { [ROUTING_POLICY_HEADER]: encodePolicyHeader(routed), [GATEWAY_CONTROL_HEADER]: controlSecret }, policy }
  }

  /** The request's tag; a paid request is admitted against its budgets first (402 answered here when one is spent). */
  private _admit(res: http.ServerResponse, route: CanonicalRoute, key: ApiKeyRecord, context: KeyContext, video: AdmitOptions): { tag: string; remainingUsdc: number | null } | null {
    if (!route.paid) return { tag: newRequestTag(), remainingUsdc: null }
    const admission = this._options.accounting.admit(key, context, video)
    if (admission.ok) return { tag: admission.tag, remainingUsdc: admission.remainingUsdc }
    if (admission.breach === null) {
      if (admission.reason === 'video_pricing') {
        res.setHeader('retry-after', '5')
        sendError(res, 429, 'rate_limit_error', 'video_pricing_in_progress', 'A video started on this spend limit is still being priced and holds the room it may cost. Retry in a few seconds.')
      } else {
        sendError(res, 503, 'api_error', 'spend_tracking_unavailable', 'Spend limits cannot be applied right now: video jobs could not be stored. Try again shortly.')
      }
      return null
    }
    this._log(`gateway spend limit reached: key=${key.id} level=${admission.breach.level ?? 'key'} period=${admission.breach.period}`)
    sendJson(res, 402, { error: spendLimitError(admission.breach) })
    return null
  }

  private async _videoBudgetEnforced(): Promise<boolean> {
    if (!this._options.videoBudgetEnforced) return false
    try {
      await this._options.refreshSpendFeed()
    } catch {
      return false
    }
    return this._options.videoBudgetEnforced()
  }

  /** Whether `key` created the video job, as remembered by its commitment or, for older jobs, the request log. */
  private _ownsVideoJob(key: ApiKeyRecord, job: string | undefined, jobId: string | undefined): boolean {
    if (!job || !jobId) return false
    const owner = this._options.accounting.videoJobOwner(job) ?? this._options.store.findVideoJobCreator(jobId)
    return owner === key.id
  }

  /**
   * Accounting for a video request once answered. An accepted create records
   * its job: the key that owns it and, for a key with caps, the price it keeps
   * counted until the buyer's charge for its delivery arrives. That price is
   * the buyer's (set only by the buyer), never more than the allowance the
   * create held; without a readable price the whole allowance stays held. A
   * retrieve the buyer marks as retiring the job (it failed, its seller no
   * longer has it, or the buyer has no record of it) releases the job: it can
   * never be delivered or charged. Nothing a seller sends can release it.
   */
  private _settleVideo(request: ForwardedRequest, outcome: { videoJobId: string | null; priceHeader: string; retired: boolean; delivered: boolean }): void {
    const video = request.video
    if (!video) return
    const accounting = this._options.accounting
    if (video.action === 'create') {
      if (!outcome.videoJobId) {
        accounting.videoNotAccepted(request.tag)
        return
      }
      const allowance = request.remainingUsdc
      const price = /^\d{1,15}$/.test(outcome.priceHeader) ? Number(outcome.priceHeader) : null
      // A key without caps has no allowance: it records the buyer's price, so caps added later count the job.
      const amount = allowance === null ? price ?? 0 : Math.min(allowance, price ?? allowance)
      accounting.commitVideo(request.tag, videoJobKey(video.protocol, outcome.videoJobId), amount)
      return
    }
    if (!video.resourceId) return
    const job = videoJobKey(video.protocol, video.resourceId)
    if (outcome.retired) accounting.dropVideo(job)
    else if (outcome.delivered) accounting.videoDelivered(job)
  }

  /**
   * Sends an admitted request to the buyer and streams the answer back.
   * Every path must finish the request (and so release or start expiring
   * its hold); an unexpected throw must not leak it.
   */
  private _forward(req: http.IncomingMessage, res: http.ServerResponse, request: ForwardedRequest): void {
    const { tag, key, method, startedAt, endUser, body } = request
    const buyerPort = this._options.buyerPort
    let finish: ((status: number, buyerRequestId: string | null) => void) | null = null
    let sentToBuyer = false
    try {
      this._log(`gateway request: key=${key.id} identity=${key.buyerIdentity} ${method} ${request.path} -> ${request.buyerPath}`)

      const observability = observabilitySettings(this._options.store)
      const requestContent = observability.logContent ? truncateContent(body) : null
      let responseChunks: Buffer[] = []
      // The start of a failed response, read whatever the content setting, for its error code and message.
      let errorChunks: Buffer[] = []
      let gatewayError: RequestError | null = null
      let sellerPeerId: string | null = null
      let servedModel: string | null = null
      let routeSelection: ServedSelection | null = null
      let router: RequestRouter | null = null
      let reportedLatency: number | null = null
      // Streamed answers: the buyer's time to the seller's first frame, and when that frame reached the gateway.
      let firstTokenMs: number | null = null
      let respondedAt = 0
      let servedFree = false
      // Video: the start of a create's answer (it names the job) and whether a retrieve delivered the file.
      let videoCreateChunks: Buffer[] | null = null
      let videoDelivered = false
      // A retrieve answered with the file; it is delivered (and charged) only once that stream ends.
      let videoStream = false
      // The buyer's price for an accepted create, and whether the buyer retired a retrieved job.
      let videoPriceHeader = ''
      let videoRetired = false
      // Token counts the response reports, kept on the request until (or if
      // the buyer never reports) its spend.
      let usageReader: ResponseUsageReader | null = null

      let clientClosed = false
      let finished = false
      finish =(status: number, buyerRequestId: string | null): void => {
        if (finished) return
        finished = true
        const finishedAt = Date.now()
        const latencyMs = reportedLatency ?? finishedAt - startedAt
        const responseContent = observability.logContent ? truncateContent(Buffer.concat(responseChunks)) : null
        const store = this._options.store
        // Read from the answer itself: the job's accounting must not depend on the request log being writable.
        let videoJobId: string | null = null
        try {
          videoJobId = videoCreateChunks && request.video
            ? nativeVideoAcceptance(request.video.protocol, { requestId: tag, statusCode: status, headers: {}, body: Buffer.concat(videoCreateChunks) })
            : null
        } catch (error) {
          this._log(`gateway could not read video acceptance for ${tag}: ${errorMessage(error)}`)
        }
        const usage = usageReader?.result() ?? null
        const tokensPerSecond = firstTokenMs !== null ? outputTokensPerSecond(usage?.outputTokens ?? 0, finishedAt - respondedAt) : null
        try {
          // First, and apart from the rest: the job ID is what lets its key retrieve it after a restart.
          store.recordRequestOutcome(tag, { sellerPeerId, latencyMs, firstTokenMs, tokensPerSecond, endUser, servedFree, videoJobId, videoDelivered, router, servedModel, routeSelection })
        } catch (error) {
          this._log(`gateway could not record request ${tag}: ${errorMessage(error)}`)
        }
        try {
          const error = status >= 400 ? gatewayError ?? parseErrorBody(Buffer.concat(errorChunks), status) : null
          store.finishRequest(tag, { status, buyerRequestId, error })
          if (usage) store.recordResponseUsage(tag, usage)
          if (observability.logContent) store.recordRequestContent(tag, { requestBody: requestContent, responseBody: responseContent })
        } catch (error) {
          this._log(`gateway could not record request ${tag}: ${errorMessage(error)}`)
        }
        const accounting = this._options.accounting
        try {
          this._settleVideo(request, { videoJobId, priceHeader: videoPriceHeader, retired: videoRetired, delivered: videoDelivered })
        } catch (error) {
          this._log(`gateway could not account for video request ${tag}: ${errorMessage(error)}`)
        }
        // Only the retrieve that delivers a video is charged, and a job that still holds its price covers that
        // charge until it arrives: a create, a status poll or such a delivery holds nothing once answered.
        const job = request.video?.resourceId ? videoJobKey(request.video.protocol, request.video.resourceId) : null
        if (request.video && (!videoDelivered || (job !== null && accounting.videoJobHeldUsdc(job) > 0))) accounting.release(tag)
        else accounting.finish(tag)
        this._exporter.record({
          tag, method, path: request.requestPath, model: request.model, status, startedAt, finishedAt,
          keyId: key.id, workspaceId: key.workspaceId, memberId: key.ownerMemberId, endUser, sellerPeerId, latencyMs,
          ...(observability.logContent ? { requestBody: requestContent, responseBody: responseContent } : {}),
        })
      }

      const headers: http.OutgoingHttpHeaders = { ...forwardedHeaders(req.headers), ...request.policyHeaders }
      headers.host = `127.0.0.1:${buyerPort}`
      headers.connection = 'close'
      headers['content-length'] = String(body.length)
      headers['x-antseed-system-proxy-source'] = tunnelRequestSource(req.headers)
      headers[SPEND_ATTRIBUTION_HEADER] = tag
      // The buyer prices the video and refuses one that costs more than the key has left.
      if (request.video?.action === 'create' && request.remainingUsdc !== null) {
        headers[MAX_VIDEO_COST_HEADER] = String(Math.max(0, Math.floor(request.remainingUsdc)))
      }
      if (key.buyerIdentity !== DEFAULT_BUYER_IDENTITY) {
        headers[BUYER_IDENTITY_HEADER] = key.buyerIdentity
        // The buyer lets only its gateway pay from a non-default wallet.
        const controlSecret = this._options.controlSecret
        if (controlSecret) headers[GATEWAY_CONTROL_HEADER] = controlSecret
      }

      let upstream: http.ClientRequest
      // Set while the request waits for a restarting buyer.
      let retryTimer: ReturnType<typeof setTimeout> | null = null
      let refusedSince: number | null = null
      const send = (): void => {
        retryTimer = null
        upstream = http.request({
          hostname: '127.0.0.1',
          port: buyerPort,
          method,
          path: request.buyerPath,
          headers,
        }, (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502
          const buyerRequestId = firstHeader(upstreamRes.headers['x-antseed-request-id']) || null
          sellerPeerId = firstHeader(upstreamRes.headers['x-antseed-peer-id']).slice(0, 200) || null
          servedModel = firstHeader(upstreamRes.headers['x-antseed-service']).slice(0, 200) || null
          router = routerHeaders(upstreamRes.headers)
          routeSelection = decodeServedSelection(upstreamRes.headers[ROUTE_SELECTION_HEADER])
          reportedLatency = latencyHeader(firstHeader(upstreamRes.headers['x-antseed-latency-ms']))
          firstTokenMs = status < 400 ? latencyHeader(firstHeader(upstreamRes.headers['x-antseed-first-token-ms'])) : null
          respondedAt = Date.now()
          const contentType = firstHeader(upstreamRes.headers['content-type']).toLowerCase()
          // A video is priced per second, not per token: zero token prices do not make it free.
          servedFree = !request.video && freeSellerPricing(upstreamRes.headers)
          if (request.video?.action === 'create' && status >= 200 && status < 300) {
            videoCreateChunks = collectPrefix(upstreamRes, MAX_ERROR_BODY_BYTES)
            videoPriceHeader = firstHeader(upstreamRes.headers[VIDEO_PRICE_HEADER])
          }
          videoStream = request.video?.action === 'retrieve' && status === 200 && contentType.startsWith('video/')
          videoRetired = request.video?.action === 'retrieve' && firstHeader(upstreamRes.headers[VIDEO_JOB_RETIRED_HEADER]) === '1'
          if (observability.logContent) responseChunks = collectPrefix(upstreamRes, MAX_LOGGED_CONTENT_BYTES)
          if (status >= 400) errorChunks = collectPrefix(upstreamRes, MAX_ERROR_BODY_BYTES)
          // A delivered video is an MP4 stream with no usage to read.
          else if (request.model !== null && !contentType.startsWith('video/')) usageReader = readUsage(upstreamRes, (message) => this._log(message))
          const responseHeaders: http.OutgoingHttpHeaders = {}
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) responseHeaders[name] = value
          }
          responseHeaders.connection = 'close'
          // The request log is keyed by this tag. The buyer's x-antseed-request-id is a different id.
          responseHeaders['x-antseed-gateway-tag'] = tag
          upstreamRes.once('error', () => {
            finish!(status, buyerRequestId)
            // The buyer's answer broke off: end the client's too, rather than leave it waiting.
            res.destroy()
          })
          res.once('close', () => finish!(status, buyerRequestId))
          const modelListPolicy = request.modelListPolicy
          if (modelListPolicy && status === 200) {
            const chunks: Buffer[] = []
            upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
            upstreamRes.once('end', () => {
              const listing = filterModelList(Buffer.concat(chunks), modelListPolicy)
              res.writeHead(status, { ...responseHeaders, 'content-length': String(listing.length) })
              res.end(listing)
              finish!(status, buyerRequestId)
            })
            return
          }
          res.writeHead(status, responseHeaders)
          upstreamRes.pipe(res)
          upstreamRes.once('end', () => {
            // An interrupted download is not charged: the job stays committed until it is downloaded in full.
            videoDelivered = videoStream
            finish!(status, buyerRequestId)
          })
        })

        upstream.on('error', (error) => {
          // Destroying the buyer request for a client that left fails it too; that is the client's cancel, not a buyer outage.
          if (clientClosed) {
            closedByClient()
            return
          }
          // Refused: the buyer never saw the request and is restarting, so it is safe to send again.
          const refused = (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
          if (refused) {
            if (refusedSince === null) {
              refusedSince = Date.now()
              this._log(`gateway holding request until the buyer is back: key=${key.id}`)
            }
            // A capped video create is not held: the buyer that comes back may be an older one, which would
            // start the job without checking its price (see `_videoBudgetEnforced`).
            if (!(request.video?.action === 'create' && request.remainingUsdc !== null) && this._holdForBuyer(refusedSince)) {
              retryTimer = setTimeout(send, BUYER_RETRY_INTERVAL_MS)
              return
            }
          }
          this._log(`gateway upstream error: ${error.message}`)
          gatewayError = { code: 'buyer_unavailable', message: 'Antseed buyer proxy is unavailable' }
          finish!(502, null)
          // Never accepted, so never signed for: no spend can follow.
          if (refused) this._options.accounting.release(tag)
          if (!res.headersSent) {
            sendError(res, 502, 'api_error', 'buyer_unavailable', 'Antseed buyer proxy is unavailable')
          } else {
            res.destroy()
          }
        })
        upstream.end(body)
      }
      const closedByClient = (): void => {
        // stop() closes what is left after its drain; that is not the client's cancel.
        if (this._server === null) {
          this._log(`gateway stopped before the buyer answered: key=${key.id}`)
          gatewayError = { code: 'gateway_stopping', message: 'The gateway stopped before the buyer answered' }
          finish!(503, null)
          return
        }
        this._log(`gateway client closed before the buyer answered: key=${key.id}`)
        gatewayError = { code: 'client_closed_request', message: 'Client closed the request before the buyer answered' }
        finish!(499, null)
      }
      // A client that disconnects mid-stream should stop the paid request too.
      res.once('close', () => {
        if (res.writableFinished) return
        clientClosed = true
        if (retryTimer) {
          // Waiting for the buyer, which never saw this request.
          clearTimeout(retryTimer)
          retryTimer = null
          closedByClient()
          this._options.accounting.release(tag)
        } else {
          upstream.destroy()
        }
      })
      sentToBuyer = true
      send()
    } catch (error) {
      this._log(`gateway error after admission: ${errorMessage(error)}`)
      if (finish) finish(500, null)
      else {
        try {
          this._options.store.finishRequest(tag, { status: 500, buyerRequestId: null, error: { code: 'internal_error', message: 'Gateway error' } })
        } catch {
          // Already logged above; the hold still goes.
        }
      }
      // A request the buyer never saw cannot be signed for: drop its hold now.
      if (!sentToBuyer) this._options.accounting.release(tag)
      if (!res.headersSent) sendError(res, 500, 'api_error', 'internal_error', 'Gateway error')
      else res.destroy()
    }
  }

  /**
   * x402 top-up: the key holder pays USDC straight to the key's buyer wallet.
   * The buyer's deposit watcher then sweeps it into that identity's credits.
   * Without a PAYMENT-SIGNATURE the answer is the 402 an x402 client pays.
   */
  private async _topup(req: http.IncomingMessage, res: http.ServerResponse, key: ApiKeyRecord): Promise<void> {
    const topup = this._options.topup
    if (!topup) {
      sendError(res, 501, 'invalid_request_error', 'topup_unavailable', 'This gateway does not accept top-ups')
      return
    }
    if (key.buyerIdentity === DEFAULT_BUYER_IDENTITY) {
      sendError(res, 403, 'invalid_request_error', 'topup_not_available', 'This key is paid from the operator\'s wallet and cannot be topped up')
      return
    }
    if (!key.topupEnabled) {
      sendError(res, 403, 'invalid_request_error', 'topup_not_allowed', 'Top-ups are not enabled for this API key')
      return
    }
    const payTo = await this._options.identityAddress(key.buyerIdentity).catch(() => null)
    if (!payTo) {
      sendError(res, 503, 'api_error', 'buyer_wallet_unknown', 'The wallet behind this API key is not available')
      return
    }

    const raw = await readBody(req)
    if (!raw) return sendBodyTooLarge(res)
    let amountUsdc: number
    try {
      const body = JSON.parse(raw.toString('utf8') || '{}') as { amount_usd?: unknown }
      amountUsdc = parseUsdToUsdc(String(body.amount_usd ?? ''))
    } catch {
      sendError(res, 400, 'invalid_request_error', 'invalid_amount', 'Send {"amount_usd": "<USD amount>"}')
      return
    }
    if (amountUsdc < topup.minUsdc || amountUsdc > topup.maxUsdc) {
      sendError(res, 400, 'invalid_request_error', 'invalid_amount',
        `Top-ups must be between ${formatUsdc(topup.minUsdc)} and ${formatUsdc(topup.maxUsdc)}`)
      return
    }

    const asset = await topup.asset()
    const requirements = buildPaymentRequirements(asset, payTo, amountUsdc)
    const proto = firstHeader(req.headers['x-forwarded-proto']) || 'http'
    const resource = {
      url: `${proto}://${req.headers.host ?? 'localhost'}${TOPUP_PATH}`,
      description: `Add ${formatUsdc(amountUsdc)} of credits to API key ${key.id}`,
      mimeType: 'application/json',
    }
    const paymentRequired = (error: string): void => {
      const body: PaymentRequired = { x402Version: X402_VERSION, error, resource, accepts: [requirements] }
      res.setHeader(PAYMENT_REQUIRED_HEADER, encodeHeaderJson(body))
      sendJson(res, 402, body)
    }

    const signature = firstHeader(req.headers[PAYMENT_SIGNATURE_HEADER])
    if (!signature) {
      paymentRequired('PAYMENT-SIGNATURE header is required')
      return
    }
    const payment = decodeHeaderJson<PaymentPayload>(signature)
    if (!payment) {
      sendError(res, 400, 'invalid_request_error', 'invalid_payload', 'PAYMENT-SIGNATURE is not base64-encoded JSON')
      return
    }
    const localError = checkPaymentPayload(payment, requirements, asset, Math.floor(Date.now() / 1000))
    if (localError) {
      paymentRequired(localError)
      return
    }
    const settled = await this._settleTopup(topup, payment, requirements)
    if (!settled.success) {
      this._notifyTopup('rejected', amountUsdc)
      this._log(`gateway top-up failed: key=${key.id} reason=${settled.errorReason ?? 'unknown'}`)
      res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeaderJson(settled))
      paymentRequired(settled.errorReason ?? 'unexpected_settle_error')
      return
    }

    const authorization = payment.payload.authorization
    // The USDC has already moved; a failed bookkeeping write must not turn
    // the settled payment into an error the client would retry.
    try {
      this._options.store.recordLedgerEntry({
        kind: 'credit',
        keyId: key.id,
        buyerIdentity: key.buyerIdentity,
        amountUsdc,
        externalRef: `x402:${requirements.network}:${authorization.nonce.toLowerCase()}`,
        note: `x402 top-up from ${settled.payer || authorization.from}, tx ${settled.transaction}`,
        createdAt: Date.now(),
      })
    } catch (error) {
      this._log(`gateway top-up settled but NOT recorded in the ledger: key=${key.id} amount=${formatUsdc(amountUsdc)} tx=${settled.transaction}: ${errorMessage(error)}`)
    }
    this._notifyTopup('settled', amountUsdc)
    this._log(`gateway top-up: key=${key.id} identity=${key.buyerIdentity} amount=${formatUsdc(amountUsdc)} tx=${settled.transaction}`)
    res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeaderJson(settled))
    sendJson(res, 200, {
      data: {
        topped_up_usd: usdcToDecimalString(amountUsdc),
        buyer_address: requirements.payTo,
        transaction: settled.transaction,
        network: settled.network,
        payer: settled.payer || authorization.from,
        // The buyer sweeps the wallet into its deposits on its next check.
        credits_available: 'within about a minute',
      },
    })
  }

  private _notifyTopup(outcome: 'settled' | 'rejected', amountUsdc: number): void {
    try {
      this._options.onTopupOutcome?.(outcome, amountUsdc)
    } catch {
      // Telemetry never changes a top-up.
    }
  }

  private async _settleTopup(topup: GatewayTopupOptions, payment: PaymentPayload, requirements: PaymentRequirements) {
    const failure = (errorReason: string) => ({
      success: false, errorReason, transaction: '', network: requirements.network, payer: payment.payload.authorization.from,
    })
    try {
      const verified = await topup.facilitator.verify(payment, requirements)
      if (!verified.isValid) return failure(verified.invalidReason ?? 'unexpected_verify_error')
      return await topup.facilitator.settle(payment, requirements)
    } catch (error) {
      this._log(`gateway facilitator error: ${errorMessage(error)}`)
      return failure('unexpected_settle_error')
    }
  }

  private async _keyInfo(key: ApiKeyRecord) {
    const spent = this._options.store.spendByPeriod({ keyId: key.id })
    const usage = this._options.store.usageStats(key.id)
    const buyerAddress = await this._options.identityAddress(key.buyerIdentity).catch(() => null)
    // The caps admission enforces: the lower of the admins' and the owner's.
    const caps = effectiveKeyLimits(key)
    const limits = Object.fromEntries(BUDGET_PERIODS.map((period) => {
      const limit = caps[period]
      return [period, {
        limit_usd: optionalUsdcToDecimalString(limit),
        spent_usd: usdcToDecimalString(spent[period]),
        remaining_usd: optionalUsdcToDecimalString(limit === null ? null : Math.max(0, limit - spent[period])),
      }]
    }))
    return {
      id: key.id,
      label: key.label,
      created_at: new Date(key.createdAt).toISOString(),
      expires_at: key.expiresAt === null ? null : new Date(key.expiresAt).toISOString(),
      // Whether POST /v1/key/topup accepts payments for this key.
      topup_enabled: key.topupEnabled && key.buyerIdentity !== DEFAULT_BUYER_IDENTITY && Boolean(this._options.topup),
      // The wallet that pays sellers for this key's requests.
      buyer_address: buyerAddress,
      usage: {
        requests: usage.requests,
        spent_usd: usdcToDecimalString(usage.spentUsdc),
        topped_up_usd: usdcToDecimalString(usage.creditedUsdc),
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        output_tokens: usage.outputTokens,
      },
      limits,
    }
  }
}

/**
 * 402 is the status a client-facing payment flow will answer with, so a key
 * that hits its cap already gets the shape a top-up offer can extend.
 */
export function spendLimitError(breach: LimitBreach) {
  const label = breach.period === 'total' ? 'lifetime' : breach.period
  const level = breach.level ?? 'key'
  const remaining = Math.max(0, breach.limitUsdc - breach.spentUsdc)
  return {
    type: 'insufficient_quota',
    code: 'spend_limit_reached',
    message: spendLimitMessage(budgetHolder(level), label, breach, remaining),
    limit: {
      level,
      period: breach.period,
      limit_usd: usdcToDecimalString(breach.limitUsdc),
      spent_usd: usdcToDecimalString(breach.spentUsdc),
      remaining_usd: usdcToDecimalString(remaining),
      held_usd: usdcToDecimalString(breach.heldUsdc),
      resets_at: breach.resetsAt === null ? null : new Date(breach.resetsAt).toISOString(),
    },
  }
}

/**
 * A limit is also refused before it is spent: requests still running (or not yet charged) hold up to
 * the per-request maximum each, so a small cap can be full while little is spent. Say so, with what is left.
 */
function spendLimitMessage(holder: string, label: string, breach: LimitBreach, remaining: number): string {
  const limit = formatUsdc(breach.limitUsdc)
  if (remaining === 0) return `${holder} reached its ${label} spend limit of ${limit}.`
  const held = breach.heldUsdc > 0
    ? `, and requests still running or not yet charged may use up to ${formatUsdc(breach.heldUsdc)} of it`
    : ''
  return `${holder} has ${formatUsdc(remaining)} left of its ${label} spend limit of ${limit} (${formatUsdc(breach.spentUsdc)} spent)${held}. `
    + 'The next request could cost more than what is left, so it was not sent. Try again once running requests are charged, or raise the limit.'
}

function budgetHolder(level: NonNullable<LimitBreach['level']>): string {
  if (level === 'key') return 'This API key'
  if (level === 'member') return 'The member who owns this API key'
  return 'This API key\'s workspace'
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sendError(res: http.ServerResponse, status: number, type: string, code: string, message: string): void {
  sendJson(res, status, { error: { message, type, code } })
}

function sendUnauthorized(res: http.ServerResponse, code: string, message: string): void {
  res.setHeader('www-authenticate', 'Bearer')
  sendError(res, 401, 'authentication_error', code, message)
}

/** The request body, or null once it exceeds MAX_BODY_BYTES (the rest is drained, not kept). */
async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume()
    return null
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer)
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks)
}

function sendBodyTooLarge(res: http.ServerResponse): void {
  sendError(res, 413, 'invalid_request_error', 'request_too_large', `Request bodies are limited to ${MAX_BODY_BYTES / 1024 / 1024} MiB`)
}

/** A JSON object body, or null (empty, not JSON, not an object). */
function parseJsonBody(body: Buffer, contentType: string | undefined): Record<string, unknown> | null {
  if (body.length === 0) return null
  if (contentType && !contentType.includes('json')) return null
  try {
    return jsonObject(JSON.parse(body.toString('utf8')))
  } catch {
    return null
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Error code and message of a failed response: the OpenAI/Anthropic envelope
 * (`{ error: { code | type, message } }`, `{ error: "…" }`), a top-level
 * `{ code, message }`, or the start of a non-JSON body.
 */
export function parseErrorBody(body: Buffer, status: number): RequestError {
  const text = body.subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8').trim()
  const fallback = `http_${status}`
  const clip = (value: string | null): string | null => value ? value.slice(0, MAX_ERROR_MESSAGE_CHARS) : null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { code: fallback, message: clip(text.replace(/\s+/g, ' ')) }
  }
  const pick = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
  const root = jsonObject(parsed) ?? {}
  const envelope = root['error']
  if (typeof envelope === 'string') return { code: pick(root['code']) ?? fallback, message: clip(envelope) }
  const inner = jsonObject(envelope) ?? root
  return {
    code: (pick(inner['code']) ?? pick(inner['type']) ?? fallback).slice(0, 100),
    message: clip(pick(inner['message']) ?? pick(root['message']) ?? pick(root['detail'])),
  }
}

/** Keeps the first `maxBytes` (or so) of a stream as it flows past. */
function collectPrefix(stream: http.IncomingMessage, maxBytes: number): Buffer[] {
  const chunks: Buffer[] = []
  let bytes = 0
  stream.on('data', (chunk: Buffer) => {
    if (bytes >= maxBytes) return
    chunks.push(chunk)
    bytes += chunk.length
  })
  return chunks
}

/** Feeds a successful model response to a usage reader as it streams; a reader error only stops reading. */
function readUsage(stream: http.IncomingMessage, log: (message: string) => void): ResponseUsageReader {
  const reader = new ResponseUsageReader(firstHeader(stream.headers['content-type']))
  const onData = (chunk: Buffer): void => {
    try {
      reader.push(chunk)
    } catch (error) {
      stream.off('data', onData)
      log(`gateway could not read response usage: ${errorMessage(error)}`)
    }
  }
  stream.on('data', onData)
  return reader
}

/** The buyer's own latency measurement, when it sent a usable one. */
/**
 * Whether the seller's advertised prices (the buyer's pricing headers) are
 * all zero: a free seller, for which the buyer never reports spend. Unknown
 * input or output prices are not free.
 */
function freeSellerPricing(headers: http.IncomingHttpHeaders): boolean {
  const price = (name: string): number | null => {
    const value = firstHeader(headers[name])
    const amount = Number(value)
    return value && Number.isFinite(amount) ? amount : null
  }
  const cached = price('x-antseed-cached-input-usd-per-million')
  return price('x-antseed-input-usd-per-million') === 0 && price('x-antseed-output-usd-per-million') === 0 && (cached === null || cached === 0)
}

/** Answers with fewer output tokens say little about generation speed (the buyer ranks by the same rule). */
const MIN_SPEED_OUTPUT_TOKENS = 20

function outputTokensPerSecond(outputTokens: number, streamMs: number): number | null {
  return outputTokens >= MIN_SPEED_OUTPUT_TOKENS && streamMs > 0 ? Math.round((outputTokens / (streamMs / 1000)) * 10) / 10 : null
}

/** The routing service that ranked a request, from the buyer's router headers; null when none did. */
function routerHeaders(headers: http.IncomingHttpHeaders): RequestRouter | null {
  const peerId = firstHeader(headers[ROUTER_PEER_ID_HEADER]).trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(peerId)) return null
  const rank = Number(firstHeader(headers[ROUTER_RANK_HEADER]))
  return {
    peerId,
    service: firstHeader(headers[ROUTER_SERVICE_HEADER]).slice(0, 200) || null,
    rank: Number.isSafeInteger(rank) && rank > 0 ? rank : null,
  }
}

function latencyHeader(value: string): number | null {
  const latency = Number(value)
  return value && Number.isFinite(latency) && latency >= 0 ? Math.floor(latency) : null
}

/**
 * Client headers never forwarded: the gateway sets its own `host` and
 * `content-length`, and the key (never the client) decides who pays, how
 * spend is tagged and which sellers may serve.
 */
const STRIPPED_HEADERS = new Set([
  'host',
  'content-length',
  SPEND_ATTRIBUTION_HEADER,
  BUYER_IDENTITY_HEADER,
  MAX_VIDEO_COST_HEADER,
  ROUTING_POLICY_HEADER,
  GATEWAY_CONTROL_HEADER,
  GATEWAY_INTERNAL_KEY_HEADER,
  END_USER_HEADER,
  // Proxy-internal hooks for the local verifier; a key holder must not choose them.
  'x-antseed-request-id',
  'x-antseed-capture-response-auth-preimages',
])

/** Client headers passed on to the buyer, minus everything the key (not the client) decides. */
function forwardedHeaders(incoming: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(incoming)) {
    const normalized = name.toLowerCase()
    // The client's key authenticated it to this gateway; its other
    // credentials are never needed downstream (see credential-headers.ts).
    if (isClientCredentialHeader(normalized) || STRIPPED_HEADERS.has(normalized)) continue
    if (normalized.startsWith('x-forwarded-') || HOP_BY_HOP.has(normalized)) continue
    // The key, not the client's page, decides access; the buyer refuses
    // requests that look like they came from a web page.
    if (isBrowserContextHeader(normalized)) continue
    headers[name] = value
  }
  return headers
}

function truncateContent(body: Buffer): string {
  return body.subarray(0, MAX_LOGGED_CONTENT_BYTES).toString('utf8')
}

/** Whether a policy says anything the buyer must apply (the gateway enforces `allowedModels` itself). */
function restrictsSellers(policy: RoutingPolicy): boolean {
  return Object.keys(policy).some((field) => field !== 'allowedModels' && field !== 'sort' && field !== 'preferFreePeers')
}

function tunnelRequestSource(headers: http.IncomingHttpHeaders): string {
  const originator = normalizeSource(firstHeader(headers.originator))
  if (originator) return originator.startsWith('cursor') ? 'cursor' : originator

  if (Object.keys(headers).some((name) => name.toLowerCase().startsWith('x-cursor-'))) {
    return 'cursor'
  }

  const userAgent = firstHeader(headers['user-agent']).trim()
  const product = normalizeSource(userAgent.split(/[/\s]/, 1)[0] ?? '')
  return product.startsWith('cursor') ? 'cursor' : 'public-tunnel'
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function normalizeSource(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

/** A `/v1/models` listing without the models the policy does not allow (matched by id or alias). */
function filterModelList(body: Buffer, policy: RoutingPolicy): Buffer {
  let listing: { data?: unknown }
  try {
    listing = JSON.parse(body.toString('utf8')) as { data?: unknown }
  } catch {
    return body
  }
  if (!listing || !Array.isArray(listing.data)) return body
  listing.data = listing.data.filter((entry: { id?: unknown; aliases?: unknown }) => {
    const names = [entry?.id, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])]
    return names.some((name) => typeof name === 'string' && policyAllowsModel(policy, name))
  })
  return Buffer.from(JSON.stringify(listing), 'utf8')
}

function canonicalizeRoute(method: string, path: string): CanonicalRoute | null {
  const queryIndex = path.indexOf('?')
  const pathname = (queryIndex === -1 ? path : path.slice(0, queryIndex)).toLowerCase()
  const query = queryIndex === -1 ? '' : path.slice(queryIndex)
  const candidates = new Set([pathname])

  if (!pathname.startsWith('/v1/')) candidates.add(`/v1${pathname}`)
  if (pathname.startsWith('/v1/v1/')) candidates.add(pathname.slice(3))

  const route = ALLOWED_ROUTES.find((allowed) =>
    allowed.method === method && candidates.has(allowed.prefix),
  )
  return route ? { path: `${route.prefix}${query}`, prefix: route.prefix, paid: route.paid, local: route.local ?? false } : null
}
