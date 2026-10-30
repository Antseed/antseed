import { nativeVideoRoute, type NativeVideoProtocol } from '@antseed/api-adapter'
import { ResourceRoutes } from './resource-routes.js'
import { prepareVideoRequest, recordVideoAcceptance } from './native-video-proxy.js'
import { downloadVideo } from './video-download.js'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { buildRoutingServices, findPinnedRoutingService } from './routing-services.js'
import { readFileSync, watchFile, unwatchFile } from 'node:fs'
import { telemetryClientTool, telemetryProtocol, traceFor, type BuyerTelemetry, type ConversationKeySource, type SwitchReason } from '../telemetry/buyer.js'
import { finishReasonFromBody } from '../telemetry/finish-reason.js'
import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ANTSEED_BUYER_FAULT_ERROR_CODE,
  ANTSEED_FAULT_ATTRIBUTION_HEADER,
  ANTSEED_ATTEST_PATH,
  adaptPeerFaultErrorResponse,
  isFreeTierExhaustedResponse,
  computeTrustScore,
  decodeSweepRequest,
  faultAttributionOf,
  faultCodeOf,
  isModelRouteCoolingDown,
  isModelRouteEligible,
  modelRouteReputationScore,
  modelRouteTotalPrice,
  normalizedModelReputationScore,
  peerSupportsCooperativeClose,
  isRoutingSelection,
  DEFAULT_BUYER_IDENTITY,
  rankModelRoutes,
  SellerHealthBook,
  orderAdaptiveRoutes,
  adaptiveFirstTokenTimeoutMs,
  sanitizePeerDisplayName,
  type AntseedNode,
  type FaultAttribution,
  type BuyerSpendEvent,
  type ResponseAuthEvent,
  type AdaptiveRouteScore,
  type RouteRequestShape,
  type PeerInfo,
  type NetworkServiceOffer,
  type PeerMetadata,
  type ModelRoutingPreferences,
  type RequestStreamResponseMetadata,
  type Router,
  type RoutingSelection,
  type RoutingServiceTarget,
  type RouteRecommendation,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
  type SweepReceiptPayload,
  VIDEO_JOB_RETIRED_HEADER,
} from '@antseed/node'
import { encodeServedSelection, ROUTE_SELECTION_HEADER, type RouteSelection, type ServedSelection } from './route-selection.js'
import { canonicalModelKey } from '@antseed/node/model-identity'
import {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
  extractRequestBodyFields,
  type ServiceApiProtocol,
  type StreamingResponseAdapter,
  transformRequest,
  transformResponse,
} from './service-api-adapter.js'
import {
  DEBUG,
  log,
  extractRequestedService,
  summarizeRequestShape,
  summarizeErrorResponse,
  requestWantsStreaming,
  parsePeerPinnedService,
  rewritePeerPinnedServiceInBody,
  substituteRoutedModelAlias,
  overrideRoutedModelInBody,
  ROUTED_MODEL_ALIAS,
  SYSTEM_PROXY_SOURCE_HEADER,
  SYSTEM_ROUTED_MODEL_HEADER,
  BUYER_IDENTITY_HEADER,
  MAX_VIDEO_COST_HEADER,
  normalizePeerId,
  takeRoutingOptions,
  type RequestRoutingOptions,
} from './request-utils.js'
import { BuyerIdentityLoader } from '../buyer-identities/loader.js'
import {
  buildNetworkModels,
  effectiveModelReputationScore,
  parseModelTypeFilter,
  type NetworkRouterEntry,
} from './network-models.js'
import {
  findMissingRequiredParameters,
  findUnannouncedRequestParameters,
  findAdvertisedServiceOffer,
  findAdvertisedServiceProtocols,
  getExplicitProviderOverride,
  getExplicitPeerIdOverride,
  parseRequiredParametersHeader,
  REQUIRED_PARAMETERS_HEADER,
  resolvePeerRoutePlan,
  selectCandidatePeersForRouting,
  type CandidatePeerRouteSelection,
  type PeerProtocolRoutePlan,
} from './routing.js'
import {
  computeResponseTelemetry,
  attachAntseedTelemetryHeaders,
  ROUTER_PEER_ID_HEADER,
  ROUTER_RANK_HEADER,
  ROUTER_SERVICE_HEADER,
  withoutRouterHeaders,
  attachStreamingAntseedHeaders,
} from './telemetry.js'
import { DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS } from '../config/defaults.js'
import {
  extractConversationIdentity,
  requestClientTool,
  extractFirstUserSnippet,
  isCompletionRequestPath,
  isTitleGenerationRequest,
  parseRequestBodyObject,
  withUpstreamSessionHeader,
  type ConversationIdentity,
} from './conversation-identity.js'
import { ConversationStore, type ConversationRouterSelection, type StoredConversation } from './conversation-store.js'
import { eligibleRouterCandidates, executeRouterSelection, NoEligibleCandidatesError, requestForRecommendation, RoutingModelsCache } from './router-execution.js'
import { recordRouterUsage } from './routing-usage.js'
import { SPEND_ATTRIBUTION_DB_FILE, SPEND_ATTRIBUTION_HEADER, SpendAttributionFeed, parseSpendAttributionTag } from './spend-attribution.js'
import { DEPOSIT_WATCH_ACTIVE_TTL_MS, type DepositWatcher } from './deposit-watcher.js'
import { DepositLog, type DepositLogEntry } from './deposit-log.js'
import {
  recordPeerFailureEntry,
  clearPeerHealthEntry,
  isCoolingDown,
  parsePersistedPeerHealth,
  prunePeerHealth,
  serializePeerHealth,
  reasonEscalates,
  type PeerFailureReason,
  type PeerHealthEntry,
} from './peer-health.js'
import { PeerAttributionTracker, HEARTBEAT_MS } from './peer-attribution.js'
import { hasStreamError, isEmptyAnswer, isSellerVerificationFailure } from './response-quality.js'
import { estimateAnthropicPromptTokens, isCountTokensPath } from './count-tokens.js'
import { runVerifier, selectVerifier, verifierSupportFingerprint, type VerifierPolicy, type SellerReach, type VerifyOutcome } from '../plugins/verifier.js'
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status'
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { parseServiceFreeTierProgram } from '@antseed/node/free-tier-program'
import { TeeVerification } from './tee-verification.js'
import { TeeControl } from './tee-control.js'
import { ChainReadCache } from './chain-read-cache.js'
import { isClientCredentialHeader } from './credential-headers.js'
import { nonLocalRequestReason } from './local-request-guard.js'
import { loadConfig } from '../config/loader.js'
import { InvalidRouterOptionsError, ModelRoutingClient, routingClientAdapter, routingProtocolOfTarget, validateRouterOptions, type ModelRoutingClientApi } from '@antseed/router-core'
import {
  GATEWAY_CONTROL_HEADER,
  GATEWAY_CONTROL_SECRET_ENV,
  GATEWAY_CONTROL_SECRET_FILE,
  ROUTING_POLICY_HEADER,
  decodePolicyHeader,
  findModelRoute,
  meaningfulPolicy,
  narrowPolicy,
  normalizePeerId as normalizePolicyPeerId,
  policyAllowsModel,
  policyModelKey,
  type RoutingPolicy,
} from '../routing-policy/policy.js'
import {
  buyerConfigReason,
  buyerHardPolicy,
  buyerPreferencePolicy,
  orderByPolicy,
  pinnedPeerExclusionReasons,
  policyExclusionReasons,
  preferenceExclusionReasons,
  rankingPreferences,
  secretsMatch,
  routingServicePolicy,
  type PolicyPeerFacts,
} from './route-policy.js'

// Re-export for backward compatibility (used by tests and other consumers)
export { selectCandidatePeersForRouting, type CandidatePeerRouteSelection } from './routing.js'
export { parsePeerPinnedService, rewritePeerPinnedServiceInBody, substituteRoutedModelAlias, ROUTED_MODEL_ALIAS } from './request-utils.js'

/** On shutdown, requests in flight get this long to finish before their connections are closed. */
export const BUYER_SHUTDOWN_DRAIN_MS = 60_000

/** How long a graceful buyer shutdown may take before the process exits anyway: the proxy's drain, then the node. */
export const BUYER_SHUTDOWN_DEADLINE_MS = BUYER_SHUTDOWN_DRAIN_MS + 15_000

/**
 * Why this daemon runs no hot-wallet deposit watcher — surfaced on
 * `/_antseed/deposits/status` so UIs can name the actual cause instead of
 * guessing (a missing watcher used to be indistinguishable from "this chain
 * has no deposit relay").
 */
export type DepositWatcherAbsenceReason = 'external-daemon' | 'payments-disabled' | 'no-deposit-relay' | 'identity-not-watched'

const WATCHER_ABSENCE_ERRORS: Record<DepositWatcherAbsenceReason, string> = {
  'payments-disabled': 'Deposit watcher unavailable — payments are disabled on this buyer.',
  'no-deposit-relay': 'Deposit watcher unavailable — this chain has no deposit relay.',
  'external-daemon': 'Deposit watcher unavailable — another daemon owns the proxy port and runs the watcher.',
  'identity-not-watched': 'Deposit watcher unavailable — this buyer identity has no deposit watcher.',
}

export interface BuyerProxyConfig {
  /** Test seam; production uses the protocol-neutral routing client, which picks an adapter per routing protocol. */
  modelRoutingClient?: ModelRoutingClientApi
  port: number
  node: AntseedNode
  /** Data directory used to persist buyer.state.json (discovered peers, session peer pin). */
  dataDir: string
  /** Config file watched for live buyer.routingPreferences updates. */
  configPath?: string
  /** Price + trust preferences used for model-only automatic routing. */
  routingPreferences?: ModelRoutingPreferences
  /** How often to refresh the peer list from DHT in the background (ms). Default: 300000 (5 min) */
  backgroundRefreshIntervalMs?: number
  /**
   * Max age for the in-memory peer cache before it is treated as stale (ms).
   * Stale caches can still be used for routing while background refresh repopulates.
   * Default: at least 360000 (6 min), and always above `backgroundRefreshIntervalMs`,
   * so a healthy proxy never naturally reaches the "stale" threshold.
   */
  peerCacheTtlMs?: number
  /**
   * Pin all requests to a specific peer ID for this session.
   * The named peer is used directly if it is available, protocol-compatible,
   * and allowed by the buyer's pricing policy. A 502 is returned if the peer cannot be reached.
   */
  pinnedPeerId?: string
  /**
   * Clock used for peer-health bookkeeping. Injectable so tests can drive
   * failure spacing directly instead of sleeping past the coalesce window.
   */
  now?: () => number
  /** Spreading and probing in automatic routing. Test seam: tests turn both off for a deterministic order. */
  adaptiveRouting?: { random?: () => number; spreadTolerance?: number; explorationRate?: number }
  /** Verifier-SDK policy: which verifier the buyer commits to + whether it is required. */
  verifier?: VerifierPolicy
  /** Loads stored buyer identities on demand; defaults to one reading `dataDir`. */
  buyerIdentities?: BuyerIdentityLoader
  /** `buyer.minPeerReputation`, so gateway policies narrow under it (also enforced by the router plugin). */
  minPeerReputation?: number
  /** Chain reads behind `GET /_antseed/balances`; absent when payments are disabled. */
  balanceReader?: BuyerBalanceReader
  /**
   * Runs `buyer start`'s graceful shutdown for `POST /_antseed/restart`. The
   * handler exits the process (code 75) once shutdown completes.
   */
  onRestartRequested?: () => void | Promise<void>
  /**
   * `POST /_antseed/restart` is refused (429) this soon after the proxy
   * started, so restart requests cannot keep the buyer bouncing. Default 30 s.
   */
  minRestartIntervalMs?: number
  /**
   * Settings this buyer took from the environment or `buyer start` flags
   * rather than the config file (see `buyerSettingOverrides`), reported to
   * the gateway so its settings page can say a config edit will not apply.
   */
  settingOverrides?: string[]
  /** Anonymous request telemetry (docs/telemetry.md); absent sends nothing. */
  telemetry?: BuyerTelemetry
}

/** The DepositsClient reads `GET /_antseed/balances` needs. */
export interface BuyerBalanceReader {
  getBuyerBalance(address: string): Promise<{ available: bigint; reserved: bigint }>
  getBuyerCreditLimit(address: string): Promise<bigint>
  getOperator(address: string): Promise<string>
  getUSDCBalance(address: string): Promise<bigint>
  /** Drop cached reads for the address (a `fresh=1` request). */
  invalidate?(address: string): void
  /** Whether the last reads for the address fell back to cached data. */
  isStale?(address: string): boolean
}

export interface BuyerBalances {
  address: string
  available: string
  reserved: string
  walletUsdc: string | null
  creditLimit: string | null
  operator: string | null
  /** Present (true) when the chain could not be read and these are the last known values. */
  stale?: boolean
}

/** Exit code `POST /_antseed/restart` ends the process with, so a supervisor restarts it. */
export const BUYER_RESTART_EXIT_CODE = 75
const MIN_RESTART_INTERVAL_MS = 30_000
const BALANCE_CACHE_TTL_MS = 15_000
/** A balance up to this much past its TTL is answered at once while it refreshes. */
const BALANCE_REVALIDATE_MS = 45_000
/** `fresh=1` re-reads the chain at most this often per address. */
const BALANCE_FRESH_FLOOR_MS = 5_000
const CONTROL_SECRET_RECHECK_MS = 1_000
/** Floor between forced re-reads on a secret mismatch, so a stream of bad secrets can't hammer the disk. */
const CONTROL_SECRET_FORCED_RECHECK_MS = 100
const SELLER_HEALTH_PERSIST_DELAY_MS = 5_000
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'


/** Exact USDC decimal string from base units, e.g. 1500000n -> "1.500000". */
function formatUsdcBaseUnits(amount: bigint): string {
  const sign = amount < 0n ? '-' : ''
  const abs = amount < 0n ? -amount : amount
  return `${sign}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')}`
}

/** One seller considered for a model, with why it is (in)eligible. Shared by routing and route previews. */
interface ModelRouteVerdict {
  peer: PeerInfo
  serviceId: string
  offer: NetworkServiceOffer
  eligible: boolean
  /** 1-based dispatch order for eligible sellers. */
  rank: number | null
  reasons: string[]
  /** Eligible sellers: the numbers automatic routing ranked it by. */
  selection?: RouteSelection
}

interface RoutePreviewCandidate {
  peerId: string
  displayName: string | null
  rank: number | null
  eligible: boolean
  reasons: string[]
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  trustScore: number | null
  selection: RouteSelection | null
}

type RequestPolicyResult =
  | { kind: 'none' }
  | { kind: 'policy'; policy: RoutingPolicy }
  | { kind: 'invalid' }
  /** The control header was sent but does not match: fail closed, never route. */
  | { kind: 'auth_invalid' }

/** Image generation, image edits and decision models (SystemOne): model requests outside a chat, reported like any other. */
function isImageOrDecisionRequest(method: string, request: Pick<SerializedHttpRequest, 'path' | 'headers'>): boolean {
  if (method !== 'POST') return false
  const protocol = detectRequestServiceApiProtocol(request)
  return protocol === 'openai-images' || protocol === 'typesafe-systemone'
}

function isLoopbackAddress(address: string | undefined): boolean {
  // A destroyed socket has no address: never treat it as local.
  if (address === undefined) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

// 401/403 are included: sellers relay upstream auth failures (revoked or
// expired key, region/WAF block) that are specific to that seller's upstream
// account, so another peer serving the same model can usually complete the
// request. 402 stays terminal (buyer payment flow), and 404 stays terminal
// because model_not_found already has dedicated unadvertise handling while a
// generic 404 would repeat identically on every peer.
const RETRYABLE_STATUS_CODES = new Set([401, 403, 408, 429, 500, 502, 503, 504])
// Moving to another recommendation is a new purchase, so skip timeouts (408/504), where the seller may already have done the work.
const RECOMMENDATION_FALLBACK_STATUS_CODES = new Set([401, 403, 429, 500, 502, 503])
/**
 * Gateway-policy requests on automatic routing also move on after a 402: the
 * buyer could not fund that seller (no deposits for its reserve), but a free
 * seller needs none. Other requests keep the 402, as they always have.
 */
const GATEWAY_AUTO_ROUTE_RETRYABLE_STATUS_CODES = new Set([...RETRYABLE_STATUS_CODES, 402])

function retryableStatusCodesFor(gatewayAutoRoute: boolean): Set<number> {
  return gatewayAutoRoute ? GATEWAY_AUTO_ROUTE_RETRYABLE_STATUS_CODES : RETRYABLE_STATUS_CODES
}

/**
 * Whether the routing loop should try the next seller. On automatic routing a
 * seller's model_not_found also moves on: its cached catalog was stale (the
 * seller stopped serving the model), and another seller may still serve it.
 * `extraAttempt` also moves on after any other 4xx except 402: a client error
 * may be the seller's doing (it refuses a parameter other sellers of the
 * model accept) or the request's, and only another seller can
 * tell which. A pinned request keeps the pinned seller's answer.
 */
function shouldTryNextPeer(
  statusCode: number,
  modelNotFound: boolean,
  pinned: boolean,
  gatewayAutoRoute: boolean,
  extraAttempt = false,
): boolean {
  return retryableStatusCodesFor(gatewayAutoRoute).has(statusCode)
    || (modelNotFound && !pinned)
    || (extraAttempt && !pinned && statusCode >= 400 && statusCode < 500 && statusCode !== 402)
}

type FailedAttempt = {
  description: string
  /**
   * Only the seller can cause this (a 5xx, an upstream auth failure, a
   * dropped request): it counts even when no other seller serves the request.
   * Other failures (a client error, an empty answer) may be the request's and
   * count only when another seller then serves it.
   */
  sellerOnly: boolean
  weight: number
}

function classifyFailedAttempt(result: DispatchFailure): FailedAttempt {
  if (result.emptyAnswer) return { description: 'answered with no text or tool call', sellerOnly: false, weight: 1 }
  if (result.timedOut) return { description: result.errorMessage ?? 'no answer in time', sellerOnly: true, weight: 0.5 }
  if (result.errorMessage) return { description: `request failed (${result.errorMessage.split('\n')[0]!.slice(0, 120)})`, sellerOnly: true, weight: 1 }
  // Busy is not broken: it costs the seller less, and only when another seller served.
  if (result.statusCode === 429) return { description: 'HTTP 429 (busy)', sellerOnly: false, weight: 0.5 }
  const sellerOnly = result.statusCode >= 500 || result.statusCode === 401 || result.statusCode === 403 || result.statusCode === 408
  return { description: `HTTP ${result.statusCode}`, sellerOnly, weight: 1 }
}

/**
 * The client's own prompt-cache key (OpenAI `prompt_cache_key`), which asks
 * for requests sharing it to land where their cache is.
 */
function promptCacheKey(request: SerializedHttpRequest): string | null {
  const value = extractRequestBodyFields(request.headers, request.body)?.['prompt_cache_key']
  return typeof value === 'string' && value.trim() ? `cache:${value.trim().slice(0, 256)}` : null
}

/**
 * For telemetry: what the conversation's key came from. A tool's own session
 * id (in a header or its metadata), the client's `prompt_cache_key` alone, or
 * a hash of the conversation's opening, for a client that sends neither.
 */
function conversationKeySource(
  identity: ConversationIdentity,
  headers: Record<string, string>,
  body: Record<string, unknown> | null,
): ConversationKeySource {
  if (identity.sessionKey.startsWith('synthetic-')) return 'prompt_prefix'
  const sessionHeader = Object.entries(headers).some(([name, value]) => typeof value === 'string' && value.trim() === identity.sessionKey
    && /^(?:x-.+-session-id|thread-id|session-id|x-session-id|x-session-affinity)$/i.test(name))
  const cacheKey = body?.['prompt_cache_key']
  return !sessionHeader && typeof cacheKey === 'string' && cacheKey.trim() === identity.sessionKey ? 'prompt_cache_key' : 'tool_session'
}

/**
 * Size of a request, for weighing a seller's price against its speed: input
 * from the body size (~4 bytes a token), output from the requested cap.
 */
function requestShape(request: SerializedHttpRequest): RouteRequestShape {
  const fields = extractRequestBodyFields(request.headers, request.body)
  const cap = [fields?.['max_tokens'], fields?.['max_completion_tokens'], fields?.['max_output_tokens']]
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  return {
    inputTokens: Math.round(request.body.length / 4),
    outputTokens: Math.min(cap ?? 400, 2_000),
  }
}
const MODEL_RATE_LIMIT_MAX_ATTEMPTS_PER_PEER = 3
const MODEL_RATE_LIMIT_RETRY_DELAYS_MS = [250, 750] as const
const MODEL_RATE_LIMIT_MAX_RETRY_AFTER_MS = 2_000

function rateLimitRetryDelayMs(headers: Record<string, string>, retryIndex: number): number {
  const retryAfter = headers['retry-after'] ?? headers['Retry-After']
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MODEL_RATE_LIMIT_MAX_RETRY_AFTER_MS, Math.round(seconds * 1_000))
    }
  }
  return MODEL_RATE_LIMIT_RETRY_DELAYS_MS[retryIndex] ?? MODEL_RATE_LIMIT_RETRY_DELAYS_MS.at(-1)!
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timeout)
      resolve(false)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A routed-model target is either a bare `<service>` (automatic peer
 * selection) or an explicit `<peerId>@<service>` pin. The `antseed` alias
 * itself can never be a target — it would recurse.
 */
function isValidRoutedModelTarget(value: string): boolean {
  if (value === ROUTED_MODEL_ALIAS) return false
  return !value.includes('@') || parsePeerPinnedService(value) !== null
}

function sameRoutingServiceTarget(a: RoutingServiceTarget | undefined, b: RoutingServiceTarget | undefined): boolean {
  return !!a && !!b && a.peerId.toLowerCase() === b.peerId.toLowerCase()
    && a.provider === b.provider && a.serviceId === b.serviceId
}

/** Returns `request` with its body's model field rewritten to `serviceId`, or unchanged if nothing rewrote. */
function withRoutedModel(request: SerializedHttpRequest, serviceId: string): SerializedHttpRequest {
  const rewritten = overrideRoutedModelInBody(request.body, request.headers, serviceId)
  return rewritten.overridden
    ? { ...request, body: rewritten.body, headers: rewritten.headers }
    : request
}

function peerAllowedByPolicy(
  policyRouter: BuyerPolicyRouter | null | undefined,
  request: SerializedHttpRequest,
  peer: PeerInfo,
): boolean {
  if (policyRouter?.allowsPeerForPolicy) return policyRouter.allowsPeerForPolicy(request, peer)
  if (policyRouter?.allowsPeerForPricing) return policyRouter.allowsPeerForPricing(request, peer)
  return true
}

/**
 * Appends the buyer-level exclusion reasons, labelled as buyer config, that
 * the gateway level did not already report (in either form).
 */
function addBuyerConfigReasons(reasons: string[], buyerReasons: readonly string[]): void {
  for (const reason of buyerReasons) {
    const labelled = buyerConfigReason(reason)
    if (!reasons.includes(reason) && !reasons.includes(labelled)) reasons.push(labelled)
  }
}

/**
 * Why a route candidate's effective trust is below its seller's score: the
 * only penalty (`effectiveModelReputationScore`) halves a paid seller that
 * lists no cached-input price for a model other sellers price cache reads on.
 */
function trustPenalty(candidate: { reputation: number; effectiveReputationScore: number | null }): string | null {
  const effective = candidate.effectiveReputationScore
  if (candidate.reputation < 0 || effective === null || effective >= candidate.reputation) return null
  return `halved from ${Math.round(candidate.reputation)}: no cached-input price listed`
}

function isControlPlaneServicesPath(path: string): boolean {
  return path.toLowerCase().startsWith('/v1/models')
}

function isRouterSuccess(statusCode: number, path: string, retryableStatusCodes: Set<number>): boolean {
  // A 402 is the buyer's own funding gap, never the seller's failure.
  return isControlPlaneServicesPath(path) || statusCode === 402 || !retryableStatusCodes.has(statusCode)
}

/**
 * Detect a "model not served" rejection: the seller's own pre-payment 400
 * (`error.code: 'model_not_found'`, sent when the requested model is not in
 * its advertised services — e.g. its health checker just unadvertised it) or
 * an upstream 404 with the same code. Routing treated these as successes,
 * so a peer that stopped serving a model kept its healthy routing stats and
 * the stale peer cache kept offering the model indefinitely.
 */
export function isModelNotFoundResponse(response: SerializedHttpResponse): boolean {
  if (response.statusCode !== 400 && response.statusCode !== 404) return false
  try {
    const parsed = JSON.parse(Buffer.from(response.body).toString('utf-8')) as { error?: { code?: unknown } }
    return parsed?.error?.code === 'model_not_found'
  } catch {
    return false
  }
}

/**
 * Max age for carrying forward peers not seen in the latest DHT scan.
 * Intentionally longer than `peer-lookup.ts` `maxAnnouncementAgeMs` (30 min) so
 * a peer that misses one reannounce cycle doesn't hit both cliffs at once.
 * For peers we have recently reached over the transport, we trust local
 * liveness (`lastReachedAt`) even if the DHT record is older.
 */
const CARRY_FORWARD_TTL_MS = 2 * 60 * 60_000
/**
 * Seller-announced catalog fields. Explicit tracking ensures stale catalog
 * (for example after health checks hide all models) is cleared on the next
 * peer refresh.
 */
const PEER_CATALOG_FIELDS = [
  'providerPricing',
  'providerServiceCategories',
  'providerServiceApiProtocols',
  'providerServiceUnitBillingModels',
  'providerServiceCapabilities',
] as const satisfies readonly (keyof PeerInfo)[]
/**
 * Requests kept in the spend-attribution map. Entries outlive their request on
 * purpose (a seller-initiated auth can land after the response), so this is
 * sized for in-flight plus recently-finished traffic, not for concurrency.
 */
const MAX_TRACKED_REQUEST_CONVERSATIONS = 512
/** Min gap between background peer refreshes triggered by model_not_found responses. */
const MODEL_NOT_FOUND_REFRESH_THROTTLE_MS = 30_000

/**
 * Statuses that prove the peer is alive and serving. Any response short of a
 * server error counts: a peer that answers 400 or 404 is reachable, and
 * treating only 2xx as proof would leave a stale cooldown on a healthy peer
 * that happens to reject every request.
 */
function isProofOfLife(statusCode: number): boolean {
  return statusCode < 500 && statusCode !== 408
}

/**
 * Map a seller's response status onto a health reason, or null when the status
 * says nothing about the peer's liveness.
 */
function failureReasonForStatus(statusCode: number): PeerFailureReason | null {
  if (statusCode === 408) return 'seller-timeout'
  // Rate limiting is capacity pressure, not death — recorded, never escalated.
  if (statusCode === 429) return 'seller-busy'
  if (statusCode >= 500 && statusCode <= 599) return 'seller-5xx'
  return null
}

function responseFaultAttribution(response: SerializedHttpResponse): FaultAttribution {
  const attribution = response.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER]?.toLowerCase()
  return attribution === 'buyer' || attribution === 'peer' || attribution === 'unknown'
    ? attribution
    : 'peer'
}

type BuyerPolicyRouter = Router & {
  allowsPeerForPolicy?: (req: SerializedHttpRequest, peer: PeerInfo) => boolean
  allowsPeerForPricing?: (req: SerializedHttpRequest, peer: PeerInfo) => boolean
  /** Why `allowsPeerForPolicy` rejects the peer (null when allowed); optional. */
  explainPolicyRejection?: (req: SerializedHttpRequest, peer: PeerInfo) => string | null
}

/** Request-local inputs shared by direct inference and recommendation-based dispatch. */
type BuyerDispatchContext = {
  request: SerializedHttpRequest
  requiredParameters: readonly string[]
  requestPolicy: RoutingPolicy | null
  signal: AbortSignal
  systemRoutedModel: boolean
  conversationIdentity: ConversationIdentity | null
  conversationBody: Record<string, unknown> | null
  storedConversation: StoredConversation | null
  effectivePinnedPeer: string | null
  effectiveRoutedModel: string | null
  chatPinnedModel: string | null
  preferredConversationPeerId: string | null
  routingConversationKey: string | null
  /** Gateway spend tag of the client request; router purchases and attempts get new IDs and inherit it. */
  spendAttributionTag: string | null
}

type PeerDispatchResult =
  /**
   * `emptyAnswer`: the answer sent to the client had no text and no tool call.
   * `interrupted`: the answer never completed (a stream broke after its headers,
   * or the client went away), so it is no proof the seller served the request;
   * the value says whose side the break was on.
   */
  | { done: true; emptyAnswer?: boolean; interrupted?: 'seller' | 'buyer' | 'cancelled' }
  | {
    done: false; statusCode: number; responseBody: Buffer; responseHeaders: Record<string, string>; errorMessage: string | null
    /** The seller no longer serves the model: a stale catalog entry, not a rejected request. */
    modelNotFound?: boolean
    /** A 2xx answer with no text and no tool call, held back so another seller can be asked. */
    emptyAnswer?: boolean
    /** Given up on after the per-attempt timeout: slow, not necessarily broken. */
    timedOut?: boolean
  }

type DispatchFailure = Extract<PeerDispatchResult, { done: false }>

function dispatchFailure(statusCode: number, responseHeaders: Record<string, string>, body: string): DispatchFailure {
  return { done: false, statusCode, responseHeaders, responseBody: Buffer.from(body), errorMessage: null }
}

function writeDispatchFailure(res: ServerResponse, result: DispatchFailure): void {
  if (res.headersSent || res.writableEnded) return
  traceFor(res)?.noteFailure(result)
  // A refusal can carry the seller's own headers: never let it name a router.
  res.writeHead(result.statusCode, withoutRouterHeaders(result.responseHeaders))
  res.end(result.responseBody)
}

function isBuyerFault(result: DispatchFailure): boolean {
  return result.responseHeaders[ANTSEED_FAULT_ATTRIBUTION_HEADER]?.toLowerCase() === 'buyer'
}

type RouterSelection = Extract<RoutingSelection, { kind: 'router' }>
type DefaultRouterSelection = RouterSelection & { service: RoutingServiceTarget }

type ProtocolTransformStrategy = {
  from: ServiceApiProtocol
  to: ServiceApiProtocol
}

function adaptOpenAICompatibleErrorResponse(
  response: SerializedHttpResponse,
  requestProtocol: ServiceApiProtocol | null,
): SerializedHttpResponse {
  if (response.statusCode !== 402) {
    return response;
  }
  if (
    requestProtocol !== 'openai-responses'
    && requestProtocol !== 'openai-chat-completions'
    && requestProtocol !== 'openai-images'
  ) {
    return response;
  }

  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(Buffer.from(response.body).toString('utf-8')) as Record<string, unknown>
  } catch {
    return response
  }

  if (!parsed || parsed.error !== 'payment_required') {
    return response
  }

  // Wrap into standard OpenAI error format { error: { type, message, ... } }.
  // Exclude the flat 'error' string field to avoid polluting the nested error object.
  const { error: _errorField, ...rest } = parsed
  const wrappedError = {
    error: {
      ...rest,
      type: 'payment_required',
      message: JSON.stringify(parsed),
    },
  }

  return {
    ...response,
    headers: {
      ...response.headers,
      'content-type': 'application/json',
    },
    body: Buffer.from(JSON.stringify(wrappedError)),
  }
}

function adaptBuyerFaultErrorResponse(
  response: SerializedHttpResponse,
  requestProtocol: ServiceApiProtocol | null,
): SerializedHttpResponse {
  if (
    response.statusCode < 400
    || response.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER]?.toLowerCase() !== 'buyer'
  ) {
    return sanitizePeerBuyerFaultMarker(response)
  }

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(Buffer.from(response.body).toString('utf-8')) as Record<string, unknown>
  } catch {
    // Buyer-generated failures should be JSON, but keep a useful fallback if
    // a future path emits plain text.
  }

  const nestedError = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
    ? parsed.error as Record<string, unknown>
    : null
  const reason = [nestedError?.code, parsed.code, parsed.reason, nestedError?.type, parsed.error]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const message = [nestedError?.message, parsed.message, parsed.error]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?? 'The request failed on the buyer.'
  const body = requestProtocol === 'anthropic-messages'
    ? {
        type: 'error',
        error: {
          type: ANTSEED_BUYER_FAULT_ERROR_CODE,
          message: reason ? `${message} (${reason})` : message,
        },
      }
    : {
        error: {
          type: 'api_error',
          code: ANTSEED_BUYER_FAULT_ERROR_CODE,
          message,
          ...(reason ? { param: reason } : {}),
        },
      }

  return {
    ...response,
    headers: { ...response.headers, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  }
}

export function sanitizePeerBuyerFaultMarker(response: SerializedHttpResponse): SerializedHttpResponse {
  if (response.statusCode < 400) return response

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(Buffer.from(response.body).toString('utf-8')) as Record<string, unknown>
  } catch {
    return response
  }

  // Scrub the whole tree, not just the top level: a seller nesting the marker
  // deeper (e.g. error.details.code) must not be able to have its failure
  // classified as buyer-fault downstream. Iterate to avoid recursion limits
  // without leaving deeply nested markers trusted by downstream clients.
  let changed = false
  const pending: unknown[] = [parsed]
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    const record = value as Record<string, unknown>
    for (const key of ['code', 'type', 'errorCode']) {
      if (record[key] === ANTSEED_BUYER_FAULT_ERROR_CODE) {
        record[key] = 'upstream_error'
        changed = true
      }
    }
    pending.push(...Object.values(record))
  }

  return changed
    ? { ...response, body: Buffer.from(JSON.stringify(parsed)) }
    : response
}

/** A non-negative integer amount of USDC base units, or null when absent or malformed. */
function parseUsdcBaseUnits(value: string | undefined): bigint | null {
  return value && /^\d{1,15}$/.test(value) ? BigInt(value) : null
}

function buyerFaultStatusCode(faultCode: string | null): number {
  switch (faultCode) {
    case 'invalid-request': return 400
    case 'buyer-budget-too-low': return 422
    case 'buyer-reserve-topup-timeout': return 504
    default: return 503
  }
}

/**
 * Inject the buyer-known peerId into a 402 payment_required JSON body.
 * The seller doesn't include its own peerId (and shouldn't — self-reported
 * identity is untrusted). The buyer proxy knows which peer it connected to,
 * so it stamps the peerId into the body before forwarding to the client.
 */
function inject402PeerId(
  response: SerializedHttpResponse,
  peerId: string,
): SerializedHttpResponse {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(Buffer.from(response.body).toString('utf-8')) as Record<string, unknown>
  } catch {
    return response
  }
  if (!parsed) return response

  // Handle both flat { error: 'payment_required', ... } and
  // wrapped { error: { type: 'payment_required', ... } } formats.
  if (parsed.error === 'payment_required') {
    parsed.peerId = peerId
  } else if (
    typeof parsed.error === 'object' &&
    parsed.error !== null &&
    (parsed.error as Record<string, unknown>).type === 'payment_required'
  ) {
    (parsed.error as Record<string, unknown>).peerId = peerId
  } else {
    return response
  }

  return {
    ...response,
    body: Buffer.from(JSON.stringify(parsed)),
  }
}

const PROTOCOL_TRANSFORMS: Record<string, ProtocolTransformStrategy> = {
  'anthropic-messages→openai-chat-completions': {
    from: 'anthropic-messages',
    to: 'openai-chat-completions',
  },
  'anthropic-messages→openai-responses': {
    from: 'anthropic-messages',
    to: 'openai-responses',
  },
  'openai-chat-completions→anthropic-messages': {
    from: 'openai-chat-completions',
    to: 'anthropic-messages',
  },
  'openai-responses→openai-chat-completions': {
    from: 'openai-responses',
    to: 'openai-chat-completions',
  },
  'openai-responses→anthropic-messages': {
    from: 'openai-responses',
    to: 'anthropic-messages',
  },
  'openai-chat-completions→openai-responses': {
    from: 'openai-chat-completions',
    to: 'openai-responses',
  },
}

/**
 * Parses a buyer.state.json blob into PeerInfo[], dropping entries with
 * missing/invalid peerIds, non-array providers, or lastSeen timestamps older
 * than the carry-forward window. Exported for unit testing.
 */
export function parsePersistedPeers(
  parsed: unknown,
  nowMs: number = Date.now(),
  maxAgeMs: number = CARRY_FORWARD_TTL_MS,
): PeerInfo[] {
  if (!parsed || typeof parsed !== 'object') return []
  const discovered = (parsed as { discoveredPeers?: unknown }).discoveredPeers
  if (!Array.isArray(discovered)) return []

  const peers: PeerInfo[] = []
  for (const raw of discovered) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const peerId = typeof entry.peerId === 'string' ? entry.peerId.toLowerCase() : ''
    if (!/^[0-9a-f]{40}$/.test(peerId)) continue
    if (!Array.isArray(entry.providers)) continue
    const providers = entry.providers.filter((p): p is string => typeof p === 'string')
    const lastSeen = typeof entry.lastSeen === 'number' && Number.isFinite(entry.lastSeen)
      ? entry.lastSeen
      : 0
    const lastReachedAt = typeof entry.lastReachedAt === 'number' && Number.isFinite(entry.lastReachedAt)
      ? entry.lastReachedAt
      : 0
    // Keep if either DHT observation or successful transport contact is within window.
    const freshnessAnchor = Math.max(lastSeen, lastReachedAt)
    if (freshnessAnchor <= 0 || nowMs - freshnessAnchor >= maxAgeMs) continue

    const peer: PeerInfo = {
      peerId: peerId as PeerInfo['peerId'],
      lastSeen,
      providers,
    }
    if (Array.isArray(entry.capabilities)) {
      const capabilities = entry.capabilities.filter((capability): capability is string => typeof capability === 'string')
      if (capabilities.length > 0) peer.capabilities = capabilities
    }
    if (lastReachedAt > 0) peer.lastReachedAt = lastReachedAt
    const displayName = sanitizePeerDisplayName(entry.displayName)
    if (displayName) peer.displayName = displayName
    if (typeof entry.publicAddress === 'string') peer.publicAddress = entry.publicAddress
    if (entry.providerPricing && typeof entry.providerPricing === 'object') {
      peer.providerPricing = entry.providerPricing as PeerInfo['providerPricing']
    }
    if (entry.providerServiceCategories && typeof entry.providerServiceCategories === 'object') {
      peer.providerServiceCategories = entry.providerServiceCategories as PeerInfo['providerServiceCategories']
    }
    if (entry.providerServiceApiProtocols && typeof entry.providerServiceApiProtocols === 'object') {
      peer.providerServiceApiProtocols = entry.providerServiceApiProtocols as PeerInfo['providerServiceApiProtocols']
    }
    if (entry.providerServiceUnitBillingModels && typeof entry.providerServiceUnitBillingModels === 'object') {
      peer.providerServiceUnitBillingModels = entry.providerServiceUnitBillingModels as PeerInfo['providerServiceUnitBillingModels']
    }
    if (entry.providerServiceCapabilities && typeof entry.providerServiceCapabilities === 'object') {
      peer.providerServiceCapabilities = entry.providerServiceCapabilities as PeerInfo['providerServiceCapabilities']
    }
    if (typeof entry.defaultInputUsdPerMillion === 'number') {
      peer.defaultInputUsdPerMillion = entry.defaultInputUsdPerMillion
    }
    if (typeof entry.defaultOutputUsdPerMillion === 'number') {
      peer.defaultOutputUsdPerMillion = entry.defaultOutputUsdPerMillion
    }
    if (typeof entry.defaultCachedInputUsdPerMillion === 'number') {
      peer.defaultCachedInputUsdPerMillion = entry.defaultCachedInputUsdPerMillion
    }
    if (typeof entry.maxConcurrency === 'number') {
      peer.maxConcurrency = entry.maxConcurrency
    }
    if (typeof entry.onChainAgentId === 'number' && Number.isFinite(entry.onChainAgentId)) {
      peer.onChainAgentId = entry.onChainAgentId
    }
    if (typeof entry.onChainReputationScore === 'number' && Number.isFinite(entry.onChainReputationScore)) {
      peer.onChainReputationScore = entry.onChainReputationScore
    }
    if (typeof entry.onChainSybilRisk === 'number' && Number.isFinite(entry.onChainSybilRisk)) {
      peer.onChainSybilRisk = entry.onChainSybilRisk
    }
    if (Array.isArray(entry.onChainSybilFlags)) {
      const flags = entry.onChainSybilFlags.filter((f): f is string => typeof f === 'string')
      if (flags.length > 0) peer.onChainSybilFlags = flags
    }
    if (typeof entry.onChainChannelCount === 'number' && Number.isFinite(entry.onChainChannelCount)) {
      peer.onChainChannelCount = entry.onChainChannelCount
    }
    if (typeof entry.onChainGhostCount === 'number' && Number.isFinite(entry.onChainGhostCount)) {
      peer.onChainGhostCount = entry.onChainGhostCount
    }
    if (typeof entry.onChainTotalVolumeUsdcMicros === 'number' && Number.isFinite(entry.onChainTotalVolumeUsdcMicros)) {
      peer.onChainTotalVolumeUsdcMicros = entry.onChainTotalVolumeUsdcMicros
    }
    if (typeof entry.onChainLastSettledAtSec === 'number' && Number.isFinite(entry.onChainLastSettledAtSec)) {
      peer.onChainLastSettledAtSec = entry.onChainLastSettledAtSec
    }
    if (typeof entry.onChainStakedAtSec === 'number' && Number.isFinite(entry.onChainStakedAtSec)) {
      peer.onChainStakedAtSec = entry.onChainStakedAtSec
    }
    if (typeof entry.onChainUsageEpoch === 'number' && Number.isFinite(entry.onChainUsageEpoch)) {
      peer.onChainUsageEpoch = entry.onChainUsageEpoch
    }
    if (typeof entry.onChainUsageShareBps === 'number' && Number.isFinite(entry.onChainUsageShareBps)) {
      peer.onChainUsageShareBps = entry.onChainUsageShareBps
    }
    if (typeof entry.onChainUsageLastEpochUsdcMicros === 'number' && Number.isFinite(entry.onChainUsageLastEpochUsdcMicros)) {
      peer.onChainUsageLastEpochUsdcMicros = entry.onChainUsageLastEpochUsdcMicros
    }
    if (typeof entry.onChainPoolStakeAnts === 'number' && Number.isFinite(entry.onChainPoolStakeAnts)) {
      peer.onChainPoolStakeAnts = entry.onChainPoolStakeAnts
    }
    if (typeof entry.onChainPoolPowerShareBps === 'number' && Number.isFinite(entry.onChainPoolPowerShareBps)) {
      peer.onChainPoolPowerShareBps = entry.onChainPoolPowerShareBps
    }
    if (typeof entry.onChainWashFlagged === 'boolean') {
      peer.onChainWashFlagged = entry.onChainWashFlagged
    }
    if (typeof entry.onChainWashShareBps === 'number' && Number.isFinite(entry.onChainWashShareBps)) {
      peer.onChainWashShareBps = entry.onChainWashShareBps
    }
    if (typeof entry.onChainStatsFetchedAt === 'number' && Number.isFinite(entry.onChainStatsFetchedAt)) {
      peer.onChainStatsFetchedAt = entry.onChainStatsFetchedAt
    }
    // Carry sellerContract through the persistence layer so the buyer's
    // SellerAddressResolver can return the facade address for facade-fronted
    // peers (e.g. DiemStakingProxy). Without this, the resolver falls back to
    // peerIdToAddress(peerId), the buyer signs channelId derived from the peer
    // wallet, and `reserve()` reverts on-chain with InvalidSignature() because
    // the contract derives channelId from msg.sender (the facade).
    if (typeof entry.sellerContract === 'string' && entry.sellerContract.length > 0) {
      peer.metadata = { ...(peer.metadata ?? {}), sellerContract: entry.sellerContract } as PeerMetadata
    }
    if (peer.capabilities && peer.capabilities.length > 0) {
      peer.metadata = { ...(peer.metadata ?? {}), capabilities: [...peer.capabilities] } as PeerMetadata
    }
    if (entry.verifications && typeof entry.verifications === 'object') {
      peer.metadata = { ...(peer.metadata ?? {}), verifications: entry.verifications as PeerMetadata['verifications'] } as PeerMetadata
    }
    if (entry.verificationResults && typeof entry.verificationResults === 'object') {
      peer.verificationResults = entry.verificationResults as PeerInfo['verificationResults']
    }
    // Re-score from the persisted signals rather than trusting the stored
    // number: identity evidence expires, so a cached score can go stale. When
    // nothing scoreable was persisted, keep whatever score the row carried.
    const trust = computeTrustScore(peer, nowMs)
    if (trust) {
      peer.trust = trust
      peer.onChainReputationScore = trust.score
    }
    peers.push(peer)
  }
  return peers
}

/**
 * Local HTTP proxy that forwards requests to P2P sellers.
 *
 * Tools like Claude CLI set ANTHROPIC_BASE_URL=http://localhost:8377
 * and the proxy transparently routes their API calls through the
 * Antseed P2P network.
 */

export function makeVerifierReach(
  node: Pick<AntseedNode, 'sendRequest'>,
  peer: PeerInfo,
  chosenId: string,
  signal: AbortSignal,
): SellerReach {
  const attestRoute = `${ANTSEED_ATTEST_PATH}/${encodeURIComponent(chosenId)}`
  return async (r) => {
    if (r.path !== attestRoute) {
      throw new Error(`verifier may only call its attestation route (${attestRoute}), not ${r.path}`)
    }
    const resp = await node.sendRequest(peer, {
      requestId: randomUUID(),
      method: r.method,
      path: r.path,
      headers: r.headers ?? {},
      body: r.body ?? new Uint8Array(),
    }, { signal, controlPlane: true })
    return { statusCode: resp.statusCode, headers: resp.headers, body: resp.body }
  }
}

const STATE_TMP_PATTERN = /^\.buyer\.state\..+\.json\.tmp$/
const STATE_TMP_SWEEP_MIN_AGE_MS = 60_000
const STATE_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200]

/**
 * Rename with a short bounded retry. On Windows, renaming over a file a
 * reader briefly holds open fails with EPERM/EACCES/EBUSY; those clear within
 * milliseconds, so retrying recovers the write instead of dropping it.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!retryable || attempt >= STATE_RENAME_RETRY_DELAYS_MS.length) throw err
      await new Promise((resolve) => setTimeout(resolve, STATE_RENAME_RETRY_DELAYS_MS[attempt]))
    }
  }
}

/**
 * Delete leftover `.buyer.state.<uuid>.json.tmp` files from state writes whose
 * rename failed in an earlier run. The age floor protects a temp file another
 * process (e.g. `antseed buyer connection set`) is writing right now.
 */
export async function sweepStaleStateTmpFiles(dir: string, minAgeMs = STATE_TMP_SWEEP_MIN_AGE_MS): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!STATE_TMP_PATTERN.test(name)) continue
    const filePath = join(dir, name)
    try {
      const info = await stat(filePath)
      if (now - info.mtimeMs >= minAgeMs) await unlink(filePath)
    } catch {
      // already gone or unreadable; nothing to clean
    }
  }
}

/**
 * Atomic read-merge-write of a JSON state file via a sibling temp file. The
 * temp file never survives: a failed rename unlinks it before rethrowing.
 */
export async function mergeJsonStateFile(stateDir: string, stateFile: string, patch: Record<string, unknown>): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(stateFile, 'utf-8')
    existing = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // file doesn't exist yet
  }
  const data = { ...existing, ...patch }
  const tmp = join(stateDir, `.buyer.state.${randomUUID()}.json.tmp`)
  await writeFile(tmp, JSON.stringify(data, null, 2))
  try {
    await renameWithRetry(tmp, stateFile)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A requested buyer identity name as stored ('' when none is named). */
function buyerIdentityName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function sendUnknownBuyerIdentity(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, error: 'Unknown buyer identity' })
}

export class BuyerProxy {
  private readonly _server: Server
  private readonly _node: AntseedNode
  private readonly _port: number
  private readonly _bgRefreshIntervalMs: number
  private readonly _peerCacheTtlMs: number
  private readonly _stateDir: string
  private readonly _depositLog: DepositLog
  private readonly _stateFile: string
  private readonly _configPath: string | null
  private _stateFileWatching = false
  private _configFileWatching = false
  private _pinnedPeer: string | null
  /**
   * Default for the `antseed` model alias: an explicit model route (`model`) or an exact
   * routing service (`router`). At most one is set. Set via `POST /_antseed/route` and
   * persisted in buyer.state.json.
   */
  private _defaultRoutedModel: string | null = null
  private _defaultRouter: DefaultRouterSelection | null = null
  private readonly _routingModels = new RoutingModelsCache()
  private readonly _modelRoutingClient: ModelRoutingClientApi
  private _conversations!: ConversationStore
  /**
   * Wall-clock of the last model-request activity (dispatch or streamed
   * frame). Exposed on /_antseed/buyer-usage so the desktop pill can show a
   * live "traffic" signal without depending on debug logging. A single field
   * write per frame — negligible next to the routing/payment/stream work.
   */
  private _lastModelActivityAt = 0
  private readonly _verifier?: VerifierPolicy
  private readonly _buyerIdentities: BuyerIdentityLoader
  private readonly _teeVerification: TeeVerification
  private readonly _teeControl: TeeControl
  private _stateWatchDebounce: ReturnType<typeof setTimeout> | null = null
  private _configWatchDebounce: ReturnType<typeof setTimeout> | null = null
  private _routingPreferences: ModelRoutingPreferences | null

  private _stateWriteChain: Promise<void> = Promise.resolve()
  private readonly _resourceRoutes = new ResourceRoutes()
  /** Retrieves of one video job run one at a time, so a job retired as failed cannot be delivered by a retrieve already under way. */
  private readonly _videoJobQueues = new Map<string, Promise<void>>()
  /** Jobs whose retirement is being saved: left out of the saved routes, still routable in memory until the save succeeds. */
  /** The saved video routes existed but could not be read at start (see `start`). */
  private _resourceRoutesUnread = false
  private readonly _retiringVideoJobs = new Set<string>()

  private _cachedPeers: PeerInfo[] = []
  private _cacheLastUpdatedAtMs = 0
  private _cacheMutationEpoch = 0
  private _peerRefreshPromise: Promise<PeerInfo[]> | null = null
  private _lastStaleCacheLogAtMs = 0
  private _startedAtMs = 0
  /** After a network switch the DHT routing table can stay populated with stale
      nodes, so repeated empty sweeps are the reachability signal — not node count. */
  private _consecutiveEmptyDiscoveries = 0
  private _lastModelNotFoundRefreshAtMs = 0
  private _bgRefreshHandle: ReturnType<typeof setInterval> | null = null
  /**
   * Per-peer failure streaks and cooldowns. Advisory only: a cooling-down peer
   * is still dispatched to when a request names it, so routing can never
   * deadlock and pinned conversations keep working.
   */
  private _peerHealth: Map<string, PeerHealthEntry> = new Map()
  /** Decides whether a failure is the peer's fault at all. */
  private readonly _attribution = new PeerAttributionTracker()
  /**
   * What this buyer has seen of each seller and model: how often requests
   * succeed and how fast answers come. Automatic routing ranks by it.
   */
  private _sellerHealth = new SellerHealthBook()
  /** Requests in flight per seller, to stop sending a seller more than it says it can take at once. */
  private readonly _inFlightBySeller = new Map<string, number>()
  private _peerHealthPersistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly _adaptiveRouting: NonNullable<BuyerProxyConfig['adaptiveRouting']>
  private _heartbeatHandle: ReturnType<typeof setInterval> | null = null
  private readonly _now: () => number
  /** Latest relayer receipt per sweep authNonce, for CLI progress polling. */
  private readonly _sweepReceipts = new Map<string, SweepReceiptPayload>()
  /**
   * Hot-wallet deposit watcher (auto-sweep). Owned by `buyer start`, attached
   * here so the desktop and `antseed deposit` can drive it over the control
   * plane instead of running a second signer against the same wallet.
   */
  private _depositWatcher: DepositWatcher | null = null
  /** Why no watcher is attached, so UIs can show the actual cause. */
  private _depositWatcherAbsence: DepositWatcherAbsenceReason | null = null
  /** Watchers for named buyer identities (each workspace wallet), keyed by identity name. */
  private readonly _identityDepositWatchers = new Map<string, DepositWatcher>()

  /**
   * requestId -> the conversation that issued it, so the node's per-request
   * spend events can be attributed to a chat. Only the proxy knows this
   * mapping; the payment layer sees a seller and a request id.
   *
   * `counted` guards requestCount: one request can produce several spend
   * deltas (buyer- and seller-initiated auth both advance the cumulative).
   */
  private readonly _requestConversations = new Map<string, { convId: string; counted: boolean; purpose?: 'routing' }>()
  /** Signed spend for requests a local gateway tagged, polled over the control plane. */
  private readonly _spendAttribution: SpendAttributionFeed

  private readonly _minPeerReputation: number | null
  /** Gateway control secret, read lazily (the gateway may create it after the buyer starts). */
  private _controlSecret: string | null = null
  private _controlSecretCheckedAt = 0
  private _controlSecretForcedAt = 0
  private _loggedUnauthenticatedPolicy = false
  private readonly _balanceReader: BuyerBalanceReader | null
  private readonly _balanceCache = new ChainReadCache()
  private readonly _restartHandler: (() => void | Promise<void>) | null
  private readonly _settingOverrides: string[]
  private readonly _telemetry: BuyerTelemetry | null
  private _restartRequested = false
  /** A restarted buyer is a new process, so its start is the last accepted restart. */
  private readonly _restartAllowedAt: number

  constructor(config: BuyerProxyConfig) {
    this._minPeerReputation = config.minPeerReputation ?? null
    this._balanceReader = config.balanceReader ?? null
    this._restartHandler = config.onRestartRequested ?? null
    this._restartAllowedAt = Date.now() + (config.minRestartIntervalMs ?? MIN_RESTART_INTERVAL_MS)
    this._settingOverrides = [...(config.settingOverrides ?? [])]
    this._telemetry = config.telemetry ?? null
    this._node = config.node
    this._modelRoutingClient = config.modelRoutingClient ?? new ModelRoutingClient()
    this._verifier = config.verifier
    this._buyerIdentities = config.buyerIdentities ?? new BuyerIdentityLoader(config.node, config.dataDir)
    this._teeVerification = new TeeVerification(config.verifier)
    this._teeControl = new TeeControl(this._teeVerification.sessionId)
    this._port = config.port
    this._bgRefreshIntervalMs = Math.max(1, config.backgroundRefreshIntervalMs ?? DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS)
    this._peerCacheTtlMs = Math.max(0, config.peerCacheTtlMs ?? Math.max(6 * 60_000, this._bgRefreshIntervalMs + 60_000))
    this._stateDir = config.dataDir
    this._depositLog = new DepositLog(config.dataDir)
    this._stateFile = join(config.dataDir, 'buyer.state.json')
    // Kept on disk so spend signed just before a restart still reaches the gateway.
    this._spendAttribution = new SpendAttributionFeed(undefined, {
      path: join(config.dataDir, SPEND_ATTRIBUTION_DB_FILE),
      onLog: (message) => console.warn(`[proxy] ${message}`),
    })
    this._configPath = config.configPath ?? null
    this._conversations = new ConversationStore(config.dataDir)
    this._pinnedPeer = config.pinnedPeerId?.toLowerCase() ?? null
    this._routingPreferences = config.routingPreferences
      ? {
          ...config.routingPreferences,
          allowedPeerIds: [...config.routingPreferences.allowedPeerIds],
          blockedPeerIds: [...config.routingPreferences.blockedPeerIds],
        }
      : null
    this._now = config.now ?? (() => Date.now())
    this._adaptiveRouting = { ...config.adaptiveRouting }
    this._server = createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        log('Unhandled error:', err)
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' })
        }
        res.end(`Proxy error: ${err instanceof Error ? err.message : String(err)}`)
      })
    })

    const sweepEventNode = this._node as AntseedNode & {
      on?: (event: 'sweep:receipt', listener: (event: { peerId: string; payload: SweepReceiptPayload }) => void) => unknown
    }
    if (typeof sweepEventNode.on === 'function') {
      sweepEventNode.on('sweep:receipt', ({ payload }) => {
        this._sweepReceipts.set(payload.authNonce.toLowerCase(), payload)
        if (this._sweepReceipts.size > 64) {
          const oldest = this._sweepReceipts.keys().next().value
          if (oldest !== undefined) this._sweepReceipts.delete(oldest)
        }
      })
    }

    const spendEventNode = this._node as AntseedNode & {
      on?: (event: 'payment:spend', listener: (event: BuyerSpendEvent & { buyerIdentity?: string }) => void) => unknown
    }
    if (typeof spendEventNode.on === 'function') {
      spendEventNode.on('payment:spend', (event: BuyerSpendEvent & { buyerIdentity?: string }) => {
        this._attributeSpend(event)
        this._spendAttribution.record(event)
      })
    }

    const responseAuthNode = this._node as AntseedNode & {
      on?: (event: 'response-auth', listener: (event: ResponseAuthEvent) => void) => unknown
    }
    if (typeof responseAuthNode.on === 'function') {
      responseAuthNode.on('response-auth', (event: ResponseAuthEvent) => {
        if (event.verified || !isSellerVerificationFailure(event.verificationError)) return
        // A forged or mismatched receipt can only be the seller's doing: it
        // counts as several failed requests.
        this._recordSellerFailure(event.sellerPeerId, event.advertisedService, `response failed verification (${event.verificationError})`, 3)
        log(`Peer ${event.sellerPeerId.slice(0, 12)}... response failed verification (${event.verificationError}); counted against its ${event.advertisedService} health.`)
      })
    }

    const eventNode = this._node as AntseedNode & {
      on?: (event: 'peers:discovered', listener: (peers: PeerInfo[]) => void) => unknown
    }
    if (typeof eventNode.on === 'function') {
      eventNode.on('peers:discovered', (peers: PeerInfo[]) => {
        if (peers.length === 0) return
        log(`Background discovery found ${peers.length} peer(s)`)
        this._replacePeers(peers)
      })
    }
  }

  /** Roll a signed spend delta into the conversation that triggered it. */
  private _attributeSpend(event: BuyerSpendEvent): void {
    if (!event.requestId) return
    const entry = this._requestConversations.get(event.requestId)
    if (!entry) return
    const routing = entry.purpose === 'routing'
    this._conversations.addSpend(
      entry.convId,
      {
        amountUsdc: event.amountUsdc,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
      },
      !routing && !entry.counted,
    )
    if (!routing) entry.counted = true
  }

  /**
   * Identity named by a request: null for the default, the name when it is
   * (or can be) loaded, undefined when no stored identity has that name.
   */
  private async _resolveBuyerIdentity(header: string | undefined): Promise<string | null | undefined> {
    const name = buyerIdentityName(header)
    if (!name || name === DEFAULT_BUYER_IDENTITY) return null
    const loaded = await this._buyerIdentities.ensure(name).catch((err: unknown) => {
      log(`Buyer identity "${name}" failed to load: ${err instanceof Error ? err.message : String(err)}`)
      return false
    })
    return loaded ? name : undefined
  }

  /**
   * Whether a request may act as this buyer identity. The default wallet is
   * always allowed; any other is a workspace wallet, so once a control secret
   * exists only the gateway may name it (loopback callers otherwise, as for
   * the attributed-spend feed).
   */
  private _mayUseBuyerIdentity(req: IncomingMessage, value: string | undefined): boolean {
    const name = buyerIdentityName(value)
    if (!name || name === DEFAULT_BUYER_IDENTITY) return true
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
    return this._readControlSecret() === null || this._isGatewayAuthenticated(req.headers)
  }

  /**
   * `?identity=` on control-plane requests (a body's `identity`, when given,
   * wins); undefined when it names no stored identity.
   */
  private async _controlPlaneIdentity(path: string, bodyIdentity?: string): Promise<string | null | undefined> {
    const param = bodyIdentity ?? new URL(path, 'http://localhost').searchParams.get('identity') ?? undefined
    return this._resolveBuyerIdentity(param)
  }

  /**
   * The gateway↔buyer control secret: env var first, else the file the
   * gateway creates under the data dir. A missing file is re-checked at most
   * once a second so a gateway started after the buyer is picked up. A
   * mismatch forces an immediate re-read (bypassing that throttle, at most
   * every 100 ms) in case the secret was just created or rotated.
   */
  private _readControlSecret(forceReread = false): string | null {
    const fromEnv = process.env[GATEWAY_CONTROL_SECRET_ENV]?.trim()
    if (fromEnv) return fromEnv
    const now = Date.now()
    if (forceReread) {
      if (now - this._controlSecretForcedAt < CONTROL_SECRET_FORCED_RECHECK_MS) return this._controlSecret
      this._controlSecretForcedAt = now
    } else {
      if (this._controlSecret) return this._controlSecret
      if (now - this._controlSecretCheckedAt < CONTROL_SECRET_RECHECK_MS) return this._controlSecret
    }
    this._controlSecretCheckedAt = now
    try {
      const value = readFileSync(join(this._stateDir, GATEWAY_CONTROL_SECRET_FILE), 'utf8').trim()
      this._controlSecret = value.length > 0 ? value : null
    } catch {
      // Not created yet (no gateway): keep whatever we had.
    }
    return this._controlSecret
  }

  /** Whether the request carries the local gateway's control secret. */
  private _isGatewayAuthenticated(headers: Record<string, string | string[] | undefined>): boolean {
    const raw = headers[GATEWAY_CONTROL_HEADER]
    const provided = Array.isArray(raw) ? raw[0] : raw
    if (!provided) return false
    const secret = this._readControlSecret()
    if (secret && secretsMatch(provided, secret)) return true
    const reread = this._readControlSecret(true)
    return reread !== null && reread !== secret && secretsMatch(provided, reread)
  }

  /**
   * Reads and strips the gateway routing-policy headers. A control header
   * that is present but wrong fails closed (the gateway meant to restrict
   * this request); a policy sent with no control header at all is dropped
   * and ignored. An authenticated but malformed policy is an error, never
   * unrestricted routing.
   */
  private _takeRequestPolicy(headers: Record<string, string>): RequestPolicyResult {
    const hasAuth = headers[GATEWAY_CONTROL_HEADER] !== undefined
    const encoded = headers[ROUTING_POLICY_HEADER]
    const authenticated = hasAuth && this._isGatewayAuthenticated(headers)
    delete headers[GATEWAY_CONTROL_HEADER]
    delete headers[ROUTING_POLICY_HEADER]
    if (hasAuth && !authenticated) return { kind: 'auth_invalid' }
    if (encoded === undefined) return { kind: 'none' }
    if (!authenticated) {
      if (!this._loggedUnauthenticatedPolicy) {
        this._loggedUnauthenticatedPolicy = true
        console.warn(`[proxy] Ignoring ${ROUTING_POLICY_HEADER} without a valid ${GATEWAY_CONTROL_HEADER} (logged once).`)
      }
      return { kind: 'none' }
    }
    const policy = decodePolicyHeader(encoded)
    if (!policy) return { kind: 'invalid' }
    // A policy that changes nothing routes exactly like no policy (as on a
    // buyer without a gateway), down to the error messages.
    const meaningful = meaningfulPolicy(policy)
    return Object.keys(meaningful).length > 0 ? { kind: 'policy', policy: meaningful } : { kind: 'none' }
  }

  /**
   * The buyer's hard limits (min reputation, required verifier), which judge
   * every request, pinned ones included.
   */
  private _buyerHardPolicy(): RoutingPolicy {
    return buyerHardPolicy({
      minPeerReputation: this._minPeerReputation,
      verifierRequired: this._verifier?.require === true,
    })
  }

  /** `buyer.routingPreferences` as a policy level (empty without preferences). */
  private _buyerPreferencePolicy(): RoutingPolicy {
    return this._routingPreferences ? buyerPreferencePolicy(this._routingPreferences) : {}
  }

  /**
   * The buyer's whole config as the top policy level for automatic routing:
   * hard limits plus routing preferences. Reported to the gateway as the
   * route preview's `buyer` level.
   */
  private _buyerPolicy(): RoutingPolicy {
    return narrowPolicy(this._buyerHardPolicy(), this._buyerPreferencePolicy())
  }

  /** A gateway policy narrowed under the buyer's hard limits; null when the request carries none. Judges pins. */
  private _effectivePolicy(requestPolicy: RoutingPolicy | null): RoutingPolicy | null {
    if (!requestPolicy) return null
    return narrowPolicy(this._buyerHardPolicy(), requestPolicy)
  }

  /** Null when the seller can be verified with this buyer's verifier, else why not. */
  private _unverifiedReason(peer: PeerInfo): string | null {
    if (!this._verifier) return 'not verified (verification disabled on this buyer)'
    const supported = parseVerifierCapabilities(peer.capabilities)
    return selectVerifier({ ...this._verifier, require: true }, supported) === null
      ? 'not verified (no supported verifier)'
      : null
  }

  private _policyFacts(peer: PeerInfo, offer: NetworkServiceOffer | null): PolicyPeerFacts {
    const score = normalizedModelReputationScore(peer)
    return {
      peerId: peer.peerId,
      trustScore: score,
      reputation: score,
      inputUsdPerMillion: offer?.inputUsdPerMillion ?? null,
      outputUsdPerMillion: offer?.outputUsdPerMillion ?? null,
      cachedInputUsdPerMillion: offer?.cachedInputUsdPerMillion ?? null,
      imageUsdPerImage: offer?.maxImageUsdPerImage ?? offer?.minImageUsdPerImage ?? null,
      unverifiedReason: this._unverifiedReason(peer),
      teeCapable: parseVerifierCapabilities(peer.capabilities).supported.includes(TEE_VERIFIER_ID),
    }
  }

  /** Health is tracked per seller and model: one seller can serve a small model fast and a large one slowly. */
  private _healthServiceKey(serviceId: string | null): string | null {
    return serviceId ? policyModelKey(serviceId) : null
  }

  private _peerLatency(peerId: string, serviceId: string | null): number | null {
    return this._sellerHealth.stats(peerId, this._healthServiceKey(serviceId), this._now())?.firstTokenMs ?? null
  }

  private _peerThroughput(peerId: string, serviceId: string | null): number | null {
    return this._sellerHealth.stats(peerId, this._healthServiceKey(serviceId), this._now())?.tokensPerSecond ?? null
  }

  /**
   * Sellers the paying identity already has an open payment channel with, so
   * routing can spread traffic without reserving funds on new sellers. Null
   * when the node cannot say.
   */
  private _openChannelPeers(buyerIdentity: string | undefined): Set<string> | null {
    const node = this._node as Partial<Pick<AntseedNode, 'getActiveBuyerChannels'>>
    if (typeof node.getActiveBuyerChannels !== 'function') return null
    try {
      return new Set(node.getActiveBuyerChannels(buyerIdentity).map((channel) => channel.peerId.toLowerCase()))
    } catch {
      return null
    }
  }

  private _attemptTimeoutMs(timedLike: { peerId: string; serviceId: string }, request: SerializedHttpRequest): number | null {
    return adaptiveFirstTokenTimeoutMs(
      this._sellerHealth.stats(timedLike.peerId, this._healthServiceKey(timedLike.serviceId), this._now()),
      requestShape(request).outputTokens,
      requestWantsStreaming(request.headers, request.body),
    )
  }

  /** A seller answered: count the success and how fast the answer came. */
  private _recordSellerSuccess(peerId: string, serviceId: string | null, timing: { firstTokenMs: number; streamMs?: number; outputTokens: number; streamed: boolean }): void {
    this._sellerHealth.recordSuccess(peerId, this._healthServiceKey(serviceId), this._now(), timing)
    this._schedulePeerHealthPersist()
  }

  /** A seller failed a request: count it against that seller and model. */
  private _recordSellerFailure(peerId: string, serviceId: string | null, reason: string, weight = 1): void {
    this._sellerHealth.recordFailure(peerId, this._healthServiceKey(serviceId), this._now(), reason, weight)
    this._schedulePeerHealthPersist()
  }

  /** Seller health changes on every request: write it at most every few seconds, not per request. */
  private _schedulePeerHealthPersist(): void {
    if (this._peerHealthPersistTimer) return
    this._peerHealthPersistTimer = setTimeout(() => {
      this._peerHealthPersistTimer = null
      void this._persistPeerHealthToState()
    }, SELLER_HEALTH_PERSIST_DELAY_MS)
    this._peerHealthPersistTimer.unref?.()
  }

  /**
   * Candidate selection and ranking for a model-only request. The real
   * routing path and `GET /_antseed/route-preview` both call this, so the
   * preview shows exactly what routing would do. `verdicts` lists every
   * seller advertising the model with why it is (in)eligible; `candidates`
   * are the eligible ones in dispatch order.
   */
  private _planModelRoutes(input: {
    modelPeers: PeerInfo[]
    modelPlans: Map<string, PeerProtocolRoutePlan>
    request: SerializedHttpRequest
    requestProtocol: ServiceApiProtocol | null
    requestedService: string
    explicitProvider: string | null
    requiredParameters: readonly string[]
    requestPolicy: RoutingPolicy | null
    preferredPeerId: string | null
    /** Route preview: no random spreading or probing, so it shows the expected order. */
    deterministic?: boolean
    /** Stable key of the conversation, so all its turns go to the seller holding its prompt cache. */
    affinityKey?: string | null
  }) {
    const { modelPeers, modelPlans, request, requestProtocol, requestedService, explicitProvider, requiredParameters } = input
    const policyRouter = this._node.router as BuyerPolicyRouter | null | undefined
    const requestPolicy = input.requestPolicy
    // Under a gateway policy the buyer's config is the top level of the
    // chain: the gateway narrows it, never replaces it.
    const effectivePolicy = requestPolicy ? narrowPolicy(this._buyerPolicy(), requestPolicy) : null
    const verdicts = new Map<string, ModelRouteVerdict>()
    const routeCandidates = []
    for (const peer of modelPeers) {
      const plan = modelPlans.get(peer.peerId)
        ?? resolvePeerRoutePlan(peer, requestProtocol, requestedService, explicitProvider, 'strict')
      if (!plan?.serviceId) continue
      const offer = findAdvertisedServiceOffer(peer, plan.provider, plan.serviceId)
      if (!offer) continue
      const verdict: ModelRouteVerdict = { peer, serviceId: plan.serviceId, offer, eligible: false, rank: null, reasons: [] }
      verdicts.set(peer.peerId, verdict)
      const missingRequired = plan.selection?.requiresTransform
        ? [...requiredParameters]
        : findMissingRequiredParameters(peer, plan.provider, plan.serviceId, requiredParameters)
      if (missingRequired.length > 0) {
        log(
          `Capability filter: peer ${peer.peerId.slice(0, 12)}... service="${plan.serviceId}" `
          + `missing required parameter(s): ${missingRequired.join(', ')}`,
        )
        verdict.reasons.push(`missing required parameter(s): ${missingRequired.join(', ')}`)
        continue
      }
      const requestForPolicy = withRoutedModel(request, plan.serviceId)
      if (!peerAllowedByPolicy(policyRouter, requestForPolicy, peer)) {
        verdict.reasons.push(buyerConfigReason(policyRouter?.explainPolicyRejection?.(requestForPolicy, peer) ?? 'outside buyer pricing/reputation limits'))
        continue
      }
      routeCandidates.push({
        offer,
        peer,
        peerId: peer.peerId,
        serviceId: plan.serviceId,
        request: requestForPolicy,
        reputation: normalizedModelReputationScore(peer) ?? -1,
        hasCachedInputPricing: offer.cachedInputUsdPerMillion !== undefined,
        inputUsdPerMillion: offer.inputUsdPerMillion ?? null,
        outputUsdPerMillion: offer.outputUsdPerMillion ?? null,
        minImageUsdPerImage: offer.minImageUsdPerImage ?? null,
      })
    }
    const now = this._now()
    const preferCachedPricing = routeCandidates.some((candidate) => candidate.hasCachedInputPricing)
    const ranked = routeCandidates.map((candidate) => {
      const health = this._peerHealth.get(candidate.peer.peerId)
      return {
        ...candidate,
        effectiveReputationScore: effectiveModelReputationScore(
          candidate.reputation >= 0 ? candidate.reputation : null,
          candidate.hasCachedInputPricing,
          preferCachedPricing,
          modelRouteTotalPrice(candidate) === 0,
        ),
        peerCooldownUntil: health?.cooldownUntil ?? null,
        peerFailureStreak: health?.failureStreak ?? 0,
      }
    })
    let candidates: typeof ranked
    const routingPreferences = this._routingPreferences
    if (requestPolicy && effectivePolicy) {
      // Exclusions from the merged chain, reported per level: the gateway's
      // policy on raw trust, the buyer's preferences on the effective trust
      // its own automatic routing uses. (The buyer's hard limits were
      // already applied by the router plugin above.) Excluded by the merged
      // policy exactly when excluded by either level.
      const buyerPreferences = this._buyerPreferencePolicy()
      const allowed = ranked.filter((candidate) => {
        const facts = this._policyFacts(candidate.peer, candidate.offer)
        const reasons = policyExclusionReasons(requestPolicy, facts)
        addBuyerConfigReasons(reasons, policyExclusionReasons(buyerPreferences, {
          ...facts, trustScore: modelRouteReputationScore(candidate), trustPenalty: trustPenalty(candidate),
        }))
        if (reasons.length === 0) return true
        verdicts.get(candidate.peerId)?.reasons.push(...reasons)
        return false
      })
      candidates = routingPreferences
        ? rankModelRoutes(allowed, rankingPreferences(routingPreferences, effectivePolicy), now)
        : this._readyFirst(allowed, verdicts, now)
    } else if (routingPreferences) {
      candidates = []
      for (const candidate of rankModelRoutes(ranked, routingPreferences, now)) {
        if (isModelRouteEligible(candidate, routingPreferences)) {
          candidates.push(candidate)
        } else {
          verdicts.get(candidate.peerId)?.reasons.push(
            ...preferenceExclusionReasons(routingPreferences, candidate.peerId, modelRouteReputationScore(candidate), trustPenalty(candidate)),
          )
        }
      }
    } else {
      candidates = this._readyFirst(ranked, verdicts, now)
    }
    const isCooling = (candidate: (typeof ranked)[number]): boolean => isModelRouteCoolingDown(candidate, now)
    const openChannels = this._openChannelPeers(request.headers[BUYER_IDENTITY_HEADER])
    // Among the sellers the buyer's limits allow, rank by what this buyer has
    // seen them do: expected cost of a successful answer, spread across the
    // sellers close to the best. An explicit gateway sort or route chain
    // reorders afterwards, but still tries unhealthy sellers late.
    const adaptive = orderAdaptiveRoutes(candidates, (candidate) => ({
      peerId: candidate.peerId,
      serviceId: this._healthServiceKey(candidate.serviceId),
      inputUsdPerMillion: candidate.inputUsdPerMillion,
      outputUsdPerMillion: candidate.outputUsdPerMillion,
      requestUsd: candidate.minImageUsdPerImage,
      coolingDown: isCooling(candidate),
      ...(openChannels ? { channelOpen: modelRouteTotalPrice(candidate) === 0 || openChannels.has(candidate.peerId.toLowerCase()) } : {}),
      saturated: typeof candidate.peer.maxConcurrency === 'number' && candidate.peer.maxConcurrency > 0
        && (this._inFlightBySeller.get(candidate.peerId.toLowerCase()) ?? 0) >= candidate.peer.maxConcurrency,
    }), this._sellerHealth, requestShape(request), {
      now,
      affinityKey: input.affinityKey ?? null,
      ...this._adaptiveRouting,
      // The preview keeps the real sharing pool (so it can show who shares the
      // traffic) but always draws its first seller and never probes.
      ...(input.deterministic ? { random: () => 0, explorationRate: 0 } : {}),
    })
    // Without routing preferences the buyer ranks by reputation, as before;
    // health only moves sellers that fail often behind the others.
    candidates = routingPreferences
      ? adaptive.ordered
      : [...candidates].sort((a, b) => Number(adaptive.scores.get(a)!.unhealthy) - Number(adaptive.scores.get(b)!.unhealthy))
    const healthOf = (candidate: (typeof ranked)[number]): AdaptiveRouteScore => adaptive.scores.get(candidate)!
    let chainPosition: Map<string, number> | null = null
    if (effectivePolicy) {
      const ordering = orderByPolicy(candidates, effectivePolicy, requestedService, {
        peerId: (candidate) => candidate.peerId,
        totalPrice: (candidate) => modelRouteTotalPrice(candidate),
        trustScore: (candidate) => (candidate.reputation >= 0 ? candidate.reputation : null),
        latencyMs: (candidate) => this._peerLatency(candidate.peerId, candidate.serviceId),
        coolingDown: isCooling,
        unhealthy: (candidate) => healthOf(candidate).unhealthy,
      })
      for (const candidate of candidates) {
        const reason = ordering.excluded.get(normalizePolicyPeerId(candidate.peerId))
        if (reason) verdicts.get(candidate.peerId)?.reasons.push(reason)
      }
      candidates = ordering.ordered
      chainPosition = ordering.chainPosition
    }
    // Conversation affinity is a soft preference: it only reorders sellers the
    // policy already allows, and yields to an explicit per-model route.
    const preferredPeerId = input.preferredPeerId
    let conversationFirst = false
    if (preferredPeerId && !findModelRoute(effectivePolicy, requestedService)) {
      const preferredIndex = candidates.findIndex((candidate) => (
        candidate.peer.peerId.toLowerCase() === preferredPeerId
        && !isCoolingDown(this._peerHealth.get(candidate.peer.peerId), now)
        && !healthOf(candidate).unhealthy
      ))
      if (preferredIndex > 0) {
        const [preferred] = candidates.splice(preferredIndex, 1)
        if (preferred) candidates.unshift(preferred)
      }
      conversationFirst = preferredIndex >= 0
    }
    // How the eligible sellers were put in order. Only the buyer's adaptive
    // order, unsorted by the policy and with no route chain, spreads traffic.
    const policySort = effectivePolicy?.sort && effectivePolicy.sort !== 'balanced' ? effectivePolicy.sort : null
    const selectionOrdering: RouteSelection['ordering'] = policySort ?? (routingPreferences ? 'expected-cost' : 'trust')
    const spreads = selectionOrdering === 'expected-cost' && !chainPosition?.size
    const pool = spreads ? adaptive.pool : []
    const poolWeight = (candidate: (typeof ranked)[number]): number => 1 / Math.max(healthOf(candidate).score, 1e-9) ** 2
    const poolTotal = pool.reduce((sum, candidate) => sum + poolWeight(candidate), 0)
    const selections = new Map<(typeof ranked)[number], RouteSelection>()
    candidates.forEach((candidate, index) => {
      const verdict = verdicts.get(candidate.peerId)
      if (!verdict) return
      verdict.eligible = true
      verdict.rank = index + 1
      const position = chainPosition?.get(normalizePolicyPeerId(candidate.peerId))
      if (position !== undefined) verdict.reasons.push(`route chain #${position + 1}`)
      const health = healthOf(candidate)
      if (isCooling(candidate)) verdict.reasons.push('cooling down (tried last)')
      else if (health.unhealthy) verdict.reasons.push(`failing lately: ${health.stats?.lastFailureReason ?? 'failed requests'} (tried after healthy sellers)`)
      if (pool.length > 1 && pool.includes(candidate)) verdict.reasons.push(`shares traffic with ${pool.length - 1} other seller(s)`)
      if (modelRouteTotalPrice(candidate) === 0) verdict.reasons.push('free')
      verdict.reasons.push(`success ~${Math.round(health.successProbability * 100)}%${health.stats ? '' : ' (no data yet)'}`)
      const latency = this._peerLatency(candidate.peerId, candidate.serviceId)
      if (latency !== null) verdict.reasons.push(`first token ~${Math.round(latency)}ms`)
      const throughput = this._peerThroughput(candidate.peerId, candidate.serviceId)
      if (throughput !== null) verdict.reasons.push(`~${Math.round(throughput)} tok/s`)
      const healthKey = this._healthServiceKey(candidate.serviceId)
      const stats = health.stats
      const inPool = pool.includes(candidate)
      const maxConcurrency = typeof candidate.peer.maxConcurrency === 'number' && candidate.peer.maxConcurrency > 0 ? candidate.peer.maxConcurrency : null
      const selection: RouteSelection = {
        expectedCostUsd: health.score,
        expectedPriceUsd: health.expectedPriceUsd,
        expectedSeconds: health.expectedSeconds,
        successRate: health.successProbability,
        observations: stats ? stats.successes + stats.failures : 0,
        record: !stats ? 'none' : this._sellerHealth.hasRecord(candidate.peerId, healthKey) ? 'model' : 'other-models',
        firstTokenMs: latency,
        tokensPerSecond: throughput,
        lastSuccessAt: stats && stats.lastSuccessAt > 0 ? stats.lastSuccessAt : null,
        lastFailureAt: stats && stats.lastFailureAt > 0 ? stats.lastFailureAt : null,
        lastFailureReason: stats?.lastFailureReason ?? null,
        failing: health.unhealthy,
        coolingDown: isCooling(candidate),
        stale: health.stale,
        ordering: selectionOrdering,
        sharesTraffic: inPool && pool.length > 1,
        trafficShare: inPool && pool.length > 1 && poolTotal > 0 ? poolWeight(candidate) / poolTotal : null,
        poolSize: pool.length,
        channel: modelRouteTotalPrice(candidate) === 0 ? 'free' : openChannels ? (openChannels.has(candidate.peerId.toLowerCase()) ? 'open' : 'new') : null,
        inFlight: this._inFlightBySeller.get(candidate.peerId.toLowerCase()) ?? 0,
        maxConcurrency,
        routeChainPosition: position !== undefined ? position + 1 : null,
      }
      verdict.selection = selection
      selections.set(candidate, selection)
    })
    // How the first seller came to be first, for the request's record.
    const first = candidates[0]
    let firstPick: ServedSelection['pick'] = 'order'
    if (first) {
      if (first === adaptive.explored) firstPick = 'exploration'
      else if (conversationFirst || (input.affinityKey && pool.length > 1 && pool.includes(first) && first === adaptive.ordered[0])) firstPick = 'conversation'
      else if (first === adaptive.ordered[0] && pool.includes(first)) firstPick = pool.length > 1 ? 'spread' : 'best'
    }
    return { candidates, verdicts: [...verdicts.values()], effectivePolicy, explored: adaptive.explored, selections, firstPick }
  }

  /**
   * For telemetry: why a conversation's previous seller is not first in this
   * turn's order. Null when it is first (or there is none); if it then fails,
   * the trace says so itself.
   */
  private _previousSellerSkipped(
    previousSeller: string | null,
    ordered: readonly { peerId: string }[],
    verdicts: readonly ModelRouteVerdict[],
  ): SwitchReason | null {
    if (!previousSeller) return null
    const verdict = verdicts.find((entry) => entry.peer.peerId.toLowerCase() === previousSeller)
    if (!verdict) return 'previous_unavailable'
    if (!verdict.eligible) return 'previous_excluded'
    if (ordered[0]?.peerId.toLowerCase() === previousSeller) return null
    if (verdict.selection?.coolingDown) return 'previous_cooling_down'
    if (verdict.selection?.failing) return 'previous_unhealthy'
    const first = verdicts.find((entry) => entry.peer.peerId.toLowerCase() === ordered[0]?.peerId.toLowerCase())
    if (first?.selection?.routeChainPosition != null) return 'policy_route'
    return 'other'
  }

  /**
   * Without routing preferences: best effective reputation first, and only
   * sellers not cooling down while any are ready.
   */
  private _readyFirst<T extends { peer: PeerInfo; peerId: string; effectiveReputationScore: number | null }>(
    ranked: T[],
    verdicts: Map<string, ModelRouteVerdict>,
    now: number,
  ): T[] {
    ranked.sort((a, b) =>
      (b.effectiveReputationScore ?? -1) - (a.effectiveReputationScore ?? -1)
      || a.peer.peerId.localeCompare(b.peer.peerId))
    const ready: T[] = []
    const cooling: T[] = []
    for (const candidate of ranked) {
      if (isCoolingDown(this._peerHealth.get(candidate.peer.peerId), now)) cooling.push(candidate)
      else ready.push(candidate)
    }
    if (ready.length === 0) return ranked
    for (const candidate of cooling) verdicts.get(candidate.peerId)?.reasons.push('cooling down')
    return ready
  }

  /** `GET /_antseed/route-preview`: what routing would do for a model-only request, ineligible sellers included. */
  private async _routePreview(model: string, requestPolicy: RoutingPolicy | null): Promise<RoutePreviewCandidate[]> {
    const peers = await this._getPeers()
    const request: SerializedHttpRequest = {
      requestId: randomUUID(),
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model })),
    }
    const { candidatePeers, routePlanByPeerId } = selectCandidatePeersForRouting(peers, null, model, null, 'strict')
    const plan = this._planModelRoutes({
      modelPeers: candidatePeers,
      modelPlans: routePlanByPeerId,
      request,
      requestProtocol: null,
      requestedService: model,
      explicitProvider: null,
      requiredParameters: [],
      requestPolicy,
      preferredPeerId: null,
      deterministic: true,
    })
    const effective = plan.effectivePolicy
    const modelAllowed = policyAllowsModel(effective, model)
    return plan.verdicts
      .map((verdict): RoutePreviewCandidate => ({
        peerId: verdict.peer.peerId,
        displayName: verdict.peer.displayName ?? null,
        rank: modelAllowed ? verdict.rank : null,
        eligible: modelAllowed && verdict.eligible,
        reasons: modelAllowed ? verdict.reasons : ['model not allowed', ...verdict.reasons],
        inputUsdPerMillion: verdict.offer.inputUsdPerMillion ?? null,
        outputUsdPerMillion: verdict.offer.outputUsdPerMillion ?? null,
        trustScore: normalizedModelReputationScore(verdict.peer),
        selection: modelAllowed && verdict.eligible ? verdict.selection ?? null : null,
      }))
      .sort((a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY)
        || a.peerId.localeCompare(b.peerId))
  }

  /** Forget cached balances of an address, e.g. once a deposit sweep is credited. */
  invalidateBalances(address: string): void {
    this._balanceCache.invalidate(address.toLowerCase())
    this._balanceReader?.invalidate?.(address)
  }

  /**
   * On-chain balances for a buyer identity, cached ~15 s per address and
   * answered from the cache (refreshing in the background) for a while
   * after that. When the chain cannot be read the last values come back
   * with `stale: true`. `fresh` re-reads, at most every few seconds.
   */
  private async _readBalances(address: string, fresh = false): Promise<BuyerBalances> {
    const reader = this._balanceReader!
    const key = address.toLowerCase()
    const cached = this._balanceCache.peek<BuyerBalances>(key)
    const force = fresh && (!cached || Date.now() - cached.fetchedAt >= BALANCE_FRESH_FLOOR_MS)
    if (force) reader.invalidate?.(address)
    const result = await this._balanceCache.read<BuyerBalances>(key, { ttlMs: BALANCE_CACHE_TTL_MS, staleWhileRevalidateMs: BALANCE_REVALIDATE_MS, force }, async () => {
      const [balance, wallet, creditLimit, operator] = await Promise.allSettled([
        reader.getBuyerBalance(address),
        reader.getUSDCBalance(address),
        reader.getBuyerCreditLimit(address),
        reader.getOperator(address),
      ])
      if (balance.status === 'rejected') throw balance.reason
      return {
        address,
        available: formatUsdcBaseUnits(balance.value.available),
        reserved: formatUsdcBaseUnits(balance.value.reserved),
        walletUsdc: wallet.status === 'fulfilled' ? formatUsdcBaseUnits(wallet.value) : null,
        creditLimit: creditLimit.status === 'fulfilled' ? formatUsdcBaseUnits(creditLimit.value) : null,
        operator: operator.status === 'fulfilled' && operator.value && operator.value.toLowerCase() !== ZERO_ADDRESS
          ? operator.value
          : null,
        ...(reader.isStale?.(address) ? { stale: true } : {}),
      }
    })
    return result.stale ? { ...result.value, stale: true } : result.value
  }

  /**
   * Endpoints the local gateway calls with the control secret. Returns false
   * when the path is not one of them, so the regular control plane handles it.
   */
  private async _handleGatewayControl(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<boolean> {
    const url = new URL(path, 'http://localhost')
    const handlers: Record<string, () => void | Promise<void>> = {
      'GET /_antseed/route-preview': () => this._handleRoutePreview(req, res, url),
      'GET /_antseed/balances': () => this._handleBalances(res, url),
      // Routing preferences are reloaded from the config file, so they are never overridden.
      'GET /_antseed/setting-overrides': () => sendJson(res, 200, { overrides: this._settingOverrides }),
      'POST /_antseed/restart': () => this._handleRestart(res),
    }
    const handler = handlers[`${method} ${url.pathname}`]
    if (!handler) return false
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !this._isGatewayAuthenticated(req.headers)) {
      sendJson(res, 401, { ok: false, error: 'gateway_auth_required' })
      return true
    }
    await handler()
    return true
  }

  /** `GET /_antseed/route-preview?model=<id>`, optionally under a policy header. */
  private async _handleRoutePreview(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const model = url.searchParams.get('model')?.trim() ?? ''
    if (!model) {
      sendJson(res, 400, { ok: false, error: 'model is required' })
      return
    }
    const encoded = req.headers[ROUTING_POLICY_HEADER]
    const raw = Array.isArray(encoded) ? encoded[0] : encoded
    let policy: RoutingPolicy | null = null
    if (raw !== undefined) {
      policy = decodePolicyHeader(raw)
      if (!policy) {
        sendJson(res, 400, { ok: false, error: 'invalid_routing_policy' })
        return
      }
      if (Object.keys(meaningfulPolicy(policy)).length === 0) policy = null
    }
    // `buyer`: the top level of the chain (hard limits plus routing
    // preferences), so the console can show it (max pricing lives in the
    // router plugin's config).
    sendJson(res, 200, { model, candidates: await this._routePreview(model, policy), buyer: this._buyerPolicy() })
  }

  /** `GET /_antseed/balances?identity=<name>`: on-chain balances of a buyer identity. */
  private async _handleBalances(res: ServerResponse, url: URL): Promise<void> {
    const identity = await this._resolveBuyerIdentity(url.searchParams.get('identity') ?? undefined)
    if (identity === undefined) {
      sendUnknownBuyerIdentity(res)
      return
    }
    if (!this._balanceReader) {
      sendJson(res, 503, { ok: false, error: 'payments_disabled' })
      return
    }
    const name = identity ?? DEFAULT_BUYER_IDENTITY
    const address = this._node.buyerIdentities?.().find((entry) => entry.name === name)?.address
    if (!address) {
      sendUnknownBuyerIdentity(res)
      return
    }
    try {
      sendJson(res, 200, await this._readBalances(address, url.searchParams.get('fresh') === '1'))
    } catch (err) {
      sendJson(res, 502, { ok: false, error: `Balance read failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /**
   * `POST /_antseed/restart`. Only offered under a supervisor that brings the
   * buyer back (see `buyer start`); otherwise the console asks the operator
   * to restart it.
   */
  private _handleRestart(res: ServerResponse): void {
    const restartHandler = this._restartHandler
    if (!restartHandler) {
      sendJson(res, 503, { ok: false, error: 'restart_unsupported' })
      return
    }
    const waitMs = this._restartAllowedAt - Date.now()
    if (!this._restartRequested && waitMs > 0) {
      res.setHeader('retry-after', String(Math.ceil(waitMs / 1000)))
      sendJson(res, 429, { ok: false, error: 'restart_too_soon' })
      return
    }
    if (!this._restartRequested) {
      this._restartRequested = true
      log('Restart requested by the local gateway; shutting down gracefully.')
      res.once('finish', () => {
        setImmediate(() => {
          void Promise.resolve().then(restartHandler).catch((err: unknown) => {
            console.error('[proxy] restart failed:', err instanceof Error ? err.message : String(err))
          })
        })
      })
    }
    res.writeHead(202, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ ok: true, restarting: true }))
  }

  /**
   * Remember which chat a request belongs to for the life of the request plus
   * a grace window — the seller-initiated auth path can land just after the
   * response is returned. Bounded so a leaked id can't grow the map forever.
   */
  private _trackRequestConversation(requestId: string, convId: string, parentRequestId?: string, purpose?: 'routing'): void {
    if (this._requestConversations.has(requestId)) throw new Error('Request ID already tracked')
    // Inference retries share one turn counter; recommendation purchases have their own cost entry.
    const parent = !purpose && parentRequestId ? this._requestConversations.get(parentRequestId) : undefined
    this._requestConversations.set(requestId, parent?.convId === convId ? parent : { convId, counted: false, purpose })
    while (this._requestConversations.size > MAX_TRACKED_REQUEST_CONVERSATIONS) {
      const oldest = this._requestConversations.keys().next().value
      if (oldest === undefined) break
      this._requestConversations.delete(oldest)
    }
  }

  /**
   * Attach the hot-wallet deposit watcher (owned by `buyer start`), or record
   * why none runs so the status endpoint can report the cause.
   */
  setDepositWatcher(watcher: DepositWatcher | null, absenceReason: DepositWatcherAbsenceReason | null = null): void {
    this._depositWatcher = watcher
    this._depositWatcherAbsence = watcher ? null : absenceReason
  }

  /** Attach (or detach with null) the deposit watcher of a named buyer identity. */
  setIdentityDepositWatcher(identity: string, watcher: DepositWatcher | null): void {
    if (watcher) this._identityDepositWatchers.set(identity, watcher)
    else this._identityDepositWatchers.delete(identity)
  }

  /** Watcher for an identity (null = default) and, when there is none, why. */
  private _depositWatcherFor(identity: string | null): { watcher: DepositWatcher | null; reason: DepositWatcherAbsenceReason | null } {
    const watcher = identity ? this._identityDepositWatchers.get(identity) ?? null : this._depositWatcher
    if (watcher) return { watcher, reason: null }
    // A named identity without a watcher shares the default's cause; if the
    // default has one, the identity simply has not been given one yet.
    return { watcher: null, reason: this._depositWatcherAbsence ?? (identity ? 'identity-not-watched' : null) }
  }

  /** Writes down a deposit the watcher saw credited, for the gateway's deposit confirmations. */
  recordDeposit(address: string, entry: DepositLogEntry): void {
    void this._depositLog.record(address, entry).catch((err: unknown) => {
      log(`deposit log: could not record ${entry.txHash}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** Latest relayer receipt for a sweep authNonce, if one has arrived. */
  getSweepReceipt(authNonce: string): SweepReceiptPayload | null {
    return this._sweepReceipts.get(authNonce.toLowerCase()) ?? null
  }

  async start(): Promise<void> {
    this._startedAtMs = Date.now()
    // Clean up temp files orphaned by state writes whose rename failed in a
    // previous run — each carries a full discovered-peers snapshot, so left
    // alone they accumulate into real disk usage.
    await sweepStaleStateTmpFiles(this._stateDir)
    // Hydrate the in-memory peer cache from the persisted state file BEFORE
    // the server starts accepting requests. This lets the first request after
    // startup route from the warm cache without blocking on DHT discovery.
    // The background refresh still runs to pick up fresh peers and IP changes.
    await this._hydratePeersFromStateFile()
    try {
      const state = JSON.parse(await readFile(this._stateFile, 'utf8'))
      this._resourceRoutes.hydrate(state.resourceRoutes)
    } catch (error) {
      // Routes that could not be read may come back on a later start: until then no job is said to be retired.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this._resourceRoutesUnread = true
        console.warn(`[buyer-proxy] Could not read saved video routes: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Adopt persisted session overrides (peer pin, default routed model) so
    // they survive daemon restart. A --peer CLI flag beats the persisted pin
    // at startup; runtime `connection set` writes still take over via the
    // state-file watcher.
    await this._reloadSessionOverrides({ preservePeerPin: this._pinnedPeer !== null })
    await new Promise<void>((resolve, reject) => {
      this._server.once('error', reject)
      this._server.listen(this._port, '127.0.0.1', () => {
        this._server.removeListener('error', reject)
        resolve()
      })
    })
    try {
      const address = this._server.address()
      await this._teeControl.publish(this._stateDir, typeof address === 'object' && address ? address.port : this._port)
    } catch (error) {
      await new Promise<void>((resolve) => this._server.close(() => resolve()))
      throw error
    }
    this._startBackgroundRefresh()
    this._startSuspendHeartbeat()
    // Trigger initial discovery immediately so the desktop can show services
    // without waiting for the first request or 5-minute interval. The sweep
    // emits each accepted metadata document as it arrives, so buyer.state.json
    // gets useful rows while slower endpoints continue timing out.
    this._startIncrementalDiscoverySweep()
    await this._writeStateFile('connected')
    this._watchStateFile()
    this._watchConfigFile()
  }

  private async _hydratePeersFromStateFile(): Promise<void> {
    try {
      const raw = await readFile(this._stateFile, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      // Cooldowns survive a restart — a peer that died ten seconds before we
      // exited is still dead — but the parser clamps anything expired or
      // impossibly distant, so a restart can never extend one. Nothing new can
      // escalate until a success re-establishes that the buyer is healthy.
      this._peerHealth = parsePersistedPeerHealth(parsed, this._now())
      this._sellerHealth = SellerHealthBook.parse((parsed as { sellerHealth?: unknown }).sellerHealth, this._now())
      const peers = parsePersistedPeers(parsed)
      if (peers.length === 0) {
        return
      }
      this._cachedPeers = peers
      this._teeVerification.observePeers(peers)
      // Preserve the original discovery timestamp so cacheAgeMs reflects how
      // long ago the persisted data was actually written, not startup time.
      const peersUpdatedAt = (parsed as { peersUpdatedAt?: unknown }).peersUpdatedAt
      this._cacheLastUpdatedAtMs = typeof peersUpdatedAt === 'number' && Number.isFinite(peersUpdatedAt)
        ? peersUpdatedAt
        : Date.now()
      this._cacheMutationEpoch += 1
      log(`Hydrated ${peers.length} peer(s) from ${this._stateFile}`)
    } catch {
      // File missing, unreadable, or malformed — non-fatal. The background
      // refresh will populate the cache shortly.
    }
  }

  async stop(): Promise<void> {
    this._teeVerification.close()
    await this._teeControl.close()
    if (this._peerHealthPersistTimer) {
      clearTimeout(this._peerHealthPersistTimer)
      this._peerHealthPersistTimer = null
      await this._persistPeerHealthToState().catch(() => {})
    }
    if (this._stateWatchDebounce) {
      clearTimeout(this._stateWatchDebounce)
      this._stateWatchDebounce = null
    }
    if (this._stateFileWatching) {
      unwatchFile(this._stateFile)
      this._stateFileWatching = false
    }
    if (this._configWatchDebounce) {
      clearTimeout(this._configWatchDebounce)
      this._configWatchDebounce = null
    }
    if (this._configFileWatching && this._configPath) {
      unwatchFile(this._configPath)
      this._configFileWatching = false
    }
    if (this._bgRefreshHandle) {
      clearInterval(this._bgRefreshHandle)
      this._bgRefreshHandle = null
    }
    if (this._heartbeatHandle) {
      clearInterval(this._heartbeatHandle)
      this._heartbeatHandle = null
    }
    await this._writeStateFile('stopped')
    await this._conversations.flush()
    // Requests in flight finish (a supervisor restarting the buyer holds new
    // ones meanwhile), up to the drain limit.
    return new Promise((resolve) => {
      const drain = setTimeout(() => this._server.closeAllConnections(), BUYER_SHUTDOWN_DRAIN_MS)
      drain.unref?.()
      this._server.close(() => {
        clearTimeout(drain)
        this._spendAttribution.close()
        resolve()
      })
    })
  }

  private _watchStateFile(): void {
    // Use watchFile (stat polling) rather than watch(): we rewrite
    // buyer.state.json via rename(tmp, stateFile), and fs.watch on Linux is
    // bound to the original inode — after the atomic rename it stops firing,
    // silently breaking `antseed buyer connection set`. watchFile compares
    // stat each tick and works across inode replacement.
    try {
      watchFile(this._stateFile, { persistent: false, interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs && curr.ino === prev.ino) return
        if (this._stateWatchDebounce) clearTimeout(this._stateWatchDebounce)
        this._stateWatchDebounce = setTimeout(() => {
          this._stateWatchDebounce = null
          void this._reloadSessionOverrides().catch(() => {})
        }, 50)
      })
      this._stateFileWatching = true
    } catch {
      // watcher setup failed; non-fatal
    }
  }

  private _validateRouterSelection(value: unknown): asserts value is RouterSelection & { service: RoutingServiceTarget } {
    if (!isRoutingSelection(value) || value.kind !== 'router') throw new Error('Invalid router selection')
    if (!value.service) throw new Error('Select an exact routing-service target')
  }

  /** Parses the `router` field of `POST /_antseed/route` (`{ service, options?, allowedModels? }`). */
  private _parseDefaultRouter(value: unknown): DefaultRouterSelection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('router must be { service, options?, allowedModels? }')
    const selection = { ...(value as Record<string, unknown>), kind: 'router' }
    this._validateRouterSelection(selection)
    return structuredClone(selection)
  }

  /**
   * Check a router selection's options against the protocol its router advertises, when the
   * router is in the peer cache; throws `InvalidRouterOptionsError`. An unknown router is
   * checked again before each ranking.
   */
  private async _checkRouterOptions(selection: RouterSelection): Promise<void> {
    if (!selection.service || selection.options === undefined) return
    let peers: PeerInfo[]
    try {
      peers = await this._getPeers()
    } catch {
      return // Discovery is unavailable: the options are checked again before each ranking.
    }
    const protocol = routingProtocolOfTarget(peers, selection.service)
    if (protocol) validateRouterOptions(routingClientAdapter(protocol).options, selection.options)
  }

  /** The default router in its wire form, without the internal `kind` tag. */
  private get _defaultRouterJson(): Omit<DefaultRouterSelection, 'kind'> | null {
    if (!this._defaultRouter) return null
    const { kind: _kind, ...router } = this._defaultRouter
    return router
  }

  private async _reloadSessionOverrides(opts: { preservePeerPin?: boolean } = {}): Promise<void> {
    try {
      const raw = await readFile(this._stateFile, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!opts.preservePeerPin) {
        const pinnedPeer = typeof parsed.pinnedPeerId === 'string' && parsed.pinnedPeerId.trim().length > 0
          ? parsed.pinnedPeerId.trim().toLowerCase()
          : null
        this._pinnedPeer = pinnedPeer
      }
      const routedModel = typeof parsed.defaultRoutedModel === 'string' ? parsed.defaultRoutedModel.trim() : ''
      this._defaultRoutedModel = routedModel.length > 0 && isValidRoutedModelTarget(routedModel) ? routedModel : null
      try {
        this._defaultRouter = null
        if (parsed.defaultRouter != null && this._defaultRoutedModel === null) {
          this._defaultRouter = this._parseDefaultRouter(parsed.defaultRouter)
        }
      } catch {
        this._defaultRouter = null
      }
      log(`Session overrides reloaded: peer=${this._pinnedPeer ?? 'none'} route=${this._defaultRoutedModel ?? 'none'} router=${JSON.stringify(this._defaultRouterJson)}`)
    } catch {
      // state file unreadable; keep current values
    }
  }

  private _watchConfigFile(): void {
    if (!this._configPath) return
    try {
      watchFile(this._configPath, { persistent: false, interval: 500 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs && curr.ino === prev.ino) return
        if (this._configWatchDebounce) clearTimeout(this._configWatchDebounce)
        this._configWatchDebounce = setTimeout(() => {
          this._configWatchDebounce = null
          void this._reloadRoutingPreferences().catch(() => {})
        }, 50)
      })
      this._configFileWatching = true
    } catch {
      // Config watcher failure is non-fatal; startup preferences remain active.
    }
  }

  private async _reloadRoutingPreferences(): Promise<void> {
    if (!this._configPath) return
    // `telemetry.enabled` is read on its own, so a bad routing field cannot keep an opt-out from applying.
    this._telemetry?.reloadConsent()
    try {
      const config = await loadConfig(this._configPath)
      // Read straight from the file: no CLI flag or env var overrides routing
      // preferences, and resolving the full effective buyer config would let
      // an unrelated invalid field block this reload.
      const next = config.buyer.routingPreferences
      this._routingPreferences = {
        ...next,
        allowedPeerIds: [...next.allowedPeerIds],
        blockedPeerIds: [...next.blockedPeerIds],
      }
      // `minPeerReputation` (like max pricing) is not reloaded: the router
      // plugin enforces it with the value it started with, so it applies on
      // restart only, and the proxy keeps the same value to stay in step.
      log(
        `Routing preferences reloaded: minTrust=${next.minTrustScore} maxInput=${next.maxInputUsdPerMillion} `
        + `preferFree=${next.preferFreePeers} allow=${next.allowedPeerIds.length} block=${next.blockedPeerIds.length}`,
      )
    } catch (err) {
      log(`Routing preferences reload ignored: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Stamp the last model-request activity time (dispatch or streamed frame). */
  private _markModelActivity(): void {
    this._lastModelActivityAt = Date.now()
  }

  /** Serialised read-modify-write to buyer.state.json. Returns the queued write promise. */
  private _mergeStateFile(patch: Record<string, unknown>): Promise<void> {
    this._stateWriteChain = this._stateWriteChain.then(async () => {
      try {
        await mergeJsonStateFile(this._stateDir, this._stateFile, patch)
      } catch (err) {
        // Non-fatal for the proxy, but the write itself is lost — session
        // pin, default route, and peer-cache updates in this patch were not
        // persisted. Always audible: state writes are minutes apart.
        console.error('[proxy] buyer.state.json write failed:', err instanceof Error ? err.message : String(err))
      }
    }).catch(() => {})
    return this._stateWriteChain
  }

  private async _serializeVideoJob(job: string, run: () => Promise<void>): Promise<void> {
    const previous = this._videoJobQueues.get(job) ?? Promise.resolve()
    const current = previous.then(run, run)
    const tail = current.catch(() => {})
    this._videoJobQueues.set(job, tail)
    try {
      await current
    } finally {
      if (this._videoJobQueues.get(job) === tail) this._videoJobQueues.delete(job)
    }
  }

  /**
   * Retires a video job that failed or that its seller no longer has: later
   * retrieves get `video_route_not_found` and never reach the seller, so it can
   * never be delivered or charged, and a gateway may release the price it held
   * for it. False (route kept) when the retirement could not be saved, so a
   * restart cannot bring the job back.
   */
  private async _retireVideoJob(protocol: NativeVideoProtocol, resourceId: string): Promise<boolean> {
    if (!this._resourceRoutes.resolve(protocol, resourceId)) return true
    // The route stays usable until the retirement is saved: a retrieve arriving meanwhile waits its turn
    // (retrieves of one job run one at a time) instead of seeing the job as gone before that is durable.
    const key = `${protocol}\n${resourceId}`
    this._retiringVideoJobs.add(key)
    try {
      await this._persistResourceRoutes()
      this._resourceRoutes.forget(protocol, resourceId)
      return true
    } catch (error) {
      console.error('[proxy] Retired video route was not saved; the job is kept:', error)
      return false
    } finally {
      this._retiringVideoJobs.delete(key)
    }
  }

  private async _persistResourceRoutes(): Promise<void> {
    const write = this._stateWriteChain.then(() => mergeJsonStateFile(this._stateDir, this._stateFile, {
      resourceRoutes: this._resourceRoutes.snapshot().filter((route) => !this._retiringVideoJobs.has(`${route.protocol}\n${route.resourceId}`)),
    }))
    this._stateWriteChain = write.catch(() => {})
    return write
  }

  private async _writeStateFile(state: 'connected' | 'stopped'): Promise<void> {
    // When stopping, preserve whatever session overrides are already
    // in the file — the debounce may have been cancelled before
    // _reloadSessionOverrides could commit the latest CLI-written values.
    const sessionOverrides = state === 'connected'
      ? { pinnedPeerId: this._pinnedPeer, defaultRoutedModel: this._defaultRoutedModel, defaultRouter: this._defaultRouterJson }
      : {}
    await this._mergeStateFile({
      state,
      pid: process.pid,
      port: this._port,
      ...sessionOverrides,
    })
  }

  private _startIncrementalDiscoverySweep(): void {
    this._node.startBackgroundPeerDiscoverySweep()
  }

  private _startBackgroundRefresh(): void {
    this._bgRefreshHandle = setInterval(() => {
      this._startIncrementalDiscoverySweep()
      void this._refreshPeersNow().catch(() => {
        // background refresh failure is non-fatal
      })
    }, this._bgRefreshIntervalMs)
  }

  private _replacePeers(incoming: PeerInfo[]): void {
    const incomingById = new Map(incoming.map((p) => [p.peerId, p]))
    const prevById = new Map(this._cachedPeers.map((p) => [p.peerId, p]))
    const now = Date.now()

    // For peers re-observed in this scan, preserve `lastReachedAt` from the
    // previous cache entry — the DHT announcement doesn't carry that field,
    // and losing it on each refresh would defeat the carry-forward tracking.
    const merged: PeerInfo[] = incoming.map((peer) => {
      const prev = prevById.get(peer.peerId)
      if (!prev) return peer
      const metadata = peer.metadata || prev.metadata
        ? { ...(prev.metadata ?? {}), ...(peer.metadata ?? {}) } as PeerMetadata
        : undefined
      const mergedPeer: PeerInfo = {
        ...prev,
        ...peer,
        ...(metadata ? { metadata } : {}),
      }
      // The seller's announced catalog comes only from this scan: a seller
      // that stopped advertising a service (for example after failed health
      // checks) leaves these fields out, and the cached copy must not survive.
      for (const field of PEER_CATALOG_FIELDS) {
        if (peer[field] === undefined) delete mergedPeer[field]
      }
      if (prev.lastReachedAt && (!peer.lastReachedAt || prev.lastReachedAt > peer.lastReachedAt)) {
        mergedPeer.lastReachedAt = prev.lastReachedAt
      }
      return mergedPeer
    })

    // Carry forward previously known peers that are missing from this scan.
    // A missed DHT scan doesn't mean the peer is unavailable — it just wasn't
    // discovered this time. Use the fresher of `lastSeen` and `lastReachedAt`
    // as the liveness anchor: a recently-contacted peer survives even if its
    // DHT record has aged out.
    for (const prev of this._cachedPeers) {
      if (incomingById.has(prev.peerId)) continue
      const freshnessAnchor = Math.max(prev.lastSeen, prev.lastReachedAt ?? 0)
      if (freshnessAnchor > 0 && now - freshnessAnchor < CARRY_FORWARD_TTL_MS) {
        merged.push({ ...prev })
      }
    }

    this._cachedPeers = merged
    this._teeVerification.observePeers(merged)
    this._cacheLastUpdatedAtMs = Date.now()
    this._cacheMutationEpoch += 1
    this._persistPeersToState()
  }

  private _persistPeersToState(): void {
    // Write discovered peers to buyer.state.json so the dashboard can read them
    // without running its own DHT node.
    const peers = this._cachedPeers.map((p) => {
      // Extract service names from providerPricing entries.
      const services: string[] = []
      if (p.providerPricing) {
        for (const entry of Object.values(p.providerPricing)) {
          if (entry.services) {
            services.push(...Object.keys(entry.services))
          }
        }
      }
      return {
        peerId: p.peerId,
        displayName: p.displayName ?? null,
        publicAddress: p.publicAddress ?? null,
        providers: p.providers,
        capabilities: p.capabilities ?? p.metadata?.capabilities ?? [],
        services,
        providerPricing: p.providerPricing ?? null,
        providerServiceCategories: p.providerServiceCategories ?? null,
        providerServiceApiProtocols: p.providerServiceApiProtocols ?? null,
        providerServiceUnitBillingModels: p.providerServiceUnitBillingModels ?? null,
        providerServiceCapabilities: p.providerServiceCapabilities ?? null,
        defaultInputUsdPerMillion: p.defaultInputUsdPerMillion ?? 0,
        defaultOutputUsdPerMillion: p.defaultOutputUsdPerMillion ?? 0,
        defaultCachedInputUsdPerMillion: p.defaultCachedInputUsdPerMillion ?? null,
        maxConcurrency: p.maxConcurrency ?? 0,
        currentLoad: p.currentLoad ?? null,
        // On-chain stats read authoritatively by the buyer from AntseedChannels,
        // the seller pools, usage accounting and the wash-trading registry.
        // Persisted so CLI/desktop surfaces can render richer UI without their
        // own duplicate RPC and trust-score implementations. The node already
        // scored the peer; `onChainReputationScore` is the trust score and
        // `trust` its breakdown.
        onChainAgentId: p.onChainAgentId ?? null,
        onChainChannelCount: p.onChainChannelCount ?? null,
        onChainGhostCount: p.onChainGhostCount ?? null,
        onChainTotalVolumeUsdcMicros: p.onChainTotalVolumeUsdcMicros ?? null,
        onChainLastSettledAtSec: p.onChainLastSettledAtSec ?? null,
        onChainStakedAtSec: p.onChainStakedAtSec ?? null,
        onChainUsageEpoch: p.onChainUsageEpoch ?? null,
        onChainUsageShareBps: p.onChainUsageShareBps ?? null,
        onChainUsageLastEpochUsdcMicros: p.onChainUsageLastEpochUsdcMicros ?? null,
        onChainPoolStakeAnts: p.onChainPoolStakeAnts ?? null,
        onChainPoolPowerShareBps: p.onChainPoolPowerShareBps ?? null,
        onChainWashFlagged: p.onChainWashFlagged ?? null,
        onChainWashShareBps: p.onChainWashShareBps ?? null,
        onChainReputationScore: p.onChainReputationScore ?? null,
        trust: p.trust ?? null,
        onChainSybilRisk: p.onChainSybilRisk ?? null,
        onChainSybilFlags: p.onChainSybilFlags ?? null,
        onChainStatsFetchedAt: p.onChainStatsFetchedAt ?? null,
        // Persisted so cold-started buyers can still resolve the facade address
        // for channelId derivation. See parsePersistedPeers for the round-trip.
        sellerContract: p.metadata?.sellerContract ?? null,
        // External ownership claims and buyer-computed proof results. Claim
        // verification runs asynchronously after discovery, so this may be
        // null on first sighting and filled by a later peers:discovered update.
        verifications: p.metadata?.verifications ?? null,
        verificationResults: p.verificationResults ?? null,
        lastSeen: p.lastSeen,
        lastReachedAt: p.lastReachedAt ?? null,
      }
    })
    const onChainRefreshedAt = this._cachedPeers
      .map((p) => p.onChainStatsFetchedAt ?? 0)
      .reduce((max, v) => (v > max ? v : max), 0)
    this._mergeStateFile({
      discoveredPeers: peers,
      peersUpdatedAt: Date.now(),
      ...(onChainRefreshedAt > 0 ? { onChainStatsRefreshedAt: onChainRefreshedAt } : {}),
    })
  }

  /**
   * Record a failed request against a peer.
   *
   * Recording is unconditional — the streak and reason are useful diagnostics
   * either way — but only failures the attribution gates accept as the peer's
   * own move the cooldown. Discovery metadata is never evicted: a cooling-down
   * peer stays routable, it just stops being *chosen*.
   */
  private _recordPeerFailure(
    peerId: string,
    reason: PeerFailureReason,
    fault: FaultAttribution = 'unknown',
  ): void {
    const now = this._now()
    const { verdict, rollbackPeerIds } = this._attribution.classify({
      peerId,
      reasonEscalates: reasonEscalates(reason),
      fault,
      now,
    })

    const previous = this._peerHealth.get(peerId)
    const entry = recordPeerFailureEntry(previous, reason, now, verdict.escalate)
    this._peerHealth.set(peerId, entry)

    if (rollbackPeerIds.length > 0) {
      this._rollbackPeerHealth(rollbackPeerIds, 'buyer-side outage detected')
    }

    if (verdict.escalate && isCoolingDown(entry, now)) {
      const seconds = Math.round((entry.cooldownUntil - now) / 1000)
      log(
        `Peer ${peerId.slice(0, 12)}... cooling down for ${seconds}s after `
        + `${entry.failureStreak} failures (reason=${reason}).`,
      )
    } else {
      const why = verdict.escalate ? 'below cooldown threshold' : verdict.suppressedBy
      log(
        `Peer ${peerId.slice(0, 12)}... failure recorded (reason=${reason}); `
        + `not cooling down: ${why}.`,
      )
    }

    void this._persistPeerHealthToState()
  }

  /**
   * Fold a seller's HTTP response into that peer's health.
   *
   * Control-plane paths are exempt for the same reason `isRouterSuccess`
   * exempts them: a failing `/v1/models` says nothing about the peer's ability
   * to serve inference.
   */
  private _recordPeerResponseHealth(peerId: string, statusCode: number, path: string): void {
    if (isControlPlaneServicesPath(path)) {
      if (isProofOfLife(statusCode)) this._rememberSuccessfulPeer(peerId)
      return
    }

    const reason = failureReasonForStatus(statusCode)

    if (reason && statusCode >= 500) {
      const now = this._now()
      if (isCoolingDown(this._peerHealth.get(peerId), now)) {
        this._rememberSuccessfulPeer(peerId)
      }
      this._recordPeerFailure(peerId, reason, 'peer')
      return
    }

    if (isProofOfLife(statusCode)) {
      // A 402, a 400, even a 429 — the peer answered, so it is alive and any
      // cooldown is stale. Throttling still gets stamped as the last reason so
      // "alive but refusing work" stays visible in diagnostics.
      this._rememberSuccessfulPeer(peerId)
      if (reason) {
        const entry = this._peerHealth.get(peerId)
        if (entry) {
          this._peerHealth.set(peerId, { ...entry, lastReason: reason, lastFailureAt: this._now() })
        }
      }
      return
    }

    if (reason) this._recordPeerFailure(peerId, reason, 'peer')
  }

  /**
   * Undo cooldowns that turned out to be our fault.
   *
   * When the attribution gates conclude the buyer itself was down — a suspend,
   * a dropped network — the failures recorded during that window blamed the
   * wrong party, so the streaks they created are wound back to zero.
   */
  private _rollbackPeerHealth(peerIds: readonly string[], why: string): void {
    let changed = false
    for (const peerId of peerIds) {
      const entry = this._peerHealth.get(peerId)
      if (!entry || (entry.failureStreak === 0 && entry.cooldownUntil === 0)) continue
      this._peerHealth.set(peerId, {
        ...entry,
        failureStreak: 0,
        windowStartedAt: 0,
        episodeStartedAt: 0,
        cooldownUntil: 0,
      })
      changed = true
    }
    if (changed) {
      log(`Cleared peer cooldowns for ${peerIds.length} peer(s): ${why}.`)
      void this._persistPeerHealthToState()
    }
  }

  /**
   * A peer told us it does not serve the requested model. Our cached
   * metadata for it is stale (the seller may have just unadvertised the
   * model after failing its own health checks), so refresh discovery
   * metadata in the background — throttled, since one broken model can
   * produce a burst of these.
   *
   * Deliberately does NOT touch peer health: the response itself is proof of
   * life (`_recordPeerResponseHealth` treats any sub-500 answer as such), and
   * a peer that is healthy for its other models must not cool down over one
   * stale catalog entry. The router still learns via `onResult(success:false)`
   * so scoring reflects the miss.
   */
  private _onModelNotFound(peerId: string, requestedService: string | null): void {
    const now = this._now()
    if (now - this._lastModelNotFoundRefreshAtMs < MODEL_NOT_FOUND_REFRESH_THROTTLE_MS) {
      return
    }
    this._lastModelNotFoundRefreshAtMs = now
    log(
      `Peer ${peerId.slice(0, 12)}... does not serve ${requestedService ?? 'the requested model'}; `
      + 'refreshing peer metadata in background.',
    )
    void this._refreshPeersNow().catch(() => {})
  }

  /**
   * Stamp `lastReachedAt` on a peer after a successful request so the
   * carry-forward heuristic can trust local transport liveness even when the
   * DHT record grows stale. Persisted so the signal survives restarts.
   *
   * A response is also proof that the buyer's own network, DHT, chain RPC and
   * wallet are working, which is what lets other peers' failures be attributed
   * to them rather than to us.
   */
  private _rememberSuccessfulPeer(peerId: string): void {
    const now = this._now()
    this._attribution.recordSuccess(peerId, now)

    const previous = this._peerHealth.get(peerId)
    if (previous && (previous.failureStreak > 0 || previous.cooldownUntil > 0)) {
      log(`Peer ${peerId.slice(0, 12)}... recovered; cooldown cleared.`)
    }
    this._peerHealth.set(peerId, clearPeerHealthEntry(previous, now))
    void this._persistPeerHealthToState()

    const cached = this._cachedPeers.find((p) => p.peerId === peerId)
    if (cached) {
      cached.lastReachedAt = now
      this._persistPeersToState()
    }
  }

  /**
   * Watch for the wall clock jumping forward, which means the machine slept.
   * On wake every pending timeout and keepalive fires at once, so without this
   * a single closed lid would cool down every peer the buyer knows.
   */
  private _startSuspendHeartbeat(): void {
    if (this._heartbeatHandle) return
    this._attribution.onHeartbeat(this._now())
    this._heartbeatHandle = setInterval(() => {
      const result = this._attribution.onHeartbeat(this._now())
      if (result && result.rollbackPeerIds.length > 0) {
        this._rollbackPeerHealth(result.rollbackPeerIds, 'machine resumed from sleep')
      } else if (result) {
        log('Detected a wall-clock jump; suspending peer cooldowns briefly.')
      }
    }, HEARTBEAT_MS)
    this._heartbeatHandle.unref?.()
  }

  /** Persist health separately from `discoveredPeers`, which is rebuilt wholesale. */
  private async _persistPeerHealthToState(): Promise<void> {
    const now = this._now()
    this._peerHealth = prunePeerHealth(this._peerHealth, now)
    await this._mergeStateFile({
      peerHealth: serializePeerHealth(this._peerHealth),
      sellerHealth: this._sellerHealth.serialize(now),
      peerHealthUpdatedAt: now,
    })
  }

  private async _discoverPeersFromNetwork(): Promise<PeerInfo[]> {
    log('Discovering peers via DHT...')
    const peers = await this._node.discoverPeers()
    if (peers.length > 0) {
      log(`Found ${peers.length} peer(s)`)
    }
    return peers
  }

  private async _refreshPeersNow(): Promise<PeerInfo[]> {
    if (this._peerRefreshPromise) {
      return this._peerRefreshPromise
    }

    const previousCachedPeers = [...this._cachedPeers]
    const mutationEpochAtStart = this._cacheMutationEpoch
    this._peerRefreshPromise = (async () => {
      const peers = await this._discoverPeersFromNetwork()
      if (peers.length > 0) {
        this._consecutiveEmptyDiscoveries = 0
        this._replacePeers(peers)
        return peers
      }
      this._consecutiveEmptyDiscoveries += 1

      const fallbackPeers = previousCachedPeers.length > 0 && this._cacheMutationEpoch === mutationEpochAtStart
        ? [...previousCachedPeers]
        : []
      if (fallbackPeers.length > 0) {
        // Preserve stale cache as fallback when discovery transiently fails.
        log('Discovery returned 0 peers; preserving most-recent cached peers as fallback.')
        this._replacePeers(fallbackPeers)
        return fallbackPeers
      }
      return peers
    })().finally(() => {
      this._peerRefreshPromise = null
    })

    return this._peerRefreshPromise
  }

  private async _getPeers(options?: { forceRefresh?: boolean }): Promise<PeerInfo[]> {
    const forceRefresh = options?.forceRefresh === true
    const cacheAgeMs = Date.now() - this._cacheLastUpdatedAtMs
    const cacheFresh = this._cacheLastUpdatedAtMs > 0 && cacheAgeMs <= this._peerCacheTtlMs

    if (forceRefresh) {
      log('Forcing peer refresh before routing.')
      return this._refreshPeersNow()
    }

    if (this._cachedPeers.length > 0) {
      if (cacheFresh) {
        return this._cachedPeers
      }

      const now = Date.now()
      if (now - this._lastStaleCacheLogAtMs >= 10_000) {
        this._lastStaleCacheLogAtMs = now
        log(`Peer cache stale (${cacheAgeMs}ms old); routing from cached peers.`)
      }
      return this._cachedPeers
    }

    // No cached peers yet — block on initial discovery.
    return this._refreshPeersNow()
  }

  private _formatPeerSelectionDiagnostics(peers: PeerInfo[]): string {
    if (peers.length === 0) {
      return 'No peers discovered.'
    }

    const summarize = (peer: PeerInfo): string => {
      const providers = peer.providers
        .map((provider) => provider.trim())
        .filter((provider) => provider.length > 0)
      const rep = Number.isFinite(peer.reputationScore) ? String(peer.reputationScore) : 'n/a'
      const onChain = Number.isFinite(peer.onChainChannelCount) ? String(peer.onChainChannelCount) : 'n/a'
      const input = Number.isFinite(peer.defaultInputUsdPerMillion) ? String(peer.defaultInputUsdPerMillion) : 'n/a'
      const output = Number.isFinite(peer.defaultOutputUsdPerMillion) ? String(peer.defaultOutputUsdPerMillion) : 'n/a'

      return `${peer.peerId.slice(0, 8)} providers=[${providers.join(',') || 'none'}] rep=${rep} onchain=${onChain} in=${input} out=${output}`
    }

    const samples = peers.slice(0, 5).map((peer) => summarize(peer)).join(' | ')
    const suffix = peers.length > 5 ? ` (+${peers.length - 5} more)` : ''
    return `Discovered ${peers.length} peer(s): ${samples}${suffix}`
  }

  private async _handleControlPlane(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> {
    if (path.startsWith('/_antseed/verification')) {
      await this._teeControl.handle(req, res, method, path,
        () => this._teeVerification.snapshot(this._cachedPeers),
        async (peerId) => {
          const peer = this._cachedPeers.find((candidate) => candidate.peerId === peerId)
          if (!peer || !parseVerifierCapabilities(peer.capabilities).supported.includes(TEE_VERIFIER_ID)) {
            throw new Error('Seller is unknown or does not advertise TEE support')
          }
          if (!this._verifier) throw new Error('Verification is disabled by the buyer CLI')
          const signal = AbortSignal.timeout(31_000)
          const outcome = await this._teeVerification.verifyForDisplay(peer,
            () => runVerifier({ require: false, prefer: [TEE_VERIFIER_ID] }, peer.peerId, peer.capabilities,
              (chosen) => makeVerifierReach(this._node, peer, chosen, signal), signal))
          if (outcome.code === 'busy') throw new Error(outcome.reason)
        }, this._isGatewayAuthenticated(req.headers))
      return
    }
    if (await this._handleGatewayControl(req, res, method, path)) return
    const origin = req.headers.origin ?? '';
    const isLocal = origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost') || origin === 'file://';
    if (isLocal) res.setHeader('Access-Control-Allow-Origin', origin);
    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(204)
      res.end()
      return
    }

    if (path === '/_antseed/status' && method === 'GET') {
      // Network reachability snapshot for UI diagnostics.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        dhtNodeCount: this._node.dhtNodeCount,
        consecutiveEmptyDiscoveries: this._consecutiveEmptyDiscoveries,
        peerCount: this._cachedPeers.length,
        peersUpdatedAt: this._cacheLastUpdatedAtMs > 0 ? this._cacheLastUpdatedAtMs : null,
        startedAt: this._startedAtMs,
        uptimeMs: this._startedAtMs > 0 ? Date.now() - this._startedAtMs : 0,
      }))
      return
    }

    if (path === '/_antseed/peers/refresh' && method === 'POST') {
      try {
        const peers = await this._refreshPeersNow()
        await this._stateWriteChain
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, total: peers.length }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: message }))
      }
      return
    }

    if (path === '/_antseed/peers' && method === 'GET') {
      const peers = await this._getPeers()
      const payload = peers.map((p) => ({
        peerId: p.peerId,
        displayName: p.displayName,
        publicAddress: p.publicAddress,
        providers: p.providers,
        capabilities: p.capabilities ?? p.metadata?.capabilities ?? [],
        providerPricing: p.providerPricing,
        providerServiceCategories: p.providerServiceCategories,
        providerServiceApiProtocols: p.providerServiceApiProtocols,
        providerServiceUnitBillingModels: p.providerServiceUnitBillingModels,
        providerServiceCapabilities: p.providerServiceCapabilities,
        reputationScore: p.reputationScore,
        onChainReputationScore: p.onChainReputationScore ?? null,
        trust: p.trust ?? null,
        onChainAgentId: p.onChainAgentId ?? null,
        onChainPoolStakeAnts: p.onChainPoolStakeAnts ?? null,
        onChainPoolPowerShareBps: p.onChainPoolPowerShareBps ?? null,
        onChainUsageEpoch: p.onChainUsageEpoch ?? null,
        onChainUsageShareBps: p.onChainUsageShareBps ?? null,
        onChainUsageLastEpochUsdcMicros: p.onChainUsageLastEpochUsdcMicros ?? null,
        onChainWashFlagged: p.onChainWashFlagged ?? null,
        onChainWashShareBps: p.onChainWashShareBps ?? null,
        maxConcurrency: p.maxConcurrency ?? null,
        currentLoad: p.currentLoad ?? null,
        onChainChannelCount: p.onChainChannelCount ?? null,
        onChainTotalVolumeUsdcMicros: p.onChainTotalVolumeUsdcMicros ?? null,
        onChainLastSettledAtSec: p.onChainLastSettledAtSec ?? null,
        onChainSybilRisk: p.onChainSybilRisk ?? null,
        verificationResults: p.verificationResults,
        lastSeen: p.lastSeen,
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, peers: payload }))
      return
    }

    if (path === '/_antseed/peer-health' && method === 'GET') {
      const now = this._now()
      const attribution = this._attribution.snapshot(now)
      // `buyerHealthy` and `suppressedUntil` are what make "why is this peer
      // (not) cooling down" answerable from outside the process.
      const peers = [...this._peerHealth.entries()].map(([peerId, entry]) => ({
        peerId,
        failureStreak: entry.failureStreak,
        lastFailureAt: entry.lastFailureAt,
        lastReason: entry.lastReason,
        cooldownUntil: entry.cooldownUntil,
        coolingDown: isCoolingDown(entry, now),
        cooldownMsRemaining: isCoolingDown(entry, now) ? entry.cooldownUntil - now : 0,
        lastSuccessAt: entry.lastSuccessAt,
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        now,
        buyerHealthy: this._attribution.isBuyerHealthy(now),
        lastAnySuccessAt: attribution.lastAnySuccessAt,
        suppressionActive: attribution.suppressedUntil > 0,
        suppressedUntil: attribution.suppressedUntil,
        lastSuppressedBy: attribution.lastSuppressedBy,
        peers,
        // What automatic routing has learned of each seller and model.
        sellerHealth: this._sellerHealth.entries(now).map(({ peerId, serviceId, stats }) => ({
          peerId,
          serviceId,
          successes: Math.round(stats.successes * 100) / 100,
          failures: Math.round(stats.failures * 100) / 100,
          firstTokenMs: stats.firstTokenMs === null ? null : Math.round(stats.firstTokenMs),
          tokensPerSecond: stats.tokensPerSecond === null ? null : Math.round(stats.tokensPerSecond),
          lastSuccessAt: stats.lastSuccessAt,
          lastFailureAt: stats.lastFailureAt,
          lastFailureReason: stats.lastFailureReason,
        })),
      }))
      return
    }

    if (path === '/_antseed/peer-health/clear' && method === 'POST') {
      const chunks: Buffer[] = []
      let totalSize = 0
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length
        if (totalSize > 8192) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      let peerId: string
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        peerId = typeof body.peerId === 'string' ? body.peerId.trim().toLowerCase() : ''
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      const normalized = normalizePeerId(peerId) ?? peerId
      if (!/^[0-9a-f]{40}$/.test(normalized)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'peerId must be a 40-character hex peer id' }))
        return
      }
      // Deliberately does not stamp a success: the user is asking us to give
      // the peer another chance, not asserting that it answered.
      this._rollbackPeerHealth([normalized], 'cleared by request')
      this._sellerHealth.forget(normalized)
      void this._persistPeerHealthToState()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, peerId: normalized }))
      return
    }

    if (path === '/_antseed/routing-services' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, services: await buildRoutingServices(await this._getPeers(), this._modelRoutingClient, this._node, this._routingModels) }))
      return
    }

    if (path === '/_antseed/route' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, model: this._defaultRoutedModel, router: this._defaultRouterJson }))
      return
    }

    if (path === '/_antseed/route' && method === 'POST') {
      const chunks: Buffer[] = []
      let totalSize = 0
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length
        if (totalSize > 8192) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      let body: Record<string, unknown>
      let model: string
      try {
        body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        model = typeof body.model === 'string' ? body.model.trim() : ''
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      let router: DefaultRouterSelection | null = null
      try {
        if (body.router != null) {
          if (model.length > 0) throw new Error('Set model or router, not both')
          router = this._parseDefaultRouter(body.router)
          await this._checkRouterOptions(router)
        }
        if (model.length > 0 && !isValidRoutedModelTarget(model)) {
          throw new Error('model must be "<service>", "<peerId>@<service>", or empty to clear')
        }
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        return
      }
      this._defaultRoutedModel = model.length > 0 ? model : null
      this._defaultRouter = router
      await this._mergeStateFile({ defaultRoutedModel: this._defaultRoutedModel, defaultRouter: this._defaultRouterJson })
      log(`Default route set: model=${this._defaultRoutedModel ?? 'none'} router=${JSON.stringify(this._defaultRouterJson)}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, model: this._defaultRoutedModel, router: this._defaultRouterJson }))
      return
    }

    if (path === '/_antseed/conversations' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, conversations: this._conversations.list() }))
      return
    }

    const conversationMatch = path.match(/^\/_antseed\/conversations\/(.+)$/)
    if (conversationMatch && method === 'GET') {
      let id = ''
      try {
        id = decodeURIComponent(conversationMatch[1] ?? '')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid conversation id' }))
        return
      }
      const conversation = this._conversations.get(id)
      res.writeHead(conversation ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(conversation
        ? { ok: true, conversation }
        : { ok: false, error: 'Unknown conversation' }))
      return
    }

    if (path === '/_antseed/conversations/update' && method === 'POST') {
      const chunks: Buffer[] = []
      let totalSize = 0
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length
        if (totalSize > 8192) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid conversation update')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      const id = typeof parsed.id === 'string' ? parsed.id : ''
      if (!id) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'id is required' }))
        return
      }
      if (parsed.delete === true) {
        const removed = this._conversations.remove(id)
        res.writeHead(removed ? 200 : 404, { 'content-type': 'application/json' })
        res.end(JSON.stringify(removed ? { ok: true } : { ok: false, error: 'Unknown conversation' }))
        return
      }
      let conversation = this._conversations.get(id)
      if (!conversation) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Unknown conversation' }))
        return
      }
      if ('routingSelection' in parsed) {
        try {
          if ('pinnedModel' in parsed) throw new Error('Update routingSelection or pinnedModel, not both')
          if (parsed.routingSelection !== null) {
            this._validateRouterSelection(parsed.routingSelection)
            await this._checkRouterOptions(parsed.routingSelection)
          }
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          return
        }
        const selection = parsed.routingSelection as ConversationRouterSelection | null
        conversation = this._conversations.setRoutingSelection(id, selection)!
      }
      if ('pinnedModel' in parsed) {
        const pin = typeof parsed.pinnedModel === 'string' ? parsed.pinnedModel.trim() : ''
        if (pin.length > 0 && !isValidRoutedModelTarget(pin)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'pinnedModel must be "<service>", "<peerId>@<service>", or empty to clear' }))
          return
        }
        // 'user' marks a seller the user chose for this specific chat — the
        // desktop's re-point sweep skips those; everything else stays 'auto'.
        const peerSource = parsed.peerSource === 'user' ? 'user' : 'auto'
        conversation = this._conversations.setPinnedModel(id, pin.length > 0 ? pin : null, peerSource)
        log(`Conversation ${id.slice(0, 40)} pin: ${pin || 'cleared'}${pin ? ` (${peerSource})` : ''}`)
      }
      if ('label' in parsed) {
        const label = typeof parsed.label === 'string' ? parsed.label : null
        conversation = this._conversations.setLabel(id, label)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, conversation }))
      return
    }

    if (path === '/_antseed/connect' && method === 'POST') {
      const chunks: Buffer[] = []
      let totalSize = 0
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length
        if (totalSize > 8192) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      let peerId: string
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        peerId = String(body.peerId ?? '')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      if (!peerId) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Missing peerId' }))
        return
      }
      const peers = await this._getPeers()
      const peer = peers.find((p) => p.peerId === peerId)
      if (!peer) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Peer not found in cache' }))
        return
      }
      try {
        await this._node.connectToPeer(peer)
        log(`Eager connection established to ${peerId.slice(0, 12)}...`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log(`Eager connection failed for ${peerId.slice(0, 12)}...: ${message}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: message }))
      }
      return
    }

    if (path.startsWith('/_antseed/buyer-identities') && method === 'GET') {
      await this._buyerIdentities.loadAll()
      sendJson(res, 200, { ok: true, identities: this._node.buyerIdentities() })
      return
    }

    if (path.startsWith('/_antseed/channels') && method === 'GET') {
      const all = /[?&]all=1/.test(path)
      const identity = await this._controlPlaneIdentity(path)
      if (identity === undefined) return sendUnknownBuyerIdentity(res)
      const channels = all
        ? this._node.getAllBuyerChannels(identity ?? undefined)
        : this._node.getActiveBuyerChannels(identity ?? undefined)
      const peers = await this._getPeers()
      const peersById = new Map<string, PeerInfo>(peers.map((peer) => [peer.peerId, peer]))
      const channelsWithCapabilities = channels.map((channel) => {
        const peer = peersById.get(channel.peerId)
        return {
          ...channel,
          sellerDisplayName: peer?.displayName?.trim() || null,
          cooperativeCloseSupported: peer ? peerSupportsCooperativeClose(peer) : false,
        }
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, channels: channelsWithCapabilities }))
      return
    }

    // Gateway only: the feed holds up to 7 days of per-seller spend and tags.
    // Once a control secret exists, reading it takes that secret and every
    // read acknowledges the events before its cursor (lets them be pruned).
    // Without one (no gateway on this data dir, e.g. a gateway started with
    // its own --data-dir), loopback callers read it unacknowledged, as before
    // the secret existed, so such a gateway keeps tracking spend.
    if (path.startsWith('/_antseed/attributed-spend') && method === 'GET') {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(res, 401, { ok: false, error: 'gateway_auth_required' })
        return
      }
      const hasSecret = this._readControlSecret() !== null
      if (hasSecret && !this._isGatewayAuthenticated(req.headers)) {
        sendJson(res, 401, { ok: false, error: 'gateway_auth_required' })
        return
      }
      const after = Number(new URL(path, 'http://localhost').searchParams.get('after') ?? '0')
      sendJson(res, 200, { ok: true, ...this._spendAttribution.page(Number.isFinite(after) ? after : 0, { ack: hasSecret }) })
      return
    }

    if (path.startsWith('/_antseed/buyer-usage') && method === 'GET') {
      const identity = await this._controlPlaneIdentity(path)
      if (identity === undefined) return sendUnknownBuyerIdentity(res)
      const totals = this._node.getBuyerUsageTotals(identity ?? undefined)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, totals, lastActivityAt: this._lastModelActivityAt || null }))
      return
    }

    const meteringMatch = path.match(/^\/_antseed\/metering\/([^?]+)/)
    if (meteringMatch && method === 'GET') {
      const sellerPeerId = decodeURIComponent(meteringMatch[1]!)
      const identity = await this._controlPlaneIdentity(path)
      if (identity === undefined) return sendUnknownBuyerIdentity(res)
      const stats = this._node.getMeteringStatsByPeer(sellerPeerId, identity ?? undefined)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(stats))
      return
    }

    // Offer a signed deposit-sweep request to the daemon's connected relayers
    // one at a time (see docs/protocol/spec/09-deposit-sweep.md) — sequential
    // dispatch keeps relayers from racing the same nonce and burning gas on
    // reverted transactions. Responds only after a relayer accepts, every
    // candidate declines, or the offer round runs out of peers.
    if (path === '/_antseed/sweep' && method === 'POST') {
      const chunks: Buffer[] = []
      let totalSize = 0
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length
        if (totalSize > 8192) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      try {
        // Re-validate through the wire codec — same rules as inbound P2P frames.
        const payload = decodeSweepRequest(new Uint8Array(Buffer.concat(chunks)))
        const { offered, accepted } = await this._node.dispatchSweepRequest(payload)
        log(`Sweep request ${payload.nonce.slice(0, 10)}... offered to ${offered} peer(s), accepted=${accepted}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sent: offered, accepted }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: message }))
      }
      return
    }

    // Ask a seller to cooperatively close a payment channel, skipping the
    // on-chain request-close → grace → withdraw flow. Needs the daemon's live
    // seller connection, so it can only run here.
    if (path === '/_antseed/channels/close' && method === 'POST') {
      const chunks: Buffer[] = []
      let totalSize = 0
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length
        if (totalSize > 8192) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      let peerId: string
      let includeAuth = true
      let identityParam: string | undefined
      let channelId: string | undefined
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        peerId = String(body.peerId ?? '')
        if (body.includeAuth === false) includeAuth = false
        if (typeof body.identity === 'string') identityParam = body.identity
        // Optional: refuse unless this is the live channel with the seller.
        if (typeof body.channelId === 'string' && body.channelId) channelId = body.channelId
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      if (!peerId) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Missing peerId' }))
        return
      }
      // Closing hands the seller the identity's latest spending authorization.
      if (!this._mayUseBuyerIdentity(req, identityParam)) {
        sendJson(res, 401, { ok: false, error: 'gateway_auth_required' })
        return
      }
      try {
        const identity = await this._resolveBuyerIdentity(identityParam)
        if (identity === undefined) throw new Error('Unknown buyer identity')
        const result = await this._node.requestChannelClose(peerId, { includeAuth, ...(channelId ? { channelId } : {}), ...(identity ? { buyerIdentity: identity } : {}) })
        log(
          `Cooperative close of ${result.channelId.slice(0, 18)}... with ${peerId.slice(0, 12)}...: ` +
          `${result.status}${result.code ? ` (${result.code})` : ''}`,
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: message }))
      }
      return
    }

    // Hot-wallet deposit watcher (auto-sweep). The desktop and `antseed
    // deposit` drive the daemon's single watcher through these instead of
    // running a second signer against the same wallet.
    const controlPathname = path.split('?')[0]
    if (controlPathname === '/_antseed/deposits/status' && method === 'GET') {
      const identity = await this._controlPlaneIdentity(path)
      if (identity === undefined) return sendUnknownBuyerIdentity(res)
      const { watcher, reason } = this._depositWatcherFor(identity)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        ...(identity ? { identity } : {}),
        watcher: watcher !== null,
        // Why no watcher runs (null while one is attached) — lets UIs say
        // "payments are disabled" vs "this chain has no deposit relay".
        reason,
        // Live payments health: configured/active flags + chain-RPC
        // reachability from the node's background monitor. Optional call —
        // tolerate an older @antseed/node without it.
        payments: this._node.getPaymentsStatus?.() ?? null,
        status: watcher?.status() ?? null,
      }))
      return
    }

    // Credited deposits of one wallet (see DepositLog), for the gateway's deposit confirmations.
    if (controlPathname === '/_antseed/deposits/history' && method === 'GET') {
      const identity = await this._controlPlaneIdentity(path)
      if (identity === undefined) return sendUnknownBuyerIdentity(res)
      const address = this._depositWatcherFor(identity).watcher?.status().address ?? null
      const deposits = address ? await this._depositLog.list(address) : []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...(identity ? { identity } : {}), address, deposits }))
      return
    }

    if (controlPathname === '/_antseed/deposits/watch' && method === 'POST') {
      const chunks: Buffer[] = []
      let totalSize = 0
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length
        if (totalSize > 1024) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      let mode: string
      let bodyIdentity: string | undefined
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
        mode = String(body.mode ?? 'active')
        if (typeof body.identity === 'string') bodyIdentity = body.identity
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      if (mode !== 'active' && mode !== 'background') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'mode must be "active" or "background"' }))
        return
      }
      const identity = await this._controlPlaneIdentity(path, bodyIdentity)
      if (identity === undefined) return sendUnknownBuyerIdentity(res)
      const { watcher, reason } = this._depositWatcherFor(identity)
      if (!watcher) {
        const error = (reason && WATCHER_ABSENCE_ERRORS[reason]) ?? 'Deposit watcher unavailable.'
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, reason, error }))
        return
      }
      // Only the gateway console's watch lapses on its own (it re-requests it
      // while its page is open); the desktop and `antseed deposit` demote
      // explicitly, as they always have.
      if (mode === 'active') {
        const fromGateway = isLoopbackAddress(req.socket?.remoteAddress) && this._isGatewayAuthenticated(req.headers)
        watcher.promote(fromGateway ? DEPOSIT_WATCH_ACTIVE_TTL_MS : null)
      } else {
        watcher.demote()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: watcher.status() }))
      return
    }

    const sweepReceiptMatch = path.match(/^\/_antseed\/sweep\/(0x[0-9a-fA-F]{64})$/)
    if (sweepReceiptMatch && method === 'GET') {
      const receipt = this._sweepReceipts.get(sweepReceiptMatch[1]!.toLowerCase()) ?? null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, receipt }))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Unknown control-plane endpoint' }))
  }

  /**
   * GET /v1/models[?type=text|images] and GET /v1/models/:id — answered
   * locally from the discovered-peer cache, aggregated across the network. The
   * `x-antseed-request-id` response header keeps the port-reuse probe in
   * `buyer start` recognizing this as an AntSeed proxy.
   */
  private async _handleNetworkModels(res: ServerResponse, rawPath: string, requestPolicy: RoutingPolicy | null): Promise<void> {
    const url = new URL(rawPath, 'http://localhost')
    const responseHeaders = { 'content-type': 'application/json', 'x-antseed-request-id': randomUUID() }
    const peers = await this._getPeers()
    const peerById = new Map<string, PeerInfo>(peers.map((peer) => [peer.peerId, peer]))
    const models = buildNetworkModels(peers, this._now(), {
      routingPreferences: this._routingPreferences,
      peerHealth: this._peerHealth,
      ...(requestPolicy
        ? { offerFilter: (offer: NetworkServiceOffer) => this._policyAllowsOffer(requestPolicy, peerById.get(offer.peerId), offer) }
        : {}),
    })

    const modelIdRaw = url.pathname.replace(/^\/v1\/models\/?/i, '')
    if (modelIdRaw.length > 0) {
      let modelId: string
      try {
        modelId = decodeURIComponent(modelIdRaw).trim()
      } catch {
        modelId = modelIdRaw.trim()
      }
      const modelKey = canonicalModelKey(modelId)
      const model = models.find((entry) => canonicalModelKey(entry.id) === modelKey)
      if (!model) {
        res.writeHead(404, responseHeaders)
        res.end(JSON.stringify({
          error: {
            message: `Model "${modelId}" was not found on the network.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        }))
        return
      }
      res.writeHead(200, responseHeaders)
      res.end(JSON.stringify(model))
      return
    }

    const typeFilter = parseModelTypeFilter(url.searchParams.get('type'))
    if (typeFilter === 'invalid') {
      res.writeHead(400, responseHeaders)
      res.end(JSON.stringify({
        error: {
          message: `Unknown model type "${url.searchParams.get('type') ?? ''}" — expected "text", "images", "decisions", "videos", or "routers".`,
          type: 'invalid_request_error',
          param: 'type',
        },
      }))
      return
    }

    if (typeFilter === 'router') {
      const routers = await this._networkRouters(peers, requestPolicy)
      log(`GET /v1/models?type=router answered locally: ${routers.length} routers`)
      res.writeHead(200, responseHeaders)
      res.end(JSON.stringify({ object: 'list', data: routers }))
      return
    }

    const data = typeFilter === 'all' ? models : models.filter((entry) => entry.type === typeFilter)
    log(`GET /v1/models answered locally: ${data.length} models across ${peers.length} peers${typeFilter ? ` (type=${typeFilter})` : ''}`)
    res.writeHead(200, responseHeaders)
    res.end(JSON.stringify({ object: 'list', data }))
  }

  /**
   * Routing services on the network, one entry per service id with each
   * router peer offering it. A router is listed only when a request could pay
   * it (see `_routerExclusionReasons`), and under a gateway policy its models
   * are cut to the ones the policy allows. Model lists are free calls, cached
   * per router.
   */
  private async _networkRouters(peers: PeerInfo[], requestPolicy: RoutingPolicy | null): Promise<NetworkRouterEntry[]> {
    const policy = this._effectivePolicy(requestPolicy)
    const services = await buildRoutingServices(peers, this._modelRoutingClient, this._node, this._routingModels)
    const created = Math.floor(this._now() / 1000)
    const byId = new Map<string, NetworkRouterEntry>()
    for (const service of services) {
      const peer = peers.find((candidate) => candidate.peerId === service.peerId)
      if (!peer || this._routerExclusionReasons(peer, service.serviceId, requestPolicy).length > 0) continue
      const models = service.catalog
        ? [...new Set(service.catalog.models.map((model) => model.serviceId))]
          .filter((model) => !policy || policyAllowsModel(policy, model))
          .sort((a, b) => a.localeCompare(b))
        : null
      const price = Number(service.priceMicroUsdc)
      let entry = byId.get(service.serviceId)
      if (!entry) {
        entry = { id: service.serviceId, name: service.label, object: 'model', created, owned_by: 'antseed', type: 'router', peers: [] }
        byId.set(service.serviceId, entry)
      }
      entry.peers.push({
        peerId: service.peerId,
        ...(service.sellerName ? { displayName: service.sellerName } : {}),
        provider: service.provider,
        serviceId: service.serviceId,
        protocol: service.protocol,
        options: service.options,
        model: `${service.peerId}@${service.serviceId}`,
        priceUsdPerRequest: Number.isFinite(price) ? price / 1_000_000 : null,
        models,
      })
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Whether a request under the gateway's policy could use this offer, by
   * the checks that judge a pinned `peer@model`: the model allow list, the
   * seller-level policy, a strict model route and the buyer's hard limits.
   */
  private _policyAllowsOffer(requestPolicy: RoutingPolicy, peer: PeerInfo | undefined, offer: NetworkServiceOffer): boolean {
    if (!peer || !policyAllowsModel(this._effectivePolicy(requestPolicy), offer.serviceId)) return false
    const facts = this._policyFacts(peer, offer)
    return pinnedPeerExclusionReasons(requestPolicy, facts, offer.serviceId).length === 0
      && policyExclusionReasons(this._buyerHardPolicy(), facts).length === 0
  }

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'

    log(`${method} ${path}`)

    // Every route spends from the deposit or changes local state: only local
    // clients and local pages may reach it (see local-request-guard.ts).
    const nonLocal = nonLocalRequestReason(req.headers)
    if (nonLocal) {
      log(`Request rejected: ${nonLocal}`)
      sendJson(res, 403, {
        error: { type: 'permission_error', code: 'non_local_request', message: `Rejected: ${nonLocal}.` },
      })
      return
    }

    // Control-plane endpoints — handle before collecting proxy body
    if (path.startsWith('/_antseed/')) {
      return this._handleControlPlane(req, res, method, path)
    }

    // Only proxy known API paths — reject everything else with 404
    const normalizedPath = path.split('?')[0]?.trim().toLowerCase() ?? '/'
    const nativeVideo = nativeVideoRoute({ method, path })
    const isKnownApiPath = nativeVideo !== null ||
      normalizedPath.startsWith('/v1/messages') ||
      normalizedPath.startsWith('/v1/chat/completions') ||
      normalizedPath.startsWith('/v1/responses') ||
      normalizedPath.startsWith('/v1/images/generations') ||
      normalizedPath.startsWith('/v1/images/edits') ||
      normalizedPath.startsWith('/v1/systemone') ||
      normalizedPath.startsWith('/v1/models')
    if (!isKnownApiPath) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }))
      return
    }

    // Collect request body
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks)

    // `/v1/messages/count_tokens` sits under the completion prefix but is not
    // a turn — Anthropic tools call it before most turns to size the context.
    // Answering it locally keeps it off the wire: routed to a seller it costs
    // a full inference and answers in a shape the caller cannot read.
    if (method === 'POST' && isCountTokensPath(normalizedPath)) {
      const inputTokens = estimateAnthropicPromptTokens(new Uint8Array(body))
      log(`count_tokens answered locally: ${inputTokens} tokens`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: inputTokens }))
      return
    }

    // Build serialized request. Client credentials (provider keys, cookies)
    // never leave the machine — see credential-headers.ts for why no seller
    // needs them.
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (isClientCredentialHeader(key)) continue
      if (typeof value === 'string') {
        headers[key] = value
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ')
      }
    }
    // Remove host header (points to localhost, not the seller)
    delete headers['host']
    // Routing policy from the local gateway. Both gateway headers are always
    // stripped here so they never reach a seller.
    const requestPolicyResult = this._takeRequestPolicy(headers)
    if (requestPolicyResult.kind === 'auth_invalid') {
      log('Request rejected: invalid gateway control secret')
      sendJson(res, 401, {
        error: {
          type: 'authentication_error',
          code: 'gateway_auth_invalid',
          message: `${GATEWAY_CONTROL_HEADER} does not match this buyer's gateway control secret.`,
          param: GATEWAY_CONTROL_HEADER,
        },
      })
      return
    }
    if (requestPolicyResult.kind === 'invalid') {
      sendJson(res, 400, {
        error: {
          type: 'invalid_request_error',
          code: 'invalid_routing_policy',
          message: `${ROUTING_POLICY_HEADER} is not a valid routing policy.`,
          param: ROUTING_POLICY_HEADER,
        },
      })
      return
    }
    const requestPolicy = requestPolicyResult.kind === 'policy' ? requestPolicyResult.policy : null
    // `/v1/models` is answered locally from the discovered-peer cache: one
    // entry per model across the whole network, with the peers serving it.
    // Routed to a single pinned seller it would only cover that seller's
    // services — and would require a pin just to browse the network. Under a
    // gateway policy it lists only what the policy lets the caller use.
    if (method === 'GET' && normalizedPath.startsWith('/v1/models')) {
      return this._handleNetworkModels(res, path, requestPolicy)
    }
    // Node already answered curl's `Expect: 100-continue` for large bodies;
    // forwarded, it makes the seller's fetch fail.
    delete headers['expect']
    // Internal marker from the system proxy: the body's model was assigned
    // by the proxy's route rewrite, not chosen by the tool. Stripped here so
    // it never reaches a seller.
    const systemRoutedModel = headers[SYSTEM_ROUTED_MODEL_HEADER] === '1'
    delete headers[SYSTEM_ROUTED_MODEL_HEADER]
    const requestedRequestId = headers['x-antseed-request-id']?.trim()
    delete headers['x-antseed-request-id']
    // Internal marker from the API-key gateway: report this request's signed
    // spend under the gateway's tag. Stripped so it never reaches a seller.
    const spendAttributionTag = parseSpendAttributionTag(headers[SPEND_ATTRIBUTION_HEADER])
    delete headers[SPEND_ATTRIBUTION_HEADER]
    // The paying identity rides on the internal headers through routing, like
    // a peer pin, and is stripped when the request is built for the seller.
    if (!this._mayUseBuyerIdentity(req, headers[BUYER_IDENTITY_HEADER])) {
      log('Request rejected: buyer identity named without the gateway control secret')
      sendJson(res, 401, {
        error: {
          type: 'authentication_error',
          code: 'gateway_auth_required',
          message: `Paying as a buyer identity other than the default requires ${GATEWAY_CONTROL_HEADER}.`,
          param: GATEWAY_CONTROL_HEADER,
        },
      })
      return
    }
    const buyerIdentity = await this._resolveBuyerIdentity(headers[BUYER_IDENTITY_HEADER])
    if (buyerIdentity === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'unknown_buyer_identity',
          message: `${BUYER_IDENTITY_HEADER} names no stored buyer identity. Create one with \`antseed buyer identity create <name>\`.`,
          param: BUYER_IDENTITY_HEADER,
        },
      }))
      return
    }
    if (buyerIdentity) headers[BUYER_IDENTITY_HEADER] = buyerIdentity
    else delete headers[BUYER_IDENTITY_HEADER]

    let serializedReq: SerializedHttpRequest = {
      requestId: requestedRequestId && isUuid(requestedRequestId)
        ? requestedRequestId
        : randomUUID(),
      method,
      path,
      headers,
      body: new Uint8Array(body),
    }
    if (spendAttributionTag) this._spendAttribution.track(serializedReq.requestId, spendAttributionTag)
    const requiredParameters = parseRequiredParametersHeader(
      serializedReq.headers[REQUIRED_PARAMETERS_HEADER],
    )
    if (requiredParameters === null) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_required_parameters',
          message: `${REQUIRED_PARAMETERS_HEADER} must contain at most 16 comma-separated parameter names.`,
          param: REQUIRED_PARAMETERS_HEADER,
        },
      }))
      return
    }

    // Per-request routing options (`routing` in the body) are read here and
    // stripped, so they never reach a seller, whatever the model. A malformed
    // `routing` is reported only when a router serves the request.
    let routingOptions: RequestRoutingOptions = {}
    let invalidRouting: string | null = null
    if (method === 'POST' && isCompletionRequestPath(path)) {
      const taken = takeRoutingOptions(serializedReq)
      if (taken.kind === 'options') {
        serializedReq = taken.request
        routingOptions = taken.options
        invalidRouting = taken.invalid ?? null
      }
    }

    if (nativeVideo) {
      // Re-classify with the body: some APIs (Venice) carry the job ID in it.
      const prepared = prepareVideoRequest(nativeVideoRoute(serializedReq) ?? nativeVideo, serializedReq.headers, this._resourceRoutes)
      if ('error' in prepared) {
        // No route for the job: this buyer can never deliver or charge it. Unless its saved routes could not be
        // read at start, when the job may still be there on the next one.
        const retired = prepared.error.body.error.code === 'video_route_not_found' && !this._resourceRoutesUnread ? { [VIDEO_JOB_RETIRED_HEADER]: '1' } : {}
        res.writeHead(prepared.error.statusCode, { 'content-type': 'application/json', ...retired })
        res.end(JSON.stringify(prepared.error.body))
        return
      }
      serializedReq = { ...serializedReq, headers: prepared.headers }
    }

    // Snapshot the session overrides before any await so a concurrent
    // _reloadSessionOverrides() cannot change routing mid-request.
    const effectivePinnedPeer = this._pinnedPeer

    // Per-chat routing: completion requests carry a stable per-conversation
    // identity (see conversation-identity.ts). Explicit chat pins remain hard;
    // automatically selected routes become soft affinity, so later turns stay
    // on the same seller unless it is cooling, unavailable, or fails retryably.
    // Subagent sessions inherit their parent chat's route.
    const isConversationRequest = method === 'POST' && isCompletionRequestPath(path)
    const conversationBody = isConversationRequest
      ? parseRequestBodyObject(serializedReq.body, serializedReq.headers)
      : null
    const conversationIdentity = isConversationRequest
      ? extractConversationIdentity(serializedReq.headers, conversationBody)
      : null
    const routingConversationKey = conversationIdentity ? `${conversationIdentity.tool}:${conversationIdentity.sessionKey}` : null
    if (isConversationRequest || nativeVideo || isImageOrDecisionRequest(method, serializedReq)) {
      const trace = this._telemetry?.beginRequest(res, this._cachedPeers.length > 0)
      if (trace) {
        trace.clientTool = telemetryClientTool(conversationIdentity?.tool ?? requestClientTool(serializedReq.headers))
        // Before the seller-bound session header is added, so a client's retry matches its first copy.
        this._telemetry?.noteRequestBody(trace, method, path, serializedReq.body, conversationBody)
      }
    }
    // The seller's upstream may route prompt caching by `session_id`; pass the
    // conversation's key under that name whatever the client called it.
    if (conversationIdentity) {
      Object.assign(serializedReq.headers, withUpstreamSessionHeader(serializedReq.headers, conversationIdentity))
    }
    // Internal marker from the system proxy: source profile used only for
    // local conversation attribution. Stripped here so it never reaches a seller.
    delete serializedReq.headers[SYSTEM_PROXY_SOURCE_HEADER]
    const trackedConversationKey = conversationIdentity
      ? conversationIdentity.parentSessionKey ?? conversationIdentity.sessionKey
      : null
    const storedConversation = conversationIdentity && trackedConversationKey
      ? this._conversations.get(`${conversationIdentity.tool}:${trackedConversationKey}`)
      : null
    // Use this chat's router override when present; otherwise follow the buyer's default choice.
    const conversationSelection = storedConversation?.routingSelection ?? null
    // Keep this request's choice stable; later selection changes affect subsequent requests.
    const routerSelection = structuredClone(conversationSelection ?? this._defaultRouter)
    const storedAutoRoute = storedConversation?.peerSource === 'auto' && storedConversation.pinnedModel
      ? parsePeerPinnedService(storedConversation.pinnedModel)
      : null
    const chatPinnedModel = storedConversation?.peerSource === 'user'
      ? storedConversation.pinnedModel
      : storedAutoRoute?.service ?? storedConversation?.pinnedModel ?? null
    const preferredPeerHeader = normalizePeerId(serializedReq.headers['x-antseed-prefer-peer'] ?? '')
    const preferredConversationPeerId = preferredPeerHeader ?? storedAutoRoute?.peerId ?? null
    const requestTrace = traceFor(res)
    if (requestTrace) {
      // The key that groups a conversation's requests (it never leaves the
      // process), and the seller that answered its last turn before a restart.
      const cacheKey = conversationIdentity ? null : promptCacheKey(serializedReq)
      const telemetryKey = conversationIdentity && trackedConversationKey
        ? { value: `${conversationIdentity.tool}:${trackedConversationKey}`, source: conversationKeySource(conversationIdentity, serializedReq.headers, conversationBody) }
        : cacheKey ? { value: cacheKey, source: 'prompt_cache_key' as const } : null
      const storedSeller = storedConversation?.lastModel ? parsePeerPinnedService(storedConversation.lastModel)?.peerId ?? null : null
      this._telemetry?.noteConversation(requestTrace, telemetryKey, storedSeller ? normalizePeerId(storedSeller) : null)
    }
    const effectiveRoutedModel = chatPinnedModel ?? this._defaultRoutedModel
    // Where a router pin can come from besides the request's own model: the
    // `antseed` alias resolves to the chat's explicit pin or, when the chat
    // chose no route of its own (neither a pin nor a router), the default
    // route; a system-proxied request follows the chat's explicit pin. An
    // automatic chat route (the seller a router chose last turn) never
    // counts, so every turn of a router-pinned chat is ranked again.
    const userChatPin = storedConversation?.peerSource === 'user' ? storedConversation.pinnedModel : null
    const aliasTarget = userChatPin ?? (conversationSelection ? null : this._defaultRoutedModel)

    // Reuse disconnect cancellation for both the recommendation and the eventual inference call.
    const clientAbortController = new AbortController()
    const onClientAbort = (): void => {
      if (clientAbortController.signal.aborted) return
      clientAbortController.abort()
      log(`Client disconnected; aborting upstream request reqId=${serializedReq.requestId.slice(0, 8)}`)
    }
    req.once('close', () => {
      if (!req.complete && !res.writableEnded) onClientAbort()
    })
    res.once('close', () => {
      if (!res.writableEnded) onClientAbort()
    })
    // Explicit model/seller choices bypass recommendations, even when the default is a router.
    // A system-proxy connection's model was assigned at connect time, not chosen by the tool:
    // under a router it stands for the automatic alias, unless this chat is pinned. The request
    // is only rewritten once the router path is certain (below), so a request that goes direct
    // keeps its connect-time model.
    const systemRoutedAsAlias = routerSelection !== null && systemRoutedModel && storedConversation?.peerSource !== 'user'
    const rawService = systemRoutedAsAlias ? ROUTED_MODEL_ALIAS : extractRequestedService(serializedReq)
    // `<routerPeer>@<routingServiceId>`: the request names a routing service as
    // its model, so that router picks the model and seller for this request.
    const routerPinSource = rawService === ROUTED_MODEL_ALIAS
      ? aliasTarget
      : systemRoutedModel && userChatPin ? userChatPin : rawService
    const pinnedRouter = await this._resolvePinnedRouter(routerPinSource)
    const autoRequested = routerSelection !== null
      && rawService === ROUTED_MODEL_ALIAS
    const chatModelPin = storedConversation?.peerSource === 'user' ? chatPinnedModel : null
    if (autoRequested && chatModelPin) {
      serializedReq = withRoutedModel(serializedReq, chatModelPin)
    }
    const useModelRouter = pinnedRouter !== null || (autoRequested && !chatModelPin
      && !getExplicitPeerIdOverride(serializedReq, effectivePinnedPeer ?? undefined))
    if (useModelRouter && systemRoutedAsAlias) {
      serializedReq = withRoutedModel(serializedReq, ROUTED_MODEL_ALIAS)
    }
    // A request without `routing` uses the saved router settings (options,
    // model allow list) when it pins the router those settings belong to;
    // a request's own `routing` options override the saved ones key by key.
    const savedRouter = this._defaultRouter
    const savedForPinned = pinnedRouter && savedRouter && sameRoutingServiceTarget(savedRouter.service, pinnedRouter.service)
      ? structuredClone(savedRouter)
      : null
    const baseSelection = pinnedRouter ? savedForPinned ?? pinnedRouter : routerSelection
    const activeSelection: RouterSelection | null = baseSelection && Object.keys(routingOptions).length > 0
      ? { ...baseSelection, options: { ...baseSelection.options, ...routingOptions } }
      : baseSelection
    const context: BuyerDispatchContext = {
      request: serializedReq, requiredParameters, requestPolicy, signal: clientAbortController.signal,
      systemRoutedModel, conversationIdentity, conversationBody, storedConversation,
      effectivePinnedPeer, effectiveRoutedModel, chatPinnedModel,
      preferredConversationPeerId,
      // Cache-reuse observations only feed a router, so skip them when none is configured.
      routingConversationKey: activeSelection ? routingConversationKey : null,
      spendAttributionTag,
    }

    const trace = traceFor(res)
    if (trace && activeSelection && useModelRouter) trace.routeMode = 'router'
    // Both paths return an inference answer; only the router path buys a recommendation first.
    if (activeSelection && useModelRouter) {
      if (invalidRouting) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_routing', message: invalidRouting, param: 'routing' } })
        return
      }
      const refusal = await this._routerRefusal(activeSelection, requestPolicy)
      if (refusal) {
        log(`Routing service refused before ranking: ${refusal.error.message}`)
        sendJson(res, 403, refusal)
        return
      }
      await this._dispatchViaModelRouter(res, context, activeSelection)
    } else {
      await this._dispatchDirectModelRequest(res, context)
    }
  }

  /**
   * Buy ranked recommendations, then send each one through the normal inference path
   * until one succeeds. A failed exact peer falls back to the next recommendation.
   */
  private async _dispatchViaModelRouter(
    res: ServerResponse,
    context: BuyerDispatchContext,
    selection: RouterSelection,
  ): Promise<void> {
    const { request, requiredParameters, requestPolicy, signal, routingConversationKey, spendAttributionTag } = context
    const conversationId = this._trackRouterConversation(context)
    if (conversationId && selection.service) this._conversations.setLastRouter(conversationId, `${selection.service.peerId}@${selection.service.serviceId}`)
    // Merged into whatever answer this request gets, so a gateway can tell routed requests (and failed rankings) apart.
    if (selection.service) {
      res.setHeader(ROUTER_PEER_ID_HEADER, selection.service.peerId.toLowerCase())
      res.setHeader(ROUTER_SERVICE_HEADER, selection.service.serviceId)
    }
    let recommendations: RouteRecommendation[]
    try {
      const client = this._modelRoutingClient
      if (!selection.service) throw new Error('Select an exact routing-service target')
      const peers = await this._getPeers()
      // The router may only recommend destinations the buyer's own policies allow.
      const candidates = eligibleRouterCandidates(request, peers, requiredParameters, this._routingPreferences,
        (policyRequest, peer) => peerAllowedByPolicy(this._node.router as BuyerPolicyRouter | null, policyRequest, peer)
          && this._routerCandidateAllowedByRequestPolicy(requestPolicy, policyRequest, peer)
          && !isCoolingDown(this._peerHealth.get(peer.peerId), this._now()))
      recommendations = await executeRouterSelection({
        node: this._node, client, request, peers, candidates,
        conversationKey: routingConversationKey, selection, modelsCache: this._routingModels,
        ...(request.headers[BUYER_IDENTITY_HEADER] ? { buyerIdentity: request.headers[BUYER_IDENTITY_HEADER] } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        onRoutingRequest: requestId => {
          if (spendAttributionTag) this._spendAttribution.track(requestId, spendAttributionTag, 'routing')
          if (conversationId) this._trackRequestConversation(requestId, conversationId, undefined, 'routing')
        },
      })
    } catch (error) {
      // Report routing failures rather than silently choosing a model for the user.
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof InvalidRouterOptionsError) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_routing', message, param: 'routing' } })
        return
      }
      writeDispatchFailure(res, error instanceof NoEligibleCandidatesError
        ? dispatchFailure(422, { 'content-type': 'application/json' }, JSON.stringify({
          error: { type: 'invalid_request_error', code: 'no_eligible_candidates', message },
        }))
        : dispatchFailure(502, { 'content-type': 'application/json' }, JSON.stringify({
          error: { type: 'routing_error', message },
        })))
      return
    }

    let lastFailure: DispatchFailure | null = null
    for (const [index, recommendation] of recommendations.entries()) {
      // Never switch sellers once the user has disconnected or a response has started.
      if (signal.aborted || res.headersSent || res.writableEnded) return
      res.setHeader(ROUTER_RANK_HEADER, String(index + 1))
      // Each attempt has its own billing ID, but all attempts count as one chat turn.
      const attempt = requestForRecommendation(request, recommendation, randomUUID())
      if (spendAttributionTag) this._spendAttribution.track(attempt.requestId, spendAttributionTag)
      if (conversationId) this._trackRequestConversation(attempt.requestId, conversationId, request.requestId)
      const result = await this._dispatchInference(res, context, attempt, conversationId)
      if (result.done) return
      lastFailure = result
      // Only try the next recommendation after a clear seller refusal, never after an ambiguous
      // transport failure or timeout (the seller may have done paid work) or a buyer-side fault.
      if (result.errorMessage !== null || isBuyerFault(result) || !RECOMMENDATION_FALLBACK_STATUS_CODES.has(result.statusCode)) break
      log(`Recommendation ${recommendation.peerId ? `${recommendation.peerId.slice(0, 12)}...@` : ''}${recommendation.serviceId} failed (${result.statusCode}); trying the next recommendation.`)
    }
    if (signal.aborted) return
    writeDispatchFailure(res, lastFailure ?? dispatchFailure(502, { 'content-type': 'application/json' }, JSON.stringify({
      error: { type: 'routing_error', message: 'No recommended destination could serve this request' },
    })))
  }

  /**
   * The router selection a `<peerId>@<serviceId>` model names, when that
   * peer's routing service is `<serviceId>`. A peer missing from the cache
   * gets one refresh first, so a router that just came online is not taken
   * for a seller. Still missing, the pin goes down the seller-pin path, which
   * reports the peer as unreachable.
   */
  private async _resolvePinnedRouter(model: string | null): Promise<RouterSelection | null> {
    const pin = model ? parsePeerPinnedService(model) : null
    if (!pin) return null
    let peers = await this._getPeers()
    if (!peers.some((peer) => peer.peerId.toLowerCase() === pin.peerId)) {
      peers = await this._getPeers({ forceRefresh: true })
    }
    const service = findPinnedRoutingService(peers, pin.peerId, pin.service)
    return service ? { kind: 'router', service } : null
  }

  /**
   * Why a routing service may not be paid, the way a pinned seller is judged:
   * the gateway policy's model allow list (the router's service id counts as
   * its model), its seller rules and strict model routes, and the buyer's
   * hard limits, all through `routingServicePolicy`. Empty when allowed.
   */
  private _routerExclusionReasons(peer: PeerInfo, serviceId: string, requestPolicy: RoutingPolicy | null): string[] {
    const facts = this._policyFacts(peer, null)
    const reasons = requestPolicy ? pinnedPeerExclusionReasons(routingServicePolicy(requestPolicy), facts, serviceId) : []
    if (requestPolicy && !policyAllowsModel(this._effectivePolicy(requestPolicy), serviceId)) reasons.unshift('model not allowed')
    addBuyerConfigReasons(reasons, policyExclusionReasons(routingServicePolicy(this._buyerHardPolicy()), facts))
    return reasons
  }

  /** A 403 body when the policy forbids paying this router for a ranking; null when allowed or its peer is unknown. */
  private async _routerRefusal(selection: RouterSelection, requestPolicy: RoutingPolicy | null): Promise<{ error: { type: string; code: string; message: string; param?: string } } | null> {
    const service = selection.service
    if (!service) return null
    const peer = (await this._getPeers()).find((candidate) => candidate.peerId.toLowerCase() === service.peerId.toLowerCase())
    if (!peer) return null
    const reasons = this._routerExclusionReasons(peer, service.serviceId, requestPolicy)
    if (reasons.length === 0) return null
    const label = `${service.peerId.slice(0, 12)}...@${service.serviceId}`
    if (reasons[0] === 'model not allowed') {
      return { error: { type: 'permission_error', code: 'model_not_allowed', param: 'model',
        message: `Routing service "${service.serviceId}" is not allowed by the routing policy.` } }
    }
    return { error: { type: 'permission_error', code: 'peer_not_allowed',
      message: `Routing service ${label} is not allowed by the routing policy (${reasons.join('; ')}).` } }
  }

  private _routerCandidateAllowedByRequestPolicy(
    requestPolicy: RoutingPolicy | null,
    request: SerializedHttpRequest,
    peer: PeerInfo,
  ): boolean {
    if (!requestPolicy) return true
    const provider = getExplicitProviderOverride(request)
    const serviceId = extractRequestedService(request)
    const offer = provider && serviceId ? findAdvertisedServiceOffer(peer, provider, serviceId) : null
    return offer !== null
      && this._policyAllowsOffer(requestPolicy, peer, offer)
      && policyExclusionReasons(this._buyerHardPolicy(), this._policyFacts(peer, offer)).length === 0
  }

  /** Track a router-served chat before buying its recommendation, so routing costs are attributed. */
  private _trackRouterConversation(context: BuyerDispatchContext): string | null {
    const { request, conversationIdentity, conversationBody, storedConversation } = context
    if (!conversationIdentity?.isUserThread) return storedConversation?.id ?? null
    if (!storedConversation && isTitleGenerationRequest(conversationBody)) return null
    const { id } = this._conversations.touch({
      tool: conversationIdentity.tool,
      sessionKey: conversationIdentity.parentSessionKey ?? conversationIdentity.sessionKey,
      snippet: storedConversation?.snippet ? null : extractFirstUserSnippet(conversationBody),
      lastModel: null,
    })
    // Inference attempts link to this ID so fallbacks count as one chat turn.
    this._trackRequestConversation(request.requestId, id)
    return id
  }

  /** Apply model aliases and chat pins, then attach inference to its conversation for accounting. */
  private _prepareInferenceRequest(
    res: ServerResponse,
    context: BuyerDispatchContext,
  ): { request: SerializedHttpRequest; conversationId: string | null } | null {
    const { effectiveRoutedModel, chatPinnedModel, systemRoutedModel,
      storedConversation, conversationIdentity, conversationBody } = context
    let serializedReq = context.request
    let trackedConversationId = storedConversation?.id ?? null
    // Resolve the `antseed` model alias to the session's default route first,
    // so the regular `<peerId>@<service>` pin rewrite below picks up the
    // substituted value. Tool configs written by the desktop carry the alias
    // so route changes apply to running sessions without config rewrites.
    const aliasResult = substituteRoutedModelAlias(serializedReq.body, serializedReq.headers, effectiveRoutedModel)
    if (aliasResult.aliasRequested && !aliasResult.substituted) {
      log(`Request rejected: model alias "${ROUTED_MODEL_ALIAS}" with no default route set`)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          type: 'no_default_route',
          code: 'no_default_route',
          message: `Model "${ROUTED_MODEL_ALIAS}" routes to the model selected in the AI VPN, but no route is set. `
            + 'Pick a model in the desktop app, or request "<peerId>@<model>" explicitly.',
          param: 'model',
        },
      }))
      return null
    }
    if (aliasResult.substituted) {
      serializedReq = { ...serializedReq, body: aliasResult.body, headers: aliasResult.headers }
      log(`Model alias applied: ${ROUTED_MODEL_ALIAS} -> ${effectiveRoutedModel}${chatPinnedModel ? ' (chat pin)' : ''}`)
    }

    // System-proxy-intercepted tools can't carry the alias — the proxy
    // rewrites their upstream model names to its connect-time route and
    // marks the request. A chat pin must still win there, exactly as it
    // does for alias-carrying configs; otherwise pinning a chat in the
    // desktop silently does nothing for intercepted apps.
    let chatPinOverrideApplied = false
    if (systemRoutedModel && !aliasResult.aliasRequested && chatPinnedModel) {
      const pinOverride = overrideRoutedModelInBody(serializedReq.body, serializedReq.headers, chatPinnedModel)
      if (pinOverride.overridden) {
        serializedReq = { ...serializedReq, body: pinOverride.body, headers: pinOverride.headers }
        chatPinOverrideApplied = true
        log(`Chat pin applied to system-routed model: -> ${chatPinnedModel}`)
      }
    }

    // Track the conversation (subagent traffic rolls up into the parent
    // chat). The snippet is only extracted the first time a chat is seen.
    // A thread the tool opened for its own housekeeping is routed and paid
    // for normally, but is not a chat — Codex titles every new chat from one.
    if (conversationIdentity?.isUserThread) {
      const rawModel = typeof conversationBody?.['model'] === 'string' ? conversationBody['model'] : ''
      const resolvedModel = aliasResult.substituted
        ? effectiveRoutedModel
        : chatPinOverrideApplied
          ? chatPinnedModel
          : (parsePeerPinnedService(rawModel) ? rawModel : null)
      const trackedKey = conversationIdentity.parentSessionKey ?? conversationIdentity.sessionKey
      const known = this._conversations.get(`${conversationIdentity.tool}:${trackedKey}`)
      // A title turn runs on the tool's own small model and races ahead of the
      // first real turn, so it must not become the chat's model: that pin
      // outranks the default route for every later turn, which would strand
      // the whole session on a model the user never picked.
      const titleTurn = isTitleGenerationRequest(conversationBody)
      const snippet = known?.snippet ? null : extractFirstUserSnippet(conversationBody)
      // Some tools (T3/Claude) fire title-only requests when a new chat opens.
      // Route them normally, but do not create a blank AntSeed conversation row
      // until the first genuine user turn arrives.
      if (known || !titleTurn) {
        const tracked = this._conversations.touch({
          tool: conversationIdentity.tool,
          sessionKey: trackedKey,
          // Extract until a label sticks: a tool's title-generation request can
          // race ahead of the first real turn and create the row snippet-less.
          snippet,
          lastModel: titleTurn ? null : resolvedModel,
        })
        const explicitConversationPin = resolvedModel && (
          parsePeerPinnedService(rawModel)
          || (aliasResult.substituted && parsePeerPinnedService(effectiveRoutedModel ?? ''))
          || (chatPinOverrideApplied && parsePeerPinnedService(chatPinnedModel ?? ''))
        )
        if (explicitConversationPin) {
          this._conversations.setPinnedModel(tracked.id, resolvedModel, 'user')
        }
        trackedConversationId = tracked.id
        // Bind the request to the chat so its cost can be attributed when the
        // payment layer signs for it (see _attributeSpend).
        this._trackRequestConversation(serializedReq.requestId, tracked.id)
      }
    }
    return { request: serializedReq, conversationId: trackedConversationId }
  }

  /** Send a fixed-model or pinned-seller request without buying a model recommendation. */
  private async _dispatchDirectModelRequest(res: ServerResponse, context: BuyerDispatchContext): Promise<void> {
    const prepared = this._prepareInferenceRequest(res, context)
    if (!prepared) return
    // No router chose this turn's model.
    if (prepared.conversationId) this._conversations.setLastRouter(prepared.conversationId, null)
    const result = await this._dispatchInference(res, context, prepared.request, prepared.conversationId)
    if (!result.done) writeDispatchFailure(res, result)
  }

  /**
   * Select a seller for the requested model (or the pinned seller) and send the request.
   * Success is written to `res`; failures are returned so callers can fall back or report them.
   */
  private async _dispatchInference(
    res: ServerResponse,
    context: BuyerDispatchContext,
    request: SerializedHttpRequest,
    trackedConversationId: string | null,
  ): Promise<PeerDispatchResult> {
    // A chat switched while this request is in flight must keep the new route.
    const conversationPinAtRouting = trackedConversationId
      ? this._conversations.get(trackedConversationId)?.pinnedModel ?? null
      : null

    const nativeVideo = nativeVideoRoute(request)
    let serializedReq = request
    const { requiredParameters, requestPolicy, signal, effectivePinnedPeer,
      preferredConversationPeerId, routingConversationKey } = context
    const {
      body: servicePinBody,
      headers: servicePinHeaders,
      pinnedPeerId: bodyPinnedPeer,
    } = rewritePeerPinnedServiceInBody(serializedReq.body, serializedReq.headers)
    if (servicePinBody !== serializedReq.body) {
      serializedReq = { ...serializedReq, body: servicePinBody, headers: servicePinHeaders }
      if (bodyPinnedPeer) {
        log(`Model peer pin applied: peer=${bodyPinnedPeer.slice(0, 12)}...`)
      }
    }

    const requestProtocol = detectRequestServiceApiProtocol(serializedReq)
    const requestedService = extractRequestedService(serializedReq)
    log(`Routing: protocol=${requestProtocol ?? 'null'} service=${requestedService ?? 'null'}`)
    const explicitProvider = getExplicitProviderOverride(serializedReq)
    const explicitPeerId = getExplicitPeerIdOverride(serializedReq, effectivePinnedPeer ?? undefined, bodyPinnedPeer)
    log(`Routing hints: provider=${explicitProvider ?? 'auto'} pin-peer=${explicitPeerId ?? 'none'}`)
    const trace = traceFor(res)
    if (trace) {
      trace.protocol = telemetryProtocol(requestProtocol, nativeVideo !== null)
      trace.videoAction = nativeVideo?.action ?? null
      trace.model = requestedService
      if (trace.routeMode !== 'router') trace.routeMode = explicitPeerId ? 'pinned' : 'auto'
    }

    if (!explicitPeerId && !requestedService) {
      log('Request rejected: no peer pinned and no model requested')
      const errorMessage =
        'No model or peer was specified.\n'
        + 'Set the request model, or pin a peer one of three ways:\n'
        + '  • Per-request header:   x-antseed-pin-peer: <peerId>    (40-char hex EVM address)\n'
        + '  • Model name prefix:    <peerId>@<model>\n'
        + '  • Session pin:          antseed buyer connection set --peer <peerId>\n'
        + 'Discover peers with:       antseed network browse'
      return dispatchFailure(400, { 'content-type': 'application/json' }, JSON.stringify({
        error: {
          type: 'missing_routing_target',
          code: 'missing_routing_target',
          message: errorMessage,
          param: 'model',
          help: {
            perRequestHeader: 'x-antseed-pin-peer: <peerId>',
            modelPrefix: '<peerId>@<model>',
            sessionPin: 'antseed buyer connection set --peer <peerId>',
            discoverPeers: 'antseed network browse',
          },
        },
      }))
    }

    if (requestPolicy && !policyAllowsModel(this._effectivePolicy(requestPolicy), requestedService)) {
      return dispatchFailure(403, { 'content-type': 'application/json' }, JSON.stringify({
        error: {
          type: 'permission_error',
          code: 'model_not_allowed',
          message: `Model "${requestedService ?? 'unknown'}" is not allowed by the routing policy.`,
          param: 'model',
        },
      }))
    }

    // Discover peers
    const peers = await this._getPeers()
    if (peers.length === 0) {
      log('No sellers available')
      return dispatchFailure(502, { 'content-type': 'text/plain' }, 'No sellers available on the network. Is a seeder running?')
    }

    if (!explicitPeerId && requestedService) {
      // An image edit needs a seller that takes an input image, so automatic
      // routing requires `image` as if the caller had sent it in
      // REQUIRED_PARAMETERS_HEADER. A pinned seller stays the caller's choice.
      const routeRequiredParameters = serializedReq.path.split('?')[0]?.toLowerCase() === '/v1/images/edits'
        && !requiredParameters.includes('image')
        ? [...requiredParameters, 'image']
        : [...requiredParameters]
      // Likewise a video edit needs a seller whose model takes the source
      // (or reference) videos the create sends.
      if (nativeVideo?.action === 'create') {
        const fields = extractRequestBodyFields(serializedReq.headers, serializedReq.body)
        for (const field of ['video_url', 'reference_video_urls']) {
          const value = fields?.[field]
          if ((typeof value === 'string' || Array.isArray(value)) && value.length > 0
            && !routeRequiredParameters.includes(field)) routeRequiredParameters.push(field)
        }
      }
      const selectModelPeers = (candidateSources: PeerInfo[]): CandidatePeerRouteSelection =>
        selectCandidatePeersForRouting(candidateSources, requestProtocol, requestedService, explicitProvider, 'strict')
      let discoveredPeers = peers
      let { candidatePeers: modelPeers, routePlanByPeerId: modelPlans } = selectModelPeers(discoveredPeers)
      const cacheAgeMs = Date.now() - this._cacheLastUpdatedAtMs
      if (modelPeers.length === 0 || cacheAgeMs > this._peerCacheTtlMs) {
        discoveredPeers = await this._getPeers({ forceRefresh: true })
        ;({ candidatePeers: modelPeers, routePlanByPeerId: modelPlans } = selectModelPeers(discoveredPeers))
      }

      const router = this._node.router
      const { candidates, effectivePolicy, explored, selections, firstPick, verdicts } = this._planModelRoutes({
        modelPeers,
        modelPlans,
        request: serializedReq,
        requestProtocol,
        requestedService,
        explicitProvider,
        requiredParameters: routeRequiredParameters,
        requestPolicy,
        preferredPeerId: preferredConversationPeerId,
        // Conversations the client identifies (session id, prompt-cache key)
        // stay on one seller so its prompt cache keeps paying off.
        affinityKey: routingConversationKey ?? promptCacheKey(serializedReq),
      })
      const requireVerified = effectivePolicy?.requireVerified === true
      if (candidates.length === 0) {
        const capabilityRequired = routeRequiredParameters.length > 0
        // The model exists on the network but only behind an API this
        // request does not speak (e.g. a decision model asked via chat).
        // Say so instead of claiming nobody serves it.
        const advertisedProtocols = capabilityRequired ? [] : findAdvertisedServiceProtocols(discoveredPeers, requestedService)
        if (advertisedProtocols.length > 0 && (!requestProtocol || !advertisedProtocols.includes(requestProtocol))) {
          const hint = advertisedProtocols.includes('typesafe-systemone')
            ? ` "${requestedService}" is a decision model; call POST /v1/systemone.`
            : ''
          log(`Request rejected: model ${requestedService} is served only via ${advertisedProtocols.join(', ')}`)
          return dispatchFailure(400, { 'content-type': 'application/json' }, JSON.stringify({
            error: {
              type: 'unsupported_protocol',
              code: 'unsupported_protocol',
              message: `Model "${requestedService}" is served via ${advertisedProtocols.join(', ')}, not ${requestProtocol ?? 'this API'}.${hint}`,
              param: 'model',
              supported_protocols: advertisedProtocols,
            },
          }))
        }
        return dispatchFailure(capabilityRequired ? 422 : 502, { 'content-type': 'application/json' }, JSON.stringify({
          error: capabilityRequired
            ? {
                type: 'required_capability_unavailable',
                code: 'required_capability_unavailable',
                message: `No policy-allowed seller for model "${requestedService}" advertises required parameter(s): ${routeRequiredParameters.join(', ')}.`,
                param: REQUIRED_PARAMETERS_HEADER,
              }
            : {
                type: 'model_not_found',
                code: 'model_not_found',
                message: `No policy-allowed peer currently serves model "${requestedService}".`,
                param: 'model',
              },
        }))
      }

      let lastRetry: PeerDispatchResult | null = null
      let lastVerificationError: string | null = null
      // Set once a seller refused for lack of deposits: every other paid
      // seller would too, so only free ones are still worth trying.
      let unfunded = false
      // Sellers that failed this request, whatever the failure: an error
      // status, a dropped request, an empty answer. If a later seller serves
      // the same request, they could have too, and each failure counts
      // against its seller's health. If none does, the request itself may be
      // at fault: only failures that can only be the seller's count, and only
      // while the buyer itself is known to be healthy.
      const failedSellers = new Map<string, { serviceId: string; failure: FailedAttempt }>()
      const countFailures = (servedBy: string | null): void => {
        const buyerHealthy = this._attribution.isBuyerHealthy(this._now())
        for (const [peerId, { serviceId, failure }] of failedSellers) {
          // A seller that recovered on its own retry (a 429, then an answer)
          // proved nothing against itself.
          if (peerId === servedBy) continue
          if (servedBy === null && (!failure.sellerOnly || !buyerHealthy)) continue
          const detail = servedBy ? `${failure.description} (peer ${servedBy.slice(0, 12)}... served it)` : failure.description
          this._recordSellerFailure(peerId, serviceId, detail, failure.weight)
          log(`Peer ${peerId.slice(0, 12)}... ${detail}; counted against its ${serviceId} health.`)
        }
      }
      // Failures that only maybe are the seller's (a client error, an empty
      // answer) get one extra seller to compare against, not the whole list:
      // when every seller fails, the client gets that answer quickly.
      let comparisonUsed = false
      // A priced model with its own free allowance may still serve a buyer
      // without deposits: the seller answers 402 only when the allowance is out.
      const servesUnfunded = (candidate: (typeof candidates)[number]): boolean =>
        modelRouteTotalPrice(candidate) === 0
        || parseServiceFreeTierProgram(candidate.peer.capabilities, candidate.serviceId) !== null
      if (trace) {
        trace.freeSellersKnown = candidates.filter((candidate) => modelRouteTotalPrice(candidate) === 0).length
        trace.previousSkipped = this._previousSellerSkipped(trace.previousSeller, candidates, verdicts)
      }
      for (const [index, selected] of candidates.entries()) {
        if (unfunded && !servesUnfunded(selected)) {
          if (trace && selected.peerId.toLowerCase() === trace.previousSeller) trace.previousSkipped = 'needs_funds'
          continue
        }
        if (this._verifier) {
          const makeReach = (chosenId: string): SellerReach =>
            makeVerifierReach(this._node, selected.peer, chosenId, signal)
          const outcome = await this._verifyPeer(selected.peer, makeReach, signal, requireVerified)
          if (!outcome.ok) {
            lastVerificationError = `Peer ${selected.peer.peerId.slice(0, 12)}... failed required verification (${outcome.reason ?? 'failed'}).`
            log(`${lastVerificationError} Trying the next model peer.`)
            continue
          }
        }

        // Why this seller serves the request, for the gateway's request log. A
        // seller that fails is replaced by the next one's before any header goes out.
        const selection = selections.get(selected)
        if (selection && !res.headersSent) {
          res.setHeader(ROUTE_SELECTION_HEADER, encodeServedSelection({
            ...selection,
            rank: index + 1,
            of: candidates.length,
            attempt: index,
            pick: index === 0 ? firstPick : failedSellers.size > 0 || lastRetry !== null ? 'failover' : 'order',
          }))
        }
        for (let peerAttempt = 0; peerAttempt < MODEL_RATE_LIMIT_MAX_ATTEMPTS_PER_PEER; peerAttempt += 1) {
          log(
            `Auto-selected peer ${selected.peer.peerId.slice(0, 12)}... for model="${requestedService}" `
            + `service="${selected.serviceId}" reputation=${selected.reputation} `
            + `effective=${selected.effectiveReputationScore ?? 'unknown'} peer=${index + 1}/${candidates.length} `
            + `attempt=${peerAttempt + 1}/${MODEL_RATE_LIMIT_MAX_ATTEMPTS_PER_PEER}`,
          )
          if (trace) {
            trace.sellerTier = modelRouteTotalPrice(selected) === 0 ? 'free' : 'paid'
            trace.candidates = candidates.length
            trace.rank = index + 1
          }
          const result = await this._dispatchToPeer(
            res,
            selected.request,
            selected.peer,
            modelPlans,
            requestProtocol,
            selected.serviceId,
            explicitProvider,
            router,
            false,
            signal,
            requestPolicy !== null,
            routingConversationKey,
            !comparisonUsed && index + 1 < candidates.length,
            // With another seller to fall back on, don't wait far longer than
            // this one usually takes; the last seller gets the full timeout. A
            // probe of a seller with no recent data waits no longer than the
            // seller it stands in for would.
            index + 1 < candidates.length && !nativeVideo
              ? this._attemptTimeoutMs(selected === explored ? candidates[index + 1]! : selected, selected.request)
              : null,
          )
          trace?.noteAttemptResult(result, res.statusCode, Date.now())
          if (result.done) {
            if (trace && result.interrupted) trace.interrupted = result.interrupted
            // A stream that broke after its headers proves nothing for the
            // sellers before it, and counts against this one like any other
            // transport failure.
            if (result.interrupted === 'seller') {
              failedSellers.set(selected.peer.peerId, {
                serviceId: selected.serviceId,
                failure: { description: 'stream interrupted', sellerOnly: true, weight: 1 },
              })
            }
            const answered = res.statusCode < 400 && !result.emptyAnswer && !result.interrupted
            countFailures(answered ? selected.peer.peerId : null)
            // Only a seller that answered becomes the chat's route: an error
            // must not pin later turns to it.
            if (trackedConversationId && answered) {
              this._conversations.recordRoutedModel(
                trackedConversationId,
                `${selected.peer.peerId}@${selected.serviceId}`,
                conversationPinAtRouting,
              )
            }
            return result
          }
          // Never retry a video on another seller: a create may already have
          // started (and been charged), and follow-ups only exist on one seller.
          if (nativeVideo) return result
          lastRetry = result
          if (!isBuyerFault(result) && !result.modelNotFound && result.statusCode !== 402) {
            const failure = classifyFailedAttempt(result)
            failedSellers.set(selected.peer.peerId, { serviceId: selected.serviceId, failure })
            if (!failure.sellerOnly && result.statusCode !== 429) {
              comparisonUsed = true
              log(`Peer ${selected.peer.peerId.slice(0, 12)}... ${failure.description}; asking one more seller.`)
              break
            }
          }
          if (isBuyerFault(result)) {
            const freeLeft = candidates.slice(index + 1).some(servesUnfunded)
            if (result.statusCode === 402 && freeLeft) {
              unfunded = true
              log(`No deposits to pay peer ${selected.peer.peerId.slice(0, 12)}...; trying free sellers and free allowances only.`)
              break
            }
            return result
          }
          const retrySamePeer = result.statusCode === 429
            && peerAttempt + 1 < MODEL_RATE_LIMIT_MAX_ATTEMPTS_PER_PEER
          if (!retrySamePeer) break
          const delayMs = rateLimitRetryDelayMs(result.responseHeaders, peerAttempt)
          log(`Peer ${selected.peer.peerId.slice(0, 12)}... is rate-limited; retrying in ${delayMs}ms.`)
          if (!await waitForRetry(delayMs, signal)) return { done: true }
        }
        if (index + 1 < candidates.length) {
          log(`Peer ${selected.peer.peerId.slice(0, 12)}... failed retryably; trying next model peer.`)
        }
      }

      countFailures(null)
      return lastRetry ?? dispatchFailure(502, { 'content-type': 'application/json' }, JSON.stringify({
        error: {
          type: 'peer_verification_failed',
          code: 'peer_verification_failed',
          message: lastVerificationError ?? `No verified peer currently serves model "${requestedService}".`,
        },
      }))
    }

    const pinnedPeerId = explicitPeerId!

    // Narrow the candidate set to just the pinned peer (if we already know
    // about it) before running the per-peer protocol/service match. This
    // avoids wasting work — and spamming "Service strict-miss" log lines —
    // on every other discovered peer. If the pinned peer isn't in cache yet,
    // fall through with the full list so the "not in candidate set → force
    // refresh" path still works.
    const narrowToPinned = (sources: PeerInfo[]): PeerInfo[] => {
      const match = sources.find((p) => p.peerId.toLowerCase() === pinnedPeerId)
      return match ? [match] : sources
    }

    const selectPeers = (candidateSources: PeerInfo[]): CandidatePeerRouteSelection => selectCandidatePeersForRouting(
      narrowToPinned(candidateSources),
      requestProtocol,
      requestedService,
      explicitProvider,
      'lenient',
    )

    let hasForcedRefresh = false
    const refreshPeerSelection = async (reason: string): Promise<void> => {
      if (hasForcedRefresh) {
        return
      }
      hasForcedRefresh = true
      log(`Forcing peer refresh before routing after ${reason}.`)
      discoveredPeers = await this._getPeers({ forceRefresh: true })
      ;({
        candidatePeers: routingPeers,
        routePlanByPeerId: routingPlans,
      } = selectPeers(discoveredPeers))
    }

    let {
      candidatePeers,
      routePlanByPeerId,
    } = selectPeers(peers)

    let routingPeers = candidatePeers
    let routingPlans = routePlanByPeerId
    let discoveredPeers = peers

    const isPinnedDiscovered = (): boolean =>
      discoveredPeers.some((peer) => peer.peerId.toLowerCase() === pinnedPeerId)

    // Single refresh guard covers all three doubts about the cache: pin
    // missing, candidate filter empty, or cache past TTL.
    const cacheAgeMs = Date.now() - this._cacheLastUpdatedAtMs
    let pinnedDiscovered = isPinnedDiscovered()
    if (!pinnedDiscovered || routingPeers.length === 0 || cacheAgeMs > this._peerCacheTtlMs) {
      await refreshPeerSelection('pinned-peer routing preflight')
      pinnedDiscovered = isPinnedDiscovered()
    }

    if (!pinnedDiscovered) {
      const logSource = serializedReq.headers['x-antseed-pin-peer']
        ? 'x-antseed-pin-peer header'
        : bodyPinnedPeer
          ? 'model peer prefix'
          : '--peer flag or session pin'
      const diagnostics = this._formatPeerSelectionDiagnostics(discoveredPeers)
      log(`Pinned peer ${pinnedPeerId.slice(0, 12)}... not discoverable in DHT (${logSource})`)
      // Also the answer for a `<peerId>@<routingServiceId>` pin whose router
      // is offline: an absent peer cannot be told apart from a seller.
      return dispatchFailure(502, { 'content-type': 'text/plain' },
        `Pinned peer ${pinnedPeerId.slice(0, 12)}... (seller or routing service) is not reachable right now. `
        + 'It may be offline, not announcing, or temporarily unreachable. '
        + 'Pick a different service in Discover or try again later. '
        + diagnostics,
      )
    }

    if (routingPeers.length === 0) {
      const pinnedPeer = discoveredPeers.find((peer) => peer.peerId.toLowerCase() === pinnedPeerId) ?? null
      const protocolLabel = requestProtocol ? `protocol=${requestProtocol}` : 'protocol=unknown'
      const providerLabel = explicitProvider ? `provider=${explicitProvider}` : 'provider=auto'
      const serviceLabel = requestedService ? `service=${requestedService}` : 'service=none'
      const diagnostics = this._formatPeerSelectionDiagnostics(discoveredPeers)

      if (explicitProvider && pinnedPeer) {
        const providers = pinnedPeer.providers
          .map((provider) => provider.trim().toLowerCase())
          .filter((provider) => provider.length > 0)
        if (!providers.includes(explicitProvider)) {
          const providerList = providers.length > 0 ? providers.join(', ') : 'none'
          log(`Pinned peer ${pinnedPeerId.slice(0, 12)}... does not offer explicit provider=${explicitProvider}`)
          return dispatchFailure(502, { 'content-type': 'text/plain' },
            `Pinned peer ${pinnedPeerId.slice(0, 12)}... does not offer provider=${explicitProvider}. `
            + `Available providers: ${providerList}. `
            + 'Remove or change the x-antseed-provider header, or pick a different peer. '
            + diagnostics,
          )
        }
      }

      log(`Pinned peer ${pinnedPeerId.slice(0, 12)}... filtered out by protocol/service match`)
      return dispatchFailure(502, { 'content-type': 'text/plain' },
        `Pinned peer ${pinnedPeerId.slice(0, 12)}... does not support this request `
        + `(${protocolLabel}, ${providerLabel}, ${serviceLabel}). `
        + `Pick a different service in Discover. ${diagnostics}`,
      )
    }

    log(`Routing candidates: ${routingPeers.length} peer(s)`)

    const router = this._node.router

    const selectedPeer = routingPeers.find((p) => p.peerId.toLowerCase() === pinnedPeerId) ?? null

    // Defence in depth: the discovered+narrowed checks above should make this
    // branch unreachable. Keep a structured fallback so we don't silently hang
    // if an invariant breaks.
    if (!selectedPeer) {
      log(`Invariant: pinned peer ${pinnedPeerId.slice(0, 12)}... present in DHT but missing from narrowed candidate list`)
      return dispatchFailure(502, { 'content-type': 'text/plain' }, `Pinned peer ${pinnedPeerId.slice(0, 12)}... is currently unreachable. Try again in a moment.`)
    }
    const policyRouter = router as BuyerPolicyRouter | null | undefined
    const selectedPlan = routingPlans.get(selectedPeer.peerId)
      ?? resolvePeerRoutePlan(selectedPeer, requestProtocol, requestedService, explicitProvider, 'lenient')
    const pinnedServiceId = selectedPlan?.serviceId ?? requestedService
    const missingRequired = selectedPlan && !selectedPlan.selection?.requiresTransform
      ? findMissingRequiredParameters(
          selectedPeer,
          selectedPlan.provider,
          pinnedServiceId,
          requiredParameters,
        )
      : requiredParameters
    if (missingRequired.length > 0) {
      return dispatchFailure(422, { 'content-type': 'application/json' }, JSON.stringify({
        error: {
          type: 'required_capability_unavailable',
          code: 'required_capability_unavailable',
          message: `Pinned seller does not advertise required parameter(s) for model "${pinnedServiceId ?? requestedService ?? 'unknown'}": ${missingRequired.join(', ')}.`,
          param: REQUIRED_PARAMETERS_HEADER,
        },
      }))
    }
    const pinnedRequest = pinnedServiceId ? withRoutedModel(serializedReq, pinnedServiceId) : serializedReq
    // A hard pin cannot escape the gateway's policy: an excluded seller is
    // refused rather than silently swapped for another. Only the gateway
    // policy and the buyer's hard limits judge a pin, never the buyer's
    // routing preferences (they are automatic-routing defaults, as without
    // a gateway).
    const pinnedPolicy = this._effectivePolicy(requestPolicy)
    if (requestPolicy) {
      const offer = selectedPlan && pinnedServiceId
        ? findAdvertisedServiceOffer(selectedPeer, selectedPlan.provider, pinnedServiceId)
        : null
      const facts = this._policyFacts(selectedPeer, offer)
      const reasons = pinnedPeerExclusionReasons(requestPolicy, facts, requestedService)
      addBuyerConfigReasons(reasons, policyExclusionReasons(this._buyerHardPolicy(), facts))
      if (reasons.length > 0) {
        log(`Pinned peer ${selectedPeer.peerId.slice(0, 12)}... refused by routing policy: ${reasons.join('; ')}`)
        return dispatchFailure(403, { 'content-type': 'application/json' }, JSON.stringify({
          error: {
            type: 'permission_error',
            code: 'peer_not_allowed',
            message: `Seller ${selectedPeer.peerId.slice(0, 12)}... is not allowed by the routing policy (${reasons.join('; ')}).`,
          },
        }))
      }
    }
    if (!peerAllowedByPolicy(policyRouter, pinnedRequest, selectedPeer)) {
      log(`Pinned peer ${selectedPeer.peerId.slice(0, 12)}... filtered out by buyer routing policy`)
      return dispatchFailure(502, { 'content-type': 'text/plain' },
        `Pinned peer ${selectedPeer.peerId.slice(0, 12)}... is outside your buyer routing policy. `
        + 'Pick a different service in Discover or adjust your buyer pricing/reputation limits.',
      )
    }

    if (this._verifier) {
      const makeReach = (chosenId: string): SellerReach =>
        makeVerifierReach(this._node, selectedPeer, chosenId, signal)
      const outcome = await this._verifyPeer(selectedPeer, makeReach, signal, pinnedPolicy?.requireVerified === true)
      const short = selectedPeer.peerId.slice(0, 12)
      if (outcome.verified) {
        log(`Verified ${short}... via ${outcome.sdk}`)
      } else if (outcome.sdk || outcome.reason) {
        log(`Verification ${outcome.sdk ? `(${outcome.sdk}) ` : ''}did not pass for ${short}...: ${outcome.reason ?? 'failed'}${outcome.ok ? ' (optional — routing anyway)' : ''}`)
      }
      if (!outcome.ok) {
        return dispatchFailure(502, { 'content-type': 'text/plain' },
          `Pinned peer ${short}... failed required verification (${outcome.reason ?? 'failed'}). `
          + 'Pick a different peer, or run without --require-verifier.',
        )
      }
    }

    log(`Using pinned peer ${selectedPeer.peerId.slice(0, 12)}...`)
    if (trace) {
      trace.candidates = 1
      trace.rank = 1
      // Free or paid from the price the pinned seller advertises for this service, as for an automatic pick.
      const pinnedOffer = selectedPlan && pinnedServiceId
        ? findAdvertisedServiceOffer(selectedPeer, selectedPlan.provider, pinnedServiceId)
        : null
      const pinnedPrice = pinnedOffer ? modelRouteTotalPrice(pinnedOffer) : null
      trace.sellerTier = pinnedPrice === null ? 'unknown' : pinnedPrice === 0 ? 'free' : 'paid'
      if (trace.previousSeller && trace.previousSeller !== selectedPeer.peerId.toLowerCase()) {
        trace.previousSkipped = trace.routeMode === 'router' ? 'router_choice' : 'pinned_elsewhere'
      }
    }
    const result = await this._dispatchToPeer(
      res,
      pinnedRequest,
      selectedPeer,
      routingPlans,
      requestProtocol,
      requestedService,
      explicitProvider,
      router,
      true,
      signal,
      false,
      routingConversationKey,
    )
    trace?.noteAttemptResult(result, res.statusCode, Date.now())
    if (trace && result.done && result.interrupted) trace.interrupted = result.interrupted
    if (result.done && trackedConversationId && pinnedServiceId) {
      this._conversations.recordRoutedModel(
        trackedConversationId,
        `${selectedPeer.peerId}@${pinnedServiceId}`,
        conversationPinAtRouting,
      )
    }
    // A pinned peer is never retried against another peer; the caller reports
    // any failure. Failures only the seller can cause still count against it.
    if (!result.done && !isBuyerFault(result) && this._attribution.isBuyerHealthy(this._now())) {
      const failure = classifyFailedAttempt(result)
      if (failure.sellerOnly) this._recordSellerFailure(selectedPeer.peerId, pinnedServiceId ?? requestedService, failure.description, failure.weight)
    }
    return result
  }

  private async _verifyPeer(
    peer: PeerInfo,
    makeReach: (chosenId: string) => SellerReach,
    signal: AbortSignal,
    requireVerified = false,
  ): Promise<VerifyOutcome> {
    const configured = this._verifier
    if (!configured) return { ok: true, verified: false }
    // A routing policy's `requireVerified` makes the buyer's verifier mandatory for this request.
    const policy = requireVerified && !configured.require ? { ...configured, require: true } : configured
    const fingerprint = verifierSupportFingerprint(peer.capabilities)
    const outcome = await this._teeVerification.verify(peer, policy,
      () => runVerifier(policy, peer.peerId, peer.capabilities, makeReach, signal))
    const current = this._cachedPeers.find((candidate) => candidate.peerId === peer.peerId)
    if (current && verifierSupportFingerprint(current.capabilities) !== fingerprint) {
      return { ok: !policy.require, verified: false, transient: true, reason: 'Seller capabilities changed; retry verification' }
    }
    if (signal.aborted) return { ok: false, verified: false, transient: true, reason: 'Request aborted' }
    return outcome
  }

  private _parseMaxUploadBodyBytes(headers: Record<string, string>): number | null {
    const raw = headers['x-antseed-max-upload-body-bytes']
    if (!raw) return null
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  private _formatUploadLimitError(
    statusCode: number,
    body: Uint8Array,
    headers: Record<string, string>,
    requestBytes: number,
    requestedService: string | null,
  ): { code: string; message: string } | null {
    if (statusCode !== 413) return null
    const requestSize = this._formatBytes(requestBytes)
    const service = requestedService ? ` for ${requestedService}` : ''
    const bodyText = Buffer.from(body).toString('utf-8').trim()

    if (/upload body exceeds per-request limit/i.test(bodyText)) {
      const maxBytes = this._parseMaxUploadBodyBytes(headers)
      const maxSize = maxBytes != null ? this._formatBytes(maxBytes) : 'the seller upload limit'
      return {
        code: 'upload_body_too_large',
        message: `Request body${service} is ${requestSize}, but the selected seller allows ${maxSize} per request. `
          + 'This commonly happens when Codex sends a large repository context to /v1/responses. '
          + 'Reduce Codex context, exclude large/generated files, or pick a seller with a higher seller.maxUploadBodyBytes limit.',
      }
    }

    // Upstream providers and the proxies in front of them answer oversized
    // bodies with their own 413 (JSON or an HTML page). Clients resend the
    // whole history each turn, so images and attachments add up.
    return {
      code: 'request_too_large',
      message: `Request body${service} is ${requestSize}, more than the seller's upstream provider accepts. `
        + 'Images and large attachments in the conversation history are the usual cause, because they are resent on every turn. '
        + 'Start a new conversation or remove large attachments.',
    }
  }

  private _withFriendlyUploadLimitError(
    response: SerializedHttpResponse,
    requestBytes: number,
    requestedService: string | null,
  ): SerializedHttpResponse {
    const error = this._formatUploadLimitError(
      response.statusCode,
      response.body,
      response.headers,
      requestBytes,
      requestedService,
    )
    if (!error) return response
    return {
      ...response,
      headers: { ...response.headers, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        error: {
          type: error.code,
          code: error.code,
          message: error.message,
          requestBytes,
          sellerMaxUploadBodyBytes: this._parseMaxUploadBodyBytes(response.headers),
        },
      })),
    }
  }

  private _formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
    const mib = bytes / (1024 * 1024)
    if (mib >= 1) return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`
    const kib = bytes / 1024
    if (kib >= 1) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`
    return `${bytes} B`
  }

  /**
   * Dispatch a request to a specific peer. Returns `{ done: true }` if the response
   * was sent to the client (success or non-retryable error), or retry info if the
   * caller should try another peer.
   */
  private async _dispatchToPeer(
    res: ServerResponse,
    serializedReq: SerializedHttpRequest,
    selectedPeer: PeerInfo,
    routePlanByPeerId: Map<string, PeerProtocolRoutePlan>,
    requestProtocol: ServiceApiProtocol | null,
    requestedService: string | null,
    explicitProvider: string | null,
    router: Router | null,
    pinned: boolean,
    requestSignal: AbortSignal,
    gatewayRouted = false,
    routingConversationKey: string | null = null,
    extraAttempt = false,
    /** Give up on this seller if it has not started answering by then, so the next one can be tried. */
    attemptTimeoutMs: number | null = null,
  ): Promise<PeerDispatchResult> {
    traceFor(res)?.noteAttempt(selectedPeer.peerId, Date.now())
    const gatewayAutoRoute = gatewayRouted && !pinned
    const selectedRoutePlan = routePlanByPeerId.get(selectedPeer.peerId)
      ?? resolvePeerRoutePlan(selectedPeer, requestProtocol, requestedService, explicitProvider, 'lenient')

    if (!selectedRoutePlan) {
      return { done: false, statusCode: 502, responseBody: Buffer.from('No compatible provider route'), responseHeaders: { 'content-type': 'text/plain' }, errorMessage: null }
    }

    // Soft supportedParameters check — only for direct routes, since a
    // protocol transform rebuilds the body for the target protocol anyway.
    if (!selectedRoutePlan.selection?.requiresTransform) {
      const unannounced = findUnannouncedRequestParameters(
        selectedPeer,
        selectedRoutePlan.provider,
        requestedService,
        requestProtocol,
        serializedReq,
      )
      if (unannounced.length > 0) {
        log(
          `Warning: request to "${requestedService}" carries parameters peer ${selectedPeer.peerId.slice(0, 12)} `
          + `did not announce for this service: ${unannounced.join(', ')} — the upstream may ignore or reject them`,
        )
      }
    }

    const {
      'x-antseed-pin-peer': _pinPeer,
      'x-antseed-prefer-peer': _preferPeer,
      [BUYER_IDENTITY_HEADER]: buyerIdentity,
      [MAX_VIDEO_COST_HEADER]: maxVideoCostHeader,
      [REQUIRED_PARAMETERS_HEADER]: _requiredParameters,
      'x-vpr-session-id': _vprSession,
      // Legacy desktop builds (pre AntStation → VPR rename) still send this.
      'x-antstation-session-id': _antstationSession,
      'x-antseed-capture-response-auth-preimages': captureResponseAuthPreimages,
      ...headersForPeer
    } = serializedReq.headers
    let requestForPeer: SerializedHttpRequest = {
      ...serializedReq,
      headers: {
        ...headersForPeer,
        'x-antseed-provider': selectedRoutePlan.provider,
        ...(requestedService ? { 'x-antseed-service': requestedService } : {}),
      },
    }
    const latencyServiceId = selectedRoutePlan.serviceId ?? requestedService
    if (selectedRoutePlan.serviceId) {
      requestForPeer = withRoutedModel(requestForPeer, selectedRoutePlan.serviceId)
    }
    const clientWantsStreaming = requestWantsStreaming(serializedReq.headers, serializedReq.body)
    let adaptResponse: ((response: SerializedHttpResponse) => SerializedHttpResponse) | null = null
    let streamResponseAdapter: StreamingResponseAdapter | null = null

    if (selectedRoutePlan.selection?.requiresTransform) {
      const transformKey = `${requestProtocol}→${selectedRoutePlan.selection.targetProtocol}`
      const strategy = PROTOCOL_TRANSFORMS[transformKey]
      if (!strategy) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('Unsupported protocol transformation path')
        return { done: true }
      }

      log(`Applying protocol adapter ${transformKey} via provider "${selectedRoutePlan.provider}"`)
      const transformed = transformRequest(requestForPeer, {
        from: strategy.from,
        to: strategy.to,
        streamRequested: clientWantsStreaming,
      })
      if (!transformed) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`Failed to transform request for ${transformKey}`)
        return { done: true }
      }
      requestForPeer = {
        ...transformed.request,
        headers: {
          ...transformed.request.headers,
          'x-antseed-provider': selectedRoutePlan.provider,
        },
      }
      adaptResponse = (response: SerializedHttpResponse) =>
        transformResponse(response, {
          from: strategy.to,
          to: strategy.from,
          streamRequested: transformed.streamRequested,
          fallbackModel: transformed.requestedModel,
        }) ?? response
      if (transformed.streamRequested) {
        streamResponseAdapter = createStreamingAdapter({
          from: strategy.to,
          to: strategy.from,
          fallbackModel: transformed.requestedModel,
        })
        if (!streamResponseAdapter) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end(`Failed to create stream adapter for ${transformKey}`)
          return { done: true }
        }
      }
    }

    if (DEBUG()) {
      log(`Outbound request shape: ${summarizeRequestShape(requestForPeer)}`)
    }
    log(`Routing to peer ${selectedPeer.peerId.slice(0, 12)}...`)
    this._markModelActivity()

    // Forward through P2P
    const videoRoute = nativeVideoRoute(requestForPeer)
    // Video responses are JSON job objects or a streamed MP4, never SSE.
    const wantsStreaming = clientWantsStreaming && !videoRoute
    if (videoRoute?.action === 'retrieve') {
      // The seller hands a job only to the buyer that created it: retrieve with the same wallet.
      const { protocol, resourceId } = videoRoute
      await this._serializeVideoJob(`${protocol}\n${resourceId ?? ''}`, async () => {
        // Checked again in turn: a retrieve queued behind one that retired the job must not reach the seller.
        if (!resourceId || !this._resourceRoutes.resolve(protocol, resourceId)) {
          res.writeHead(404, { 'content-type': 'application/json', [VIDEO_JOB_RETIRED_HEADER]: '1' })
          res.end(JSON.stringify({ error: { code: 'video_route_not_found', message: 'Unknown video job' } }))
          return
        }
        await downloadVideo(requestForPeer, res, (request, callbacks, signal) => this._node.sendRequestStream(selectedPeer, request, callbacks, {
          signal, pinned: true, ...(buyerIdentity ? { buyerIdentity } : {}),
        }), requestSignal, () => this._retireVideoJob(protocol, resourceId))
      })
      return { done: true }
    }
    const peerResponseProtocol = selectedRoutePlan.selection?.targetProtocol ?? requestProtocol
    const adaptPeerResponse = (response: SerializedHttpResponse): SerializedHttpResponse =>
      adaptPeerFaultErrorResponse(response, peerResponseProtocol, { pinned, peerId: selectedPeer.peerId })
    // A free-tier refusal is written by the buyer, straight in the client's protocol and as JSON
    // even for a streamed request, so protocol conversion must not drop its `free_tier` details.
    const adaptFreeTierRefusal = (response: SerializedHttpResponse): SerializedHttpResponse | null =>
      isFreeTierExhaustedResponse(response)
        ? adaptPeerFaultErrorResponse(response, requestProtocol, { pinned, peerId: selectedPeer.peerId })
        : null
    const startTime = Date.now()
    const attemptAbort = new AbortController()
    const attemptSignal = attemptTimeoutMs ? AbortSignal.any([requestSignal, attemptAbort.signal]) : requestSignal
    const attemptTimer = attemptTimeoutMs
      ? setTimeout(() => attemptAbort.abort(new Error(`no answer within ${Math.round(attemptTimeoutMs / 1000)}s, about 4x this seller's usual time`)), attemptTimeoutMs)
      : null
    attemptTimer?.unref?.()
    const sellerKey = selectedPeer.peerId.toLowerCase()
    this._inFlightBySeller.set(sellerKey, (this._inFlightBySeller.get(sellerKey) ?? 0) + 1)
    try {
      if (wantsStreaming) {
        let streamed = false
        let firstFrameAt = 0
        let streamStartBody: Uint8Array = new Uint8Array()
        const response = await this._node.sendRequestStream(selectedPeer, requestForPeer, {
          onResponseStart: (startResponse: SerializedHttpResponse, metadata: RequestStreamResponseMetadata) => {
            if (!metadata.streaming) return
            // The seller is answering: from here a slow answer is still an answer.
            if (attemptTimer) clearTimeout(attemptTimer)
            streamed = true
            firstFrameAt = Date.now()
            traceFor(res)?.noteFirstByte(firstFrameAt)
            streamStartBody = startResponse.body
            const adaptedStartResponse = streamResponseAdapter
              ? streamResponseAdapter.adaptStart(startResponse)
              : startResponse
            const streamingHeaders = attachStreamingAntseedHeaders(
              adaptedStartResponse.headers,
              selectedPeer,
              requestForPeer,
              firstFrameAt - startTime,
            )
            // Ensure content-type is set for SSE — some upstream APIs (e.g. Codex)
            // omit it, which can cause the client's fetch body reader to not
            // detect end-of-stream properly.
            if (!streamingHeaders['content-type']) {
              streamingHeaders['content-type'] = 'text/event-stream'
            }
            res.writeHead(adaptedStartResponse.statusCode, streamingHeaders)
            if (adaptedStartResponse.body.length > 0) {
              res.write(Buffer.from(adaptedStartResponse.body))
            }
          },
          onResponseChunk: (chunk: SerializedHttpResponseChunk) => {
            if (!streamed) return
            this._markModelActivity()
            const adaptedChunks = streamResponseAdapter
              ? streamResponseAdapter.adaptChunk(chunk)
              : [chunk]
            for (const adaptedChunk of adaptedChunks) {
              if (adaptedChunk.data.length > 0) {
                res.write(Buffer.from(adaptedChunk.data))
              }
            }
          },
        }, {
          signal: attemptSignal,
          pinned,
          captureResponseAuthPreimages: captureResponseAuthPreimages === '1',
          ...(buyerIdentity ? { buyerIdentity } : {}),
        })

        recordRouterUsage(this._modelRoutingClient, routingConversationKey, requestForPeer, response, selectedPeer, requestSignal)

        let responseForClient = adaptBuyerFaultErrorResponse(response, requestProtocol)
        const freeTierRefusal = adaptFreeTierRefusal(responseForClient)
        responseForClient = freeTierRefusal ?? adaptPeerResponse(responseForClient)
        if (
          !streamed
          && !freeTierRefusal
          && adaptResponse
          && responseForClient.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER]?.toLowerCase() !== 'buyer'
        ) {
          responseForClient = adaptResponse(responseForClient)
        }
        responseForClient = adaptOpenAICompatibleErrorResponse(responseForClient, requestProtocol)
        responseForClient = this._withFriendlyUploadLimitError(responseForClient, requestForPeer.body.length, requestedService)
        if (responseForClient.statusCode === 402) {
          responseForClient = inject402PeerId(responseForClient, selectedPeer.peerId)
        }

        const finishedAt = Date.now()
        if (!streamed) traceFor(res)?.noteAnswered(finishedAt, response.statusCode, freeTierRefusal !== null)
        const latencyMs = finishedAt - startTime
        log(`Response: ${responseForClient.statusCode} (${latencyMs}ms, ${responseForClient.body.length} bytes)`)
        if (responseForClient.statusCode >= 400) {
          const prefix = adaptResponse && !streamed ? 'Upstream adapted error detail' : 'Upstream error detail'
          log(`${prefix}: ${summarizeErrorResponse(responseForClient)}`)
        }

        const telemetry = computeResponseTelemetry(
          requestForPeer,
          responseForClient.headers,
          responseForClient.body,
          selectedPeer,
        )
        const usageTrace = responseForClient.statusCode < 400 ? traceFor(res) : undefined
        if (usageTrace) {
          // A stream's first frame (Anthropic's message_start) can carry the
          // input and cache counts, so the trace reads the whole stream.
          const fullBody = streamed && streamStartBody.length > 0
            ? Buffer.concat([streamStartBody, responseForClient.body])
            : responseForClient.body
          const fullTelemetry = fullBody === responseForClient.body
            ? telemetry
            : computeResponseTelemetry(requestForPeer, responseForClient.headers, fullBody, selectedPeer)
          usageTrace.noteUsage(fullTelemetry.usage)
          usageTrace.noteAnswerDetails({
            finishReason: finishReasonFromBody(responseForClient.headers['content-type'], fullBody),
            estimatedCostUsd: fullTelemetry.estimatedCostUsd,
          })
        }
        let streamTiming: { firstTokenMs: number; streamMs: number; outputTokens: number; streamed: true } | null = null
        if (streamed && responseForClient.statusCode < 400) {
          streamTiming = { firstTokenMs: firstFrameAt - startTime, streamMs: finishedAt - firstFrameAt, outputTokens: telemetry.usage.outputTokens, streamed: true }
        }
        const responseFault = responseFaultAttribution(responseForClient)
        const modelNotFound = !streamed
          && !isControlPlaneServicesPath(requestForPeer.path)
          && isModelNotFoundResponse(responseForClient)
        if (modelNotFound) {
          this._onModelNotFound(selectedPeer.peerId, requestedService)
        }
        if (router && responseFault !== 'buyer') {
          router.onResult(selectedPeer, {
            success: !modelNotFound
              && isRouterSuccess(responseForClient.statusCode, requestForPeer.path, retryableStatusCodesFor(gatewayAutoRoute)),
            latencyMs,
            tokens: telemetry.usage.totalTokens,
          })
        }

        if (responseFault === 'buyer') {
          this._recordPeerFailure(selectedPeer.peerId, 'buyer-local', 'buyer')
        } else {
          this._recordPeerResponseHealth(
            selectedPeer.peerId, responseForClient.statusCode, requestForPeer.path,
          )
        }

        if (streamed) {
          const streamedBody = Buffer.concat([streamStartBody, response.body])
          // The seller's provider failed after the stream started: the wire
          // ends normally, but the answer never completed.
          const streamFailed = responseForClient.statusCode < 300
            && hasStreamError(response.headers['content-type'], streamedBody)
          const streamedEmpty = !pinned && !streamFailed && responseForClient.statusCode < 300
            && isEmptyAnswer(response.headers['content-type'], streamedBody)
          // Already sent, so there is nothing to compare against: an empty
          // answer counts against the seller by itself.
          if (streamedEmpty) this._recordSellerFailure(selectedPeer.peerId, latencyServiceId, 'streamed an answer with no text or tool call')
          else if (streamFailed) {
            // Auto-routing attributes it with the other attempts; a pinned
            // request has no other attempts, so count it here.
            if (pinned && this._attribution.isBuyerHealthy(this._now())) {
              this._recordSellerFailure(selectedPeer.peerId, latencyServiceId, 'stream interrupted')
            }
          } else if (streamTiming) this._recordSellerSuccess(selectedPeer.peerId, latencyServiceId, streamTiming)
          // Headers already sent to client, can't retry
          if (!res.writableEnded) {
            res.end()
          }
          return streamFailed ? { done: true, interrupted: 'seller' } : { done: true, emptyAnswer: streamedEmpty }
        }

        // Non-streamed response — check if retryable
        const responseHeaders = attachAntseedTelemetryHeaders(
          responseForClient.headers,
          selectedPeer,
          telemetry,
          requestForPeer.requestId,
          latencyMs,
        )
        const answeredEmpty = !pinned && responseForClient.statusCode < 300
          && isEmptyAnswer(responseForClient.headers['content-type'], responseForClient.body)
        const emptyAnswer = extraAttempt && answeredEmpty
        if (emptyAnswer || shouldTryNextPeer(responseForClient.statusCode, modelNotFound, pinned, gatewayAutoRoute, extraAttempt && responseFault !== 'buyer')) {
          return {
            done: false,
            statusCode: responseForClient.statusCode,
            responseBody: Buffer.from(responseForClient.body),
            responseHeaders,
            errorMessage: null,
            modelNotFound,
            emptyAnswer,
          }
        }

        if (responseForClient.statusCode < 300 && !answeredEmpty && !isControlPlaneServicesPath(requestForPeer.path)) {
          this._recordSellerSuccess(selectedPeer.peerId, latencyServiceId, { firstTokenMs: latencyMs, outputTokens: telemetry.usage.outputTokens, streamed: false })
        }
        res.writeHead(responseForClient.statusCode, responseHeaders)
        res.end(Buffer.from(responseForClient.body))
        return { done: true, emptyAnswer: answeredEmpty }
      } else {
        const maxVideoCostUsdc = videoRoute?.action === 'create' ? parseUsdcBaseUnits(maxVideoCostHeader) : null
        const upstreamResponse = await this._node.sendRequest(selectedPeer, requestForPeer, {
          signal: attemptSignal,
          pinned,
          captureResponseAuthPreimages: captureResponseAuthPreimages === '1',
          ...(buyerIdentity ? { buyerIdentity } : {}),
          ...(maxVideoCostUsdc !== null ? { maxVideoCostUsdc } : {}),
        })
        if (upstreamResponse.statusCode >= 400 && !adaptResponse) {
          log(`Upstream raw error detail: ${summarizeErrorResponse(upstreamResponse)}`)
        }

        recordRouterUsage(this._modelRoutingClient, routingConversationKey, requestForPeer, upstreamResponse, selectedPeer, requestSignal)

        // Only the seller that accepted a video job knows its ID. Remember and
        // persist job ID -> seller so later retrieve requests (even
        // after a proxy restart) are pinned back to that seller.
        if (videoRoute && recordVideoAcceptance(
          videoRoute,
          upstreamResponse,
          { peerId: selectedPeer.peerId, provider: selectedRoutePlan.provider, service: requestedService },
          this._resourceRoutes,
        )) {
          await this._persistResourceRoutes().catch(error => console.error('[proxy] Accepted video route was not persisted:', error))
        }
        let response = adaptBuyerFaultErrorResponse(upstreamResponse, requestProtocol)
        const freeTierRefusal = adaptFreeTierRefusal(response)
        response = freeTierRefusal ?? adaptPeerResponse(response)
        if (
          !freeTierRefusal
          && adaptResponse
          && response.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER]?.toLowerCase() !== 'buyer'
        ) {
          response = adaptResponse(response)
        }
        response = adaptOpenAICompatibleErrorResponse(response, requestProtocol)
        response = this._withFriendlyUploadLimitError(response, requestForPeer.body.length, requestedService)
        if (response.statusCode === 402) {
          response = inject402PeerId(response, selectedPeer.peerId)
        }
        const latencyMs = Date.now() - startTime
        this._markModelActivity()
        traceFor(res)?.noteAnswered(Date.now(), response.statusCode, freeTierRefusal !== null)

        log(`Response: ${response.statusCode} (${latencyMs}ms, ${response.body.length} bytes)`)
        if (response.statusCode >= 400) {
          const prefix = adaptResponse ? 'Upstream adapted error detail' : 'Upstream error detail'
          log(`${prefix}: ${summarizeErrorResponse(response)}`)
        }

        const telemetry = computeResponseTelemetry(requestForPeer, response.headers, response.body, selectedPeer)
        const answerTrace = response.statusCode < 400 ? traceFor(res) : undefined
        if (answerTrace) {
          answerTrace.noteUsage(telemetry.usage)
          answerTrace.noteAnswerDetails({
            finishReason: finishReasonFromBody(response.headers['content-type'], response.body),
            estimatedCostUsd: telemetry.estimatedCostUsd,
          })
        }
        const responseHeaders = attachAntseedTelemetryHeaders(
          response.headers,
          selectedPeer,
          telemetry,
          requestForPeer.requestId,
          latencyMs,
        )

        const responseFault = responseFaultAttribution(response)
        const modelNotFound = !isControlPlaneServicesPath(requestForPeer.path)
          && isModelNotFoundResponse(response)
        if (modelNotFound) {
          this._onModelNotFound(selectedPeer.peerId, requestedService)
        }
        // Report result to router for learning
        if (router && responseFault !== 'buyer') {
          router.onResult(selectedPeer, {
            success: !modelNotFound
              && isRouterSuccess(response.statusCode, requestForPeer.path, retryableStatusCodesFor(gatewayAutoRoute)),
            latencyMs,
            tokens: telemetry.usage.totalTokens,
          })
        }

        if (responseFault === 'buyer') {
          this._recordPeerFailure(selectedPeer.peerId, 'buyer-local', 'buyer')
        } else {
          this._recordPeerResponseHealth(selectedPeer.peerId, response.statusCode, requestForPeer.path)
        }

        // Check if retryable
        const answeredEmpty = !pinned && response.statusCode < 300 && !videoRoute
          && isEmptyAnswer(response.headers['content-type'], response.body)
        const emptyAnswer = extraAttempt && answeredEmpty
        if (emptyAnswer || shouldTryNextPeer(response.statusCode, modelNotFound, pinned, gatewayAutoRoute, extraAttempt && responseFault !== 'buyer')) {
          return { done: false, statusCode: response.statusCode, responseBody: Buffer.from(response.body), responseHeaders, errorMessage: null, modelNotFound, emptyAnswer }
        }

        if (response.statusCode < 300 && !answeredEmpty && !videoRoute && !isControlPlaneServicesPath(requestForPeer.path)) {
          this._recordSellerSuccess(selectedPeer.peerId, latencyServiceId, { firstTokenMs: latencyMs, outputTokens: telemetry.usage.outputTokens, streamed: false })
        }
        // Forward response headers and body to the HTTP client
        res.writeHead(response.statusCode, responseHeaders)
        res.end(Buffer.from(response.body))
        return { done: true, emptyAnswer: answeredEmpty }
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime
      const timedOut = attemptAbort.signal.aborted && !requestSignal.aborted
      const message = timedOut
        ? (attemptAbort.signal.reason as Error).message
        : err instanceof Error ? err.message : String(err)
      const abortedLocally = requestSignal.aborted
      log(`Request failed after ${latencyMs}ms: ${message}`)

      if (abortedLocally) {
        log(`Request ${requestForPeer.requestId.slice(0, 8)} aborted locally; skipping retry, router penalty, and peer eviction.`)
        if (!res.writableEnded) {
          let responded = false
          if (!res.headersSent) {
            try {
              res.writeHead(499, { 'content-type': 'text/plain' })
              responded = true
            } catch {
              // ignore
            }
          }
          try {
            if (res.writableEnded) {
              // no-op
            } else {
              if (responded) {
                res.end('Request cancelled')
              } else {
                res.end()
              }
              responded = true
            }
          } catch {
            // ignore
          }
        }
        return { done: true, interrupted: 'cancelled' }
      }

      // Whose fault was this? Errors raised by our own wallet, deposits,
      // transport or state machine say nothing about the peer, and telling the
      // user to blame the seller for their empty deposit sends them chasing the
      // wrong fix. Anything untagged stays 'unknown', where the attribution
      // gates decide.
      const fault = faultAttributionOf(err)
      const faultCode = faultCodeOf(err)
      this._recordPeerFailure(
        selectedPeer.peerId,
        fault === 'buyer' ? 'buyer-local' : 'request-failed',
        fault,
      )

      if (res.headersSent) {
        // Headers already sent (streaming), can't retry
        if (!res.writableEnded) {
          res.end()
        }
        return { done: true, interrupted: fault === 'buyer' ? 'buyer' : 'seller' }
      }

      if (fault === 'buyer') {
        const buyerResponse = adaptBuyerFaultErrorResponse({
          requestId: requestForPeer.requestId,
          statusCode: buyerFaultStatusCode(faultCode),
          headers: {
            'content-type': 'application/json',
            [ANTSEED_FAULT_ATTRIBUTION_HEADER]: 'buyer',
          },
          body: Buffer.from(JSON.stringify({
            error: {
              type: 'buyer_request_failed',
              code: faultCode ?? 'buyer_request_failed',
              message,
            },
          })),
        }, requestProtocol)
        return {
          done: false,
          statusCode: buyerResponse.statusCode,
          responseBody: Buffer.from(buyerResponse.body),
          responseHeaders: buyerResponse.headers,
          errorMessage: message,
        }
      }

      const peerResponse = adaptPeerResponse({
        requestId: requestForPeer.requestId,
        statusCode: 502,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(message),
      })
      return {
        done: false,
        statusCode: peerResponse.statusCode,
        responseBody: Buffer.from(peerResponse.body),
        responseHeaders: peerResponse.headers,
        errorMessage: message,
        timedOut,
      }
    } finally {
      if (attemptTimer) clearTimeout(attemptTimer)
      const remaining = (this._inFlightBySeller.get(sellerKey) ?? 1) - 1
      if (remaining > 0) this._inFlightBySeller.set(sellerKey, remaining)
      else this._inFlightBySeller.delete(sellerKey)
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
