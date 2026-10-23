/**
 * Buyer telemetry: one `buyer_request_finished` per proxied model request.
 * Desktop and standalone buyers send every request. A gateway's buyer carries
 * many users' traffic, so it sends only the requests that tell us something
 * about the journey (`journeyMoment`): the first answer of a session, every
 * failure or cancellation, a fallback to another seller, and the first answer
 * after a failure. Routine successes stay local. Only enums, buckets and
 * counts leave the process.
 *
 * The proxy tracks each request through a `RequestTrace`, found by its
 * `ServerResponse`, so the dispatch code needs no extra parameters.
 */
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
  ttftBucket,
  type BuyerHost,
  type FailureReason,
  type PostHogSender,
  type TelemetryClient,
} from '@antseed/telemetry'
import { CLI_EVENT_CATALOG, CLIENT_TOOLS, REQUEST_PROTOCOLS } from './catalog.js'
import { posthogConfig, resolveCliConsent } from './settings.js'
import { detectInstallMethod } from '../update/install-method.js'
import pkg from '../../package.json' with { type: 'json' }

export type RouteMode = 'auto' | 'pinned' | 'router'
export type SellerTier = 'free' | 'paid' | 'unknown'
export type RequestOutcome = 'success' | 'failed' | 'cancelled'

export type JourneyMoment = 'first_success' | 'failure' | 'cancelled' | 'fell_back' | 'recovered'
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

export function telemetryClientTool(tool: string | null | undefined): string {
  if (!tool) return 'none'
  const normalized = tool.trim().toLowerCase()
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
  private finished = false

  constructor(readonly startedAtMs: number, readonly peersKnownAtSend: boolean) {}

  noteAttempt(peerId: string): void {
    this.attempts += 1
    this.sellers.add(peerId.toLowerCase())
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
      ttft_bucket: ttftBucket(this.firstByteAtMs === null ? null : this.firstByteAtMs - this.startedAtMs),
      duration_bucket: requestDurationBucket(nowMs - this.startedAtMs),
      streamed: this.streamed,
    }
  }
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
  private _enabled: boolean
  private _succeededOnce = false
  private _lastFailed = false

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
      // A gateway's buyer runs on a server: its IP says where the team hosts, not where users are.
      geoip: this.buyerHost !== 'gateway',
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

  /** Starts tracing a model request; reports it once the response closes. */
  beginRequest(res: ServerResponse, peersKnown: boolean): RequestTrace | null {
    if (!this._enabled) return null
    const trace = new RequestTrace(this._now(), peersKnown)
    traces.set(res, trace)
    let clientAborted = false
    res.once('close', () => {
      if (!res.writableFinished) clientAborted = true
      const props = trace.finish(res.statusCode, clientAborted, this._now())
      if (props) this._record(props)
    })
    return trace
  }

  private _record(props: Record<string, unknown>): void {
    if (!this._enabled) return
    const moment = this.journeyMoment(props)
    if (this.buyerHost === 'gateway' && moment === null) return
    this._client.capture('buyer_request_finished', moment ? { ...props, journey_moment: moment } : props)
  }

  /**
   * Why this request matters for the user journey, or null for a routine
   * success. Gateway buyers send only requests with a moment.
   */
  journeyMoment(props: Record<string, unknown>): JourneyMoment | null {
    const outcome = props['outcome']
    if (outcome === 'failed') {
      this._lastFailed = true
      return 'failure'
    }
    if (outcome === 'cancelled') return 'cancelled'
    const recovered = this._lastFailed
    this._lastFailed = false
    if (!this._succeededOnce) {
      this._succeededOnce = true
      return 'first_success'
    }
    if (props['fell_back'] === true) return 'fell_back'
    return recovered ? 'recovered' : null
  }

  async close(timeoutMs = 750): Promise<void> {
    await this._client.close(timeoutMs)
  }
}
