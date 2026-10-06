import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { watchFile, unwatchFile } from 'node:fs'
import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ANTSEED_BUYER_FAULT_ERROR_CODE,
  ANTSEED_FAULT_ATTRIBUTION_HEADER,
  ANTSEED_ATTEST_PATH,
  adaptPeerFaultErrorResponse,
  computeTrustScore,
  decodeSweepRequest,
  faultAttributionOf,
  faultCodeOf,
  isModelRouteEligible,
  modelRouteTotalPrice,
  normalizedModelReputationScore,
  peerSupportsCooperativeClose,
  rankModelRoutes,
  sanitizePeerDisplayName,
  type AntseedNode,
  type FaultAttribution,
  type BuyerSpendEvent,
  type PeerInfo,
  type PeerMetadata,
  type ModelRoutingPreferences,
  type RequestStreamResponseMetadata,
  type Router,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
  type SweepReceiptPayload,
} from '@antseed/node'
import { canonicalModelKey } from '@antseed/node/model-identity'
import {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
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
  normalizePeerId,
} from './request-utils.js'
import {
  buildNetworkModels,
  effectiveModelReputationScore,
  parseModelTypeFilter,
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
  attachStreamingAntseedHeaders,
} from './telemetry.js'
import { DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS } from '../config/defaults.js'
import {
  extractConversationIdentity,
  extractFirstUserSnippet,
  isCompletionRequestPath,
  isTitleGenerationRequest,
  parseRequestBodyObject,
} from './conversation-identity.js'
import { ConversationStore } from './conversation-store.js'
import type { DepositWatcher } from './deposit-watcher.js'
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
import { estimateAnthropicPromptTokens, isCountTokensPath } from './count-tokens.js'
import { runVerifier, verifierSupportFingerprint, type VerifierPolicy, type SellerReach, type VerifyOutcome } from '../plugins/verifier.js'
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status'
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { TeeVerification } from './tee-verification.js'
import { TeeControl } from './tee-control.js'
import { loadConfig } from '../config/loader.js'

// Re-export for backward compatibility (used by tests and other consumers)
export { selectCandidatePeersForRouting, type CandidatePeerRouteSelection } from './routing.js'
export { parsePeerPinnedService, rewritePeerPinnedServiceInBody, substituteRoutedModelAlias, ROUTED_MODEL_ALIAS } from './request-utils.js'

/**
 * Why this daemon runs no hot-wallet deposit watcher — surfaced on
 * `/_antseed/deposits/status` so UIs can name the actual cause instead of
 * guessing (a missing watcher used to be indistinguishable from "this chain
 * has no deposit relay").
 */
export type DepositWatcherAbsenceReason = 'external-daemon' | 'payments-disabled' | 'no-deposit-relay'

const WATCHER_ABSENCE_ERRORS: Record<DepositWatcherAbsenceReason, string> = {
  'payments-disabled': 'Deposit watcher unavailable — payments are disabled on this buyer.',
  'no-deposit-relay': 'Deposit watcher unavailable — this chain has no deposit relay.',
  'external-daemon': 'Deposit watcher unavailable — another daemon owns the proxy port and runs the watcher.',
}

export interface BuyerProxyConfig {
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
  /** Verifier-SDK policy: which verifier the buyer commits to + whether it is required. */
  verifier?: VerifierPolicy
}

// 401/403 are included: sellers relay upstream auth failures (revoked or
// expired key, region/WAF block) that are specific to that seller's upstream
// account, so another peer serving the same model can usually complete the
// request. 402 stays terminal (buyer payment flow), and 404 stays terminal
// because model_not_found already has dedicated unadvertise handling while a
// generic 404 would repeat identically on every peer.
const RETRYABLE_STATUS_CODES = new Set([401, 403, 408, 429, 500, 502, 503, 504])
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

function isControlPlaneServicesPath(path: string): boolean {
  return path.toLowerCase().startsWith('/v1/models')
}

function isRouterSuccess(statusCode: number, path: string, retryableStatusCodes: Set<number>): boolean {
  return isControlPlaneServicesPath(path) || !retryableStatusCodes.has(statusCode)
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
}

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

export class BuyerProxy {
  private readonly _server: Server
  private readonly _node: AntseedNode
  private readonly _port: number
  private readonly _bgRefreshIntervalMs: number
  private readonly _peerCacheTtlMs: number
  private readonly _stateDir: string
  private readonly _stateFile: string
  private readonly _configPath: string | null
  private _stateFileWatching = false
  private _configFileWatching = false
  private _pinnedPeer: string | null
  /**
   * Route substituted for the `antseed` model alias (`<service>` for automatic
   * peer selection, or `<peerId>@<service>` for an explicit seller pin).
   * Set via `POST /_antseed/route` (the desktop keeps it on the current VPR
   * selection) and persisted in buyer.state.json like the session peer pin.
   */
  private _defaultRoutedModel: string | null = null
  private _conversations!: ConversationStore
  /**
   * Wall-clock of the last model-request activity (dispatch or streamed
   * frame). Exposed on /_antseed/buyer-usage so the desktop pill can show a
   * live "traffic" signal without depending on debug logging. A single field
   * write per frame — negligible next to the routing/payment/stream work.
   */
  private _lastModelActivityAt = 0
  private readonly _verifier?: VerifierPolicy
  private readonly _teeVerification: TeeVerification
  private readonly _teeControl: TeeControl
  private _stateWatchDebounce: ReturnType<typeof setTimeout> | null = null
  private _configWatchDebounce: ReturnType<typeof setTimeout> | null = null
  private _routingPreferences: ModelRoutingPreferences | null

  private _stateWriteChain: Promise<void> = Promise.resolve()

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

  /**
   * requestId -> the conversation that issued it, so the node's per-request
   * spend events can be attributed to a chat. Only the proxy knows this
   * mapping; the payment layer sees a seller and a request id.
   *
   * `counted` guards requestCount: one request can produce several spend
   * deltas (buyer- and seller-initiated auth both advance the cumulative).
   */
  private readonly _requestConversations = new Map<string, { convId: string; counted: boolean }>()

  constructor(config: BuyerProxyConfig) {
    this._node = config.node
    this._verifier = config.verifier
    this._teeVerification = new TeeVerification(config.verifier)
    this._teeControl = new TeeControl(this._teeVerification.sessionId)
    this._port = config.port
    this._bgRefreshIntervalMs = Math.max(1, config.backgroundRefreshIntervalMs ?? DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS)
    this._peerCacheTtlMs = Math.max(0, config.peerCacheTtlMs ?? Math.max(6 * 60_000, this._bgRefreshIntervalMs + 60_000))
    this._stateDir = config.dataDir
    this._stateFile = join(config.dataDir, 'buyer.state.json')
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
      on?: (event: 'payment:spend', listener: (event: BuyerSpendEvent) => void) => unknown
    }
    if (typeof spendEventNode.on === 'function') {
      spendEventNode.on('payment:spend', (event: BuyerSpendEvent) => {
        this._attributeSpend(event)
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
    this._conversations.addSpend(
      entry.convId,
      {
        amountUsdc: event.amountUsdc,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
      },
      !entry.counted,
    )
    entry.counted = true
  }

  /**
   * Remember which chat a request belongs to for the life of the request plus
   * a grace window — the seller-initiated auth path can land just after the
   * response is returned. Bounded so a leaked id can't grow the map forever.
   */
  private _trackRequestConversation(requestId: string, convId: string): void {
    this._requestConversations.set(requestId, { convId, counted: false })
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
    return new Promise((resolve) => {
      this._server.close(() => resolve())
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
      log(`Session overrides reloaded: peer=${this._pinnedPeer ?? 'none'} route=${this._defaultRoutedModel ?? 'none'}`)
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
    try {
      const config = await loadConfig(this._configPath)
      const next = config.buyer.routingPreferences
      this._routingPreferences = {
        ...next,
        allowedPeerIds: [...next.allowedPeerIds],
        blockedPeerIds: [...next.blockedPeerIds],
      }
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

  private async _writeStateFile(state: 'connected' | 'stopped'): Promise<void> {
    // When stopping, preserve whatever session overrides are already
    // in the file — the debounce may have been cancelled before
    // _reloadSessionOverrides could commit the latest CLI-written values.
    const sessionOverrides = state === 'connected'
      ? { pinnedPeerId: this._pinnedPeer, defaultRoutedModel: this._defaultRoutedModel }
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
        })
      return
    }
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
        onChainPoolStakeAnts: p.onChainPoolStakeAnts ?? null,
        onChainPoolPowerShareBps: p.onChainPoolPowerShareBps ?? null,
        onChainUsageEpoch: p.onChainUsageEpoch ?? null,
        onChainUsageShareBps: p.onChainUsageShareBps ?? null,
        onChainUsageLastEpochUsdcMicros: p.onChainUsageLastEpochUsdcMicros ?? null,
        onChainWashFlagged: p.onChainWashFlagged ?? null,
        onChainWashShareBps: p.onChainWashShareBps ?? null,
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
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, peerId: normalized }))
      return
    }

    if (path === '/_antseed/route' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, model: this._defaultRoutedModel }))
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
      let model: string
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        model = typeof body.model === 'string' ? body.model.trim() : ''
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
        return
      }
      if (model.length > 0 && !isValidRoutedModelTarget(model)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'model must be "<service>", "<peerId>@<service>", or empty to clear' }))
        return
      }
      this._defaultRoutedModel = model.length > 0 ? model : null
      await this._mergeStateFile({ defaultRoutedModel: this._defaultRoutedModel })
      log(`Default routed model set: ${this._defaultRoutedModel ?? 'none'}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, model: this._defaultRoutedModel }))
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

    if (path.startsWith('/_antseed/channels') && method === 'GET') {
      const all = /[?&]all=1/.test(path)
      const channels = all
        ? this._node.getAllBuyerChannels()
        : this._node.getActiveBuyerChannels()
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

    if (path.startsWith('/_antseed/buyer-usage') && method === 'GET') {
      const totals = this._node.getBuyerUsageTotals()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, totals, lastActivityAt: this._lastModelActivityAt || null }))
      return
    }

    const meteringMatch = path.match(/^\/_antseed\/metering\/(.+)$/)
    if (meteringMatch && method === 'GET') {
      const sellerPeerId = decodeURIComponent(meteringMatch[1]!)
      const stats = this._node.getMeteringStatsByPeer(sellerPeerId)
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
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        peerId = String(body.peerId ?? '')
        if (body.includeAuth === false) includeAuth = false
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
      try {
        const result = await this._node.requestChannelClose(peerId, { includeAuth })
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
    if (path === '/_antseed/deposits/status' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        watcher: this._depositWatcher !== null,
        // Why no watcher runs (null while one is attached) — lets UIs say
        // "payments are disabled" vs "this chain has no deposit relay".
        reason: this._depositWatcher ? null : this._depositWatcherAbsence,
        // Live payments health: configured/active flags + chain-RPC
        // reachability from the node's background monitor. Optional call —
        // tolerate an older @antseed/node without it.
        payments: this._node.getPaymentsStatus?.() ?? null,
        status: this._depositWatcher?.status() ?? null,
      }))
      return
    }

    if (path === '/_antseed/deposits/watch' && method === 'POST') {
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
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
        mode = String(body.mode ?? 'active')
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
      const watcher = this._depositWatcher
      if (!watcher) {
        const reason = this._depositWatcherAbsence
        const error = (reason && WATCHER_ABSENCE_ERRORS[reason]) ?? 'Deposit watcher unavailable.'
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, reason, error }))
        return
      }
      if (mode === 'active') watcher.promote()
      else watcher.demote()
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
  private async _handleNetworkModels(res: ServerResponse, rawPath: string): Promise<void> {
    const url = new URL(rawPath, 'http://localhost')
    const responseHeaders = { 'content-type': 'application/json', 'x-antseed-request-id': randomUUID() }
    const peers = await this._getPeers()
    const models = buildNetworkModels(peers, this._now(), {
      routingPreferences: this._routingPreferences,
      peerHealth: this._peerHealth,
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
          message: `Unknown model type "${url.searchParams.get('type') ?? ''}" — expected "text", "images", or "decisions".`,
          type: 'invalid_request_error',
          param: 'type',
        },
      }))
      return
    }

    const data = typeFilter === 'all' ? models : models.filter((entry) => entry.type === typeFilter)
    log(`GET /v1/models answered locally: ${data.length} models across ${peers.length} peers${typeFilter ? ` (type=${typeFilter})` : ''}`)
    res.writeHead(200, responseHeaders)
    res.end(JSON.stringify({ object: 'list', data }))
  }

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'

    log(`${method} ${path}`)

    // Control-plane endpoints — handle before collecting proxy body
    if (path.startsWith('/_antseed/')) {
      return this._handleControlPlane(req, res, method, path)
    }

    // Only proxy known API paths — reject everything else with 404
    const normalizedPath = path.split('?')[0]?.trim().toLowerCase() ?? '/'
    const isKnownApiPath =
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

    // `/v1/models` is answered locally from the discovered-peer cache: one
    // entry per model across the whole network, with the peers serving it.
    // Routed to a single pinned seller it would only cover that seller's
    // services — and would require a pin just to browse the network.
    if (method === 'GET' && normalizedPath.startsWith('/v1/models')) {
      return this._handleNetworkModels(res, path)
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

    // Build serialized request
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ')
      }
    }
    // Remove host header (points to localhost, not the seller)
    delete headers['host']
    // Internal marker from the system proxy: the body's model was assigned
    // by the proxy's route rewrite, not chosen by the tool. Stripped here so
    // it never reaches a seller.
    const systemRoutedModel = headers[SYSTEM_ROUTED_MODEL_HEADER] === '1'
    delete headers[SYSTEM_ROUTED_MODEL_HEADER]

    let serializedReq: SerializedHttpRequest = {
      requestId: randomUUID(),
      method,
      path,
      headers,
      body: new Uint8Array(body),
    }
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
    // Internal marker from the system proxy: source profile used only for
    // local conversation attribution. Stripped here so it never reaches a seller.
    delete serializedReq.headers[SYSTEM_PROXY_SOURCE_HEADER]
    const trackedConversationKey = conversationIdentity
      ? conversationIdentity.parentSessionKey ?? conversationIdentity.sessionKey
      : null
    const storedConversation = conversationIdentity && trackedConversationKey
      ? this._conversations.get(`${conversationIdentity.tool}:${trackedConversationKey}`)
      : null
    const storedAutoRoute = storedConversation?.peerSource === 'auto' && storedConversation.pinnedModel
      ? parsePeerPinnedService(storedConversation.pinnedModel)
      : null
    const chatPinnedModel = storedConversation?.peerSource === 'user'
      ? storedConversation.pinnedModel
      : storedAutoRoute?.service ?? storedConversation?.pinnedModel ?? null
    const preferredPeerHeader = normalizePeerId(serializedReq.headers['x-antseed-prefer-peer'] ?? '')
    const preferredConversationPeerId = preferredPeerHeader ?? storedAutoRoute?.peerId ?? null
    const effectiveRoutedModel = chatPinnedModel ?? this._defaultRoutedModel
    let trackedConversationId: string | null = storedConversation?.id ?? null

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
      return
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

    const clientAbortController = new AbortController()
    const onClientAbort = (): void => {
      if (clientAbortController.signal.aborted) {
        return
      }
      clientAbortController.abort()
      log(`Client disconnected; aborting upstream request reqId=${serializedReq.requestId.slice(0, 8)}`)
    }
    req.once('close', () => {
      if (!req.complete && !res.writableEnded) {
        onClientAbort()
      }
    })
    res.once('close', () => {
      if (!res.writableEnded) {
        onClientAbort()
      }
    })

    const requestProtocol = detectRequestServiceApiProtocol(serializedReq)
    const requestedService = extractRequestedService(serializedReq)
    log(`Routing: protocol=${requestProtocol ?? 'null'} service=${requestedService ?? 'null'}`)
    const explicitProvider = getExplicitProviderOverride(serializedReq)
    const explicitPeerId = getExplicitPeerIdOverride(serializedReq, effectivePinnedPeer ?? undefined, bodyPinnedPeer)
    log(`Routing hints: provider=${explicitProvider ?? 'auto'} pin-peer=${explicitPeerId ?? 'none'}`)

    if (!explicitPeerId && !requestedService) {
      log('Request rejected: no peer pinned and no model requested')
      const errorMessage =
        'No model or peer was specified.\n'
        + 'Set the request model, or pin a peer one of three ways:\n'
        + '  • Per-request header:   x-antseed-pin-peer: <peerId>    (40-char hex EVM address)\n'
        + '  • Model name prefix:    <peerId>@<model>\n'
        + '  • Session pin:          antseed buyer connection set --peer <peerId>\n'
        + 'Discover peers with:       antseed network browse'
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
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
      return
    }

    // Discover peers
    const peers = await this._getPeers()
    if (peers.length === 0) {
      log('No sellers available')
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('No sellers available on the network. Is a seeder running?')
      return
    }

    if (!explicitPeerId && requestedService) {
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
      const policyRouter = router as BuyerPolicyRouter | null | undefined
      const routeCandidates = modelPeers
        .map((peer) => {
          const plan = modelPlans.get(peer.peerId)
            ?? resolvePeerRoutePlan(peer, requestProtocol, requestedService, explicitProvider, 'strict')
          if (!plan?.serviceId) return null
          const offer = findAdvertisedServiceOffer(peer, plan.provider, plan.serviceId)
          if (!offer) return null
          const missingRequired = plan.selection?.requiresTransform
            ? requiredParameters
            : findMissingRequiredParameters(
                peer,
                plan.provider,
                plan.serviceId,
                requiredParameters,
              )
          if (missingRequired.length > 0) {
            log(
              `Capability filter: peer ${peer.peerId.slice(0, 12)}... service="${plan.serviceId}" `
              + `missing required parameter(s): ${missingRequired.join(', ')}`,
            )
            return null
          }
          const requestForPolicy = withRoutedModel(serializedReq, plan.serviceId)
          if (!peerAllowedByPolicy(policyRouter, requestForPolicy, peer)) return null
          return {
            peer,
            peerId: peer.peerId,
            serviceId: plan.serviceId,
            request: requestForPolicy,
            reputation: normalizedModelReputationScore(peer) ?? -1,
            hasCachedInputPricing: offer.cachedInputUsdPerMillion !== undefined,
            inputUsdPerMillion: offer.inputUsdPerMillion ?? null,
            outputUsdPerMillion: offer.outputUsdPerMillion ?? null,
            minImageUsdPerImage: offer.minImageUsdPerImage ?? null,
          }
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
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
      if (routingPreferences) {
        candidates = rankModelRoutes(ranked, routingPreferences, now)
          .filter((candidate) => isModelRouteEligible(candidate, routingPreferences))
      } else {
        ranked.sort((a, b) =>
          (b.effectiveReputationScore ?? -1) - (a.effectiveReputationScore ?? -1)
          || a.peer.peerId.localeCompare(b.peer.peerId))
        const ready = ranked.filter((candidate) => !isCoolingDown(this._peerHealth.get(candidate.peer.peerId), now))
        candidates = ready.length > 0 ? ready : ranked
      }
      if (preferredConversationPeerId) {
        const preferredIndex = candidates.findIndex((candidate) => (
          candidate.peer.peerId.toLowerCase() === preferredConversationPeerId
          && !isCoolingDown(this._peerHealth.get(candidate.peer.peerId), now)
        ))
        if (preferredIndex > 0) {
          const [preferred] = candidates.splice(preferredIndex, 1)
          if (preferred) candidates.unshift(preferred)
        }
      }
      if (candidates.length === 0) {
        const capabilityRequired = requiredParameters.length > 0
        // The model exists on the network but only behind an API this
        // request does not speak (e.g. a decision model asked via chat).
        // Say so instead of claiming nobody serves it.
        const advertisedProtocols = capabilityRequired ? [] : findAdvertisedServiceProtocols(discoveredPeers, requestedService)
        if (advertisedProtocols.length > 0 && (!requestProtocol || !advertisedProtocols.includes(requestProtocol))) {
          const hint = advertisedProtocols.includes('typesafe-systemone')
            ? ` "${requestedService}" is a decision model; call POST /v1/systemone.`
            : ''
          log(`Request rejected: model ${requestedService} is served only via ${advertisedProtocols.join(', ')}`)
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            error: {
              type: 'unsupported_protocol',
              code: 'unsupported_protocol',
              message: `Model "${requestedService}" is served via ${advertisedProtocols.join(', ')}, not ${requestProtocol ?? 'this API'}.${hint}`,
              param: 'model',
              supported_protocols: advertisedProtocols,
            },
          }))
          return
        }
        res.writeHead(capabilityRequired ? 422 : 502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          error: capabilityRequired
            ? {
                type: 'required_capability_unavailable',
                code: 'required_capability_unavailable',
                message: `No policy-allowed seller for model "${requestedService}" advertises required parameter(s): ${requiredParameters.join(', ')}.`,
                param: REQUIRED_PARAMETERS_HEADER,
              }
            : {
                type: 'model_not_found',
                code: 'model_not_found',
                message: `No policy-allowed peer currently serves model "${requestedService}".`,
                param: 'model',
              },
        }))
        return
      }

      let lastRetry: Awaited<ReturnType<BuyerProxy['_dispatchToPeer']>> | null = null
      let lastVerificationError: string | null = null
      for (const [index, selected] of candidates.entries()) {
        if (this._verifier) {
          const makeReach = (chosenId: string): SellerReach =>
            makeVerifierReach(this._node, selected.peer, chosenId, clientAbortController.signal)
          const outcome = await this._verifyPeer(selected.peer, makeReach, clientAbortController.signal)
          if (!outcome.ok) {
            lastVerificationError = `Peer ${selected.peer.peerId.slice(0, 12)}... failed required verification (${outcome.reason ?? 'failed'}).`
            log(`${lastVerificationError} Trying the next model peer.`)
            continue
          }
        }

        for (let peerAttempt = 0; peerAttempt < MODEL_RATE_LIMIT_MAX_ATTEMPTS_PER_PEER; peerAttempt += 1) {
          log(
            `Auto-selected peer ${selected.peer.peerId.slice(0, 12)}... for model="${requestedService}" `
            + `service="${selected.serviceId}" reputation=${selected.reputation} `
            + `effective=${selected.effectiveReputationScore ?? 'unknown'} peer=${index + 1}/${candidates.length} `
            + `attempt=${peerAttempt + 1}/${MODEL_RATE_LIMIT_MAX_ATTEMPTS_PER_PEER}`,
          )
          const result = await this._dispatchToPeer(
            res,
            selected.request,
            selected.peer,
            modelPlans,
            requestProtocol,
            selected.serviceId,
            explicitProvider,
            router,
            RETRYABLE_STATUS_CODES,
            false,
            clientAbortController.signal,
          )
          if (result.done) {
            if (trackedConversationId) {
              this._conversations.recordRoutedModel(
                trackedConversationId,
                `${selected.peer.peerId}@${selected.serviceId}`,
              )
            }
            return
          }
          lastRetry = result
          if (result.responseHeaders[ANTSEED_FAULT_ATTRIBUTION_HEADER]?.toLowerCase() === 'buyer') {
            res.writeHead(result.statusCode, result.responseHeaders)
            res.end(result.responseBody)
            return
          }
          const retrySamePeer = result.statusCode === 429
            && peerAttempt + 1 < MODEL_RATE_LIMIT_MAX_ATTEMPTS_PER_PEER
          if (!retrySamePeer) break
          const delayMs = rateLimitRetryDelayMs(result.responseHeaders, peerAttempt)
          log(`Peer ${selected.peer.peerId.slice(0, 12)}... is rate-limited; retrying in ${delayMs}ms.`)
          if (!await waitForRetry(delayMs, clientAbortController.signal)) return
        }
        if (index + 1 < candidates.length) {
          log(`Peer ${selected.peer.peerId.slice(0, 12)}... failed retryably; trying next model peer.`)
        }
      }

      if (lastRetry) {
        res.writeHead(lastRetry.statusCode, lastRetry.responseHeaders)
        res.end(lastRetry.responseBody)
      } else {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            type: 'peer_verification_failed',
            code: 'peer_verification_failed',
            message: lastVerificationError ?? `No verified peer currently serves model "${requestedService}".`,
          },
        }))
      }
      return
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
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(
        `Pinned peer ${pinnedPeerId.slice(0, 12)}... is not reachable right now. `
        + 'It may be offline, not announcing, or temporarily unreachable. '
        + 'Pick a different service in Discover or try again later. '
        + diagnostics,
      )
      return
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
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end(
            `Pinned peer ${pinnedPeerId.slice(0, 12)}... does not offer provider=${explicitProvider}. `
            + `Available providers: ${providerList}. `
            + 'Remove or change the x-antseed-provider header, or pick a different peer. '
            + diagnostics,
          )
          return
        }
      }

      log(`Pinned peer ${pinnedPeerId.slice(0, 12)}... filtered out by protocol/service match`)
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(
        `Pinned peer ${pinnedPeerId.slice(0, 12)}... does not support this request `
        + `(${protocolLabel}, ${providerLabel}, ${serviceLabel}). `
        + `Pick a different service in Discover. ${diagnostics}`,
      )
      return
    }

    log(`Routing candidates: ${routingPeers.length} peer(s)`)

    const router = this._node.router

    const selectedPeer = routingPeers.find((p) => p.peerId.toLowerCase() === pinnedPeerId) ?? null

    // Defence in depth: the discovered+narrowed checks above should make this
    // branch unreachable. Keep a structured fallback so we don't silently hang
    // if an invariant breaks.
    if (!selectedPeer) {
      log(`Invariant: pinned peer ${pinnedPeerId.slice(0, 12)}... present in DHT but missing from narrowed candidate list`)
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`Pinned peer ${pinnedPeerId.slice(0, 12)}... is currently unreachable. Try again in a moment.`)
      return
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
      res.writeHead(422, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          type: 'required_capability_unavailable',
          code: 'required_capability_unavailable',
          message: `Pinned seller does not advertise required parameter(s) for model "${pinnedServiceId ?? requestedService ?? 'unknown'}": ${missingRequired.join(', ')}.`,
          param: REQUIRED_PARAMETERS_HEADER,
        },
      }))
      return
    }
    const pinnedRequest = pinnedServiceId ? withRoutedModel(serializedReq, pinnedServiceId) : serializedReq
    if (!peerAllowedByPolicy(policyRouter, pinnedRequest, selectedPeer)) {
      log(`Pinned peer ${selectedPeer.peerId.slice(0, 12)}... filtered out by buyer routing policy`)
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(
        `Pinned peer ${selectedPeer.peerId.slice(0, 12)}... is outside your buyer routing policy. `
        + 'Pick a different service in Discover or adjust your buyer pricing/reputation limits.',
      )
      return
    }

    if (this._verifier) {
      const makeReach = (chosenId: string): SellerReach =>
        makeVerifierReach(this._node, selectedPeer, chosenId, clientAbortController.signal)
      const outcome = await this._verifyPeer(selectedPeer, makeReach, clientAbortController.signal)
      const short = selectedPeer.peerId.slice(0, 12)
      if (outcome.verified) {
        log(`Verified ${short}... via ${outcome.sdk}`)
      } else if (outcome.sdk || outcome.reason) {
        log(`Verification ${outcome.sdk ? `(${outcome.sdk}) ` : ''}did not pass for ${short}...: ${outcome.reason ?? 'failed'}${outcome.ok ? ' (optional — routing anyway)' : ''}`)
      }
      if (!outcome.ok) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(
          `Pinned peer ${short}... failed required verification (${outcome.reason ?? 'failed'}). `
          + 'Pick a different peer, or run without --require-verifier.',
        )
        return
      }
    }

    log(`Using pinned peer ${selectedPeer.peerId.slice(0, 12)}...`)
    const result = await this._dispatchToPeer(
      res,
      pinnedRequest,
      selectedPeer,
      routingPlans,
      requestProtocol,
      requestedService,
      explicitProvider,
      router,
      RETRYABLE_STATUS_CODES,
      true,
      clientAbortController.signal,
    )
    if (result.done && trackedConversationId && pinnedServiceId) {
      this._conversations.recordRoutedModel(
        trackedConversationId,
        `${selectedPeer.peerId}@${pinnedServiceId}`,
      )
    }
    if (!result.done) {
      // Pinned peer returned a retryable error. We never retry against another
      // peer for an explicit pin, so surface the error to the client.
      res.writeHead(result.statusCode, result.responseHeaders)
      res.end(result.responseBody)
    }
  }

  private async _verifyPeer(
    peer: PeerInfo,
    makeReach: (chosenId: string) => SellerReach,
    signal: AbortSignal,
  ): Promise<VerifyOutcome> {
    const policy = this._verifier
    if (!policy) return { ok: true, verified: false }
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
  ): string | null {
    if (statusCode !== 413) return null
    const bodyText = Buffer.from(body).toString('utf-8').trim()
    if (!/upload body exceeds per-request limit/i.test(bodyText)) return null

    const maxBytes = this._parseMaxUploadBodyBytes(headers)
    const requestSize = this._formatBytes(requestBytes)
    const maxSize = maxBytes != null ? this._formatBytes(maxBytes) : 'the seller upload limit'
    const service = requestedService ? ` for ${requestedService}` : ''
    return `Request body${service} is ${requestSize}, but the selected seller allows ${maxSize} per request. `
      + 'This commonly happens when Codex sends a large repository context to /v1/responses. '
      + 'Reduce Codex context, exclude large/generated files, or pick a seller with a higher seller.maxUploadBodyBytes limit.'
  }

  private _withFriendlyUploadLimitError(
    response: SerializedHttpResponse,
    requestBytes: number,
    requestedService: string | null,
  ): SerializedHttpResponse {
    const message = this._formatUploadLimitError(
      response.statusCode,
      response.body,
      response.headers,
      requestBytes,
      requestedService,
    )
    if (!message) return response
    return {
      ...response,
      headers: { ...response.headers, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        error: {
          type: 'upload_body_too_large',
          code: 'upload_body_too_large',
          message,
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
    retryableStatusCodes: Set<number>,
    pinned: boolean,
    requestSignal: AbortSignal,
  ): Promise<
    | { done: true }
    | { done: false; statusCode: number; responseBody: Buffer; responseHeaders: Record<string, string>; errorMessage: string | null }
  > {
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
      [REQUIRED_PARAMETERS_HEADER]: _requiredParameters,
      'x-vpr-session-id': _vprSession,
      // Legacy desktop builds (pre AntStation → VPR rename) still send this.
      'x-antstation-session-id': _antstationSession,
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
    const wantsStreaming = clientWantsStreaming
    const peerResponseProtocol = selectedRoutePlan.selection?.targetProtocol ?? requestProtocol
    const adaptPeerResponse = (response: SerializedHttpResponse): SerializedHttpResponse =>
      adaptPeerFaultErrorResponse(response, peerResponseProtocol, { pinned })
    const startTime = Date.now()
    try {
      if (wantsStreaming) {
        let streamed = false
        const response = await this._node.sendRequestStream(selectedPeer, requestForPeer, {
          onResponseStart: (startResponse: SerializedHttpResponse, metadata: RequestStreamResponseMetadata) => {
            if (!metadata.streaming) return
            streamed = true
            const adaptedStartResponse = streamResponseAdapter
              ? streamResponseAdapter.adaptStart(startResponse)
              : startResponse
            const streamingHeaders = attachStreamingAntseedHeaders(
              adaptedStartResponse.headers,
              selectedPeer,
              requestForPeer.requestId,
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
        }, { signal: requestSignal, pinned })

        let responseForClient = adaptBuyerFaultErrorResponse(response, requestProtocol)
        responseForClient = adaptPeerResponse(responseForClient)
        if (
          !streamed
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

        const latencyMs = Date.now() - startTime
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
              && isRouterSuccess(responseForClient.statusCode, requestForPeer.path, retryableStatusCodes),
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
          // Headers already sent to client, can't retry
          if (!res.writableEnded) {
            res.end()
          }
          return { done: true }
        }

        // Non-streamed response — check if retryable
        const responseHeaders = attachAntseedTelemetryHeaders(
          responseForClient.headers,
          selectedPeer,
          telemetry,
          requestForPeer.requestId,
          latencyMs,
        )
        if (retryableStatusCodes.has(responseForClient.statusCode)) {
          return {
            done: false,
            statusCode: responseForClient.statusCode,
            responseBody: Buffer.from(responseForClient.body),
            responseHeaders,
            errorMessage: null,
          }
        }

        res.writeHead(responseForClient.statusCode, responseHeaders)
        res.end(Buffer.from(responseForClient.body))
        return { done: true }
      } else {
        const upstreamResponse = await this._node.sendRequest(selectedPeer, requestForPeer, {
          signal: requestSignal,
          pinned,
        })
        if (upstreamResponse.statusCode >= 400 && !adaptResponse) {
          log(`Upstream raw error detail: ${summarizeErrorResponse(upstreamResponse)}`)
        }

        let response = adaptBuyerFaultErrorResponse(upstreamResponse, requestProtocol)
        response = adaptPeerResponse(response)
        if (
          adaptResponse
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

        log(`Response: ${response.statusCode} (${latencyMs}ms, ${response.body.length} bytes)`)
        if (response.statusCode >= 400) {
          const prefix = adaptResponse ? 'Upstream adapted error detail' : 'Upstream error detail'
          log(`${prefix}: ${summarizeErrorResponse(response)}`)
        }

        const telemetry = computeResponseTelemetry(requestForPeer, response.headers, response.body, selectedPeer)
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
              && isRouterSuccess(response.statusCode, requestForPeer.path, retryableStatusCodes),
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
        if (retryableStatusCodes.has(response.statusCode)) {
          return { done: false, statusCode: response.statusCode, responseBody: Buffer.from(response.body), responseHeaders, errorMessage: null }
        }

        // Forward response headers and body to the HTTP client
        res.writeHead(response.statusCode, responseHeaders)
        res.end(Buffer.from(response.body))
        return { done: true }
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime
      const message = err instanceof Error ? err.message : String(err)
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
        return { done: true }
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
        return { done: true }
      }

      if (fault === 'buyer') {
        const buyerResponse = adaptBuyerFaultErrorResponse({
          requestId: requestForPeer.requestId,
          statusCode: 503,
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
      }
    }
  }
}
