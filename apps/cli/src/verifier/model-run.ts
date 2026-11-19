import { randomInt, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  KBF_AUDIT_VERIFY_OPTIONS,
  KBF_LOW_COVERAGE_RETRIES,
  KBF_PROMPT_VARIANT_IDS,
  KBF_OPTIONAL_SAMPLING_FIELDS,
  buildKbfChatRequestBody,
  isKbfThinkingSuppressionRejection,
  kbfTargetThinkingSuppression,
  type KbfThinkingSuppression,
  canonicalHashBytes32,
  isKbfSamplingFieldRejection,
  computeMatchVector,
  hasMissingKbfAnswers,
  parseKbfAnswers,
  queryProfileHash,
  isKbfTokenLimitFinishReason,
  kbfResponseFinishReason,
  reportedReasoningTokens,
  stripKbfThinkBlocks,
  verifyKbf,
  type FingerprintStats,
  type KbfProbe,
  type KbfReferenceV1,
  type KbfVerdictStats,
} from '@antseed/fingerprints'
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  trustScore,
  type PeerInfo,
  type StoredResponseAuth,
  type TokenPricingUsdPerMillion,
} from '@antseed/node'
import { parseRunningBuyerSettings, type RunningBuyerSettings } from './buyer-settings.js'
import { auditedServiceNames } from './audited-models.js'
import { ALL_TESTS_FORMAT, earliestAuditorTime, readingsOfEvidence, withoutOrphans, type ConfirmationIdentity, type StoredCheckRecords } from './audit-checks.js'
import { settleAuditVerdict } from './close-call.js'
import { flipsCost, flipsRequestCount, isFlipsRecord, isProbeDraw, summarizeFlips, type FlipsScreen, type FlipsSummary, type FlipsV1 } from './flips.js'
import { parsePersistedPeers } from '../proxy/buyer-proxy.js'
import { auditPriceRejection, type AuditPriceCap } from './audit-price.js'
import { kbfAuditBatches } from './kbf-batching.js'
import {
  addAuditCostSummaries,
  deriveProxyAuditId,
  parseProxyAuditExchangeCost,
  summarizeAuditExchangeCosts,
  writeProxyAuditEvidence,
  writeProxyAuditSkipEvidence,
  type AuditCostSummaryV1,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditEvidenceV1,
  type ProxyAuditSkipEvidenceV1,
  type SellerThinkingDiscoveryAttemptV1,
  type SellerThinkingDiscoveryV1,
  type VerificationSkipCode,
} from './proxy-evidence.js'
import {
  THINKING_DISCOVERY_PROBES,
  THINKING_DISCOVERY_TIMEOUT_MS,
  ThinkingDiscoveryError,
  discoverThinkingSuppression,
  thinkingStrategyRequest,
  type ThinkingDiscoveryProbe,
} from './thinking-suppression.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import {
  tokenizerPrecheckCost,
  tokenizerPrecheckRequestCount,
  summarizeTokenizerPrecheck,
  type TokenizerPrecheckScreen,
  type TokenizerPrecheckSummary,
  type TokenizerPrecheckSeller,
  type TokenizerPrecheckV1,
} from './tokenizer-precheck.js'
import type { AuditCheckId } from './flagging-checks.js'
import {
  outputEchoCost,
  outputEchoRequestCount,
  summarizeOutputEcho,
  type OutputEchoScreen,
  type OutputEchoSummary,
  type OutputEchoV1,
} from './output-echo.js'
import {
  outputCapCost,
  outputCapRequestCount,
  summarizeOutputCap,
  type OutputCapScreen,
  type OutputCapSummary,
  type OutputCapV1,
} from './output-cap.js'
import { advertisedServices, findAdvertisedService } from './service-discovery.js'
import { mapWithAdaptiveConcurrency, type AuditTaskLimiter } from './audit-concurrency.js'
import { writeJsonAtomic } from './atomic-files.js'
import {
  sanitizeOutcomeSummary,
  withBatchCounts,
  type VerificationOutcomeReasonV1,
} from './outcome-reason.js'
import { asError, sleep } from './utils.js'

const PROBE_REQUEST_ATTEMPTS = 5
const PROBE_RETRY_BASE_DELAY_MS = 1_000
const PROBE_RETRY_MAX_DELAY_MS = 30_000

class VerificationSkipSignal extends Error {
  constructor(
    readonly code: VerificationSkipCode,
    readonly reason: string,
    readonly outcomeReason: VerificationOutcomeReasonV1,
    readonly exchange: ProxyAuditEvidenceExchangeV1,
  ) {
    super(reason)
  }
}

class VerificationTerminalTransientSignal extends Error {
  constructor(readonly exchange: ProxyAuditEvidenceExchangeV1) {
    super(exchange.outcomeReason?.summary ?? exchange.failureReason ?? 'transient audit failure')
  }
}

function exportedResponseAuthRecord(record: StoredResponseAuth): Omit<StoredResponseAuth, 'requestPreimage' | 'responsePreimage'> {
  const { requestPreimage: _requestPreimage, responsePreimage: _responsePreimage, ...exported } = record
  return exported
}

/**
 * When a seller audit gives up: after `idleMs` of waiting on the seller without an answered batch, or
 * `maxMs` after its first request. A slow seller that keeps answering finishes its batches; a fixed
 * total cut off honest reasoning models whose 16 to 23 batches take 30 to 90 seconds each.
 *
 * The idle clock runs only while a batch request is out to the seller. Time the auditor spends on its
 * own work between batches (writing the checkpoint, waiting for a slot in the run's shared batch
 * limiter) is not the seller's silence and does not count against it.
 */
class LazyAuditDeadline {
  readonly controller = new AbortController()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private cause: 'idle' | 'max' | null = null
  private inFlight = 0
  private idleLeftMs: number
  private idleRunningSince = 0
  private maxStartedAt = 0

  constructor(readonly idleMs: number, readonly maxMs: number) {
    this.idleLeftMs = idleMs
  }

  /** A batch request goes out to the seller: the idle clock runs while any request is out. */
  start(): AbortSignal {
    if (this.controller.signal.aborted) return this.controller.signal
    if (!this.maxTimer) {
      this.maxStartedAt = Date.now()
      this.maxTimer = setTimeout(() => this.abort('max'), this.maxMs)
    }
    this.inFlight += 1
    if (this.inFlight === 1) this.runIdle(this.idleLeftMs)
    return this.controller.signal
  }

  /**
   * A batch request came back. An answered batch gives the seller another `idleMs` for the next one;
   * once no request is out the idle clock pauses until the next one goes out.
   */
  finish(answered: boolean): void {
    if (this.inFlight === 0 || this.controller.signal.aborted) return
    this.inFlight -= 1
    if (answered) this.idleLeftMs = this.idleMs
    else this.idleLeftMs = Math.max(0, this.idleLeftMs - (Date.now() - this.idleRunningSince))
    if (this.inFlight > 0) this.runIdle(this.idleLeftMs)
    else if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /**
   * A signal for optional work (the echo check's fixed amount alone): it fires with the audit's, or once only
   * `reserveMs` of the audit's total time is left, so that the questions keep it.
   */
  spare(reserveMs: number): AbortSignal {
    const left = this.maxTimer ? this.maxMs - (Date.now() - this.maxStartedAt) : this.maxMs
    return AbortSignal.any([this.controller.signal, AbortSignal.timeout(Math.max(0, left - reserveMs))])
  }

  /** Why the audit stopped, for its outcome reason. */
  describe(): string {
    return this.cause === 'max'
      ? `${AUDIT_MAX_TIME_TEXT} ${this.maxMs}ms`
      : `${AUDIT_IDLE_TEXT} ${this.idleMs}ms`
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
  }

  private runIdle(ms: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleRunningSince = Date.now()
    this.idleTimer = setTimeout(() => this.abort('idle'), ms)
  }

  private abort(cause: 'idle' | 'max'): void {
    if (this.controller.signal.aborted) return
    this.cause = cause
    this.close()
    this.controller.abort()
  }
}

/** Outcome text of an audit stopped because the seller answered nothing for the idle limit. */
export const AUDIT_IDLE_TEXT = 'seller sent no answer for'
/** Outcome text of an audit stopped at its total time limit (the auditor's limit, not the seller's fault). */
export const AUDIT_MAX_TIME_TEXT = 'seller audit reached its time limit of'
/** Default total time limit of one seller audit. */
export const DEFAULT_AUDIT_MAX_TIMEOUT_MS = 60 * 60_000

export interface BuyerProxySnapshot {
  baseUrl: string
  statePath: string
  pid: number
  peers: PeerInfo[]
  /** The limits the running buyer enforces; null when it did not record them (an older build). */
  settings?: RunningBuyerSettings | null
}

export interface ProxyVerificationContext {
  proxy: BuyerProxySnapshot
  evidenceDir: string
  checkpointRootDir?: string
  requestTimeoutMs: number
  /** How long a seller audit waits for its next answered batch before it gives up. */
  auditTimeoutMs: number
  /** The longest a seller audit may take in total; defaults to `DEFAULT_AUDIT_MAX_TIMEOUT_MS`. */
  auditMaxTimeoutMs?: number
  responseAuthReader: ResponseAuthReader
  batchConcurrency: number
  batchConcurrencyPromotionLatencyMs: number
  batchLimiter: AuditTaskLimiter
  fetchFn?: typeof fetch
  sleepFn?: (delayMs: number) => Promise<void>
  randomFn?: () => number
  writeCheckpoint?: (path: string, checkpoint: ModelAuditCheckpointV1) => Promise<void>
  /**
   * When set, each audit first discovers how to turn off the seller's hidden reasoning, as the KBF
   * reference code does for every endpoint it queries, and sends the batches that way (see
   * `SellerThinkingDiscoveryV1`). Shared by one run, keyed by seller and service, so a seller's
   * extra sets reuse its discovery. Without it, sellers get the reference's suppression.
   */
  sellerThinking?: Map<string, Promise<SellerThinkingDiscoveryV1>>
  /**
   * When set, each first audit starts with the tokenizer pre-check (`tokenizer-precheck.ts`): a seller whose
   * signed input tokens are not the model's in every round is DIFF and is asked no question. The audited model's
   * screen for this run (`createTokenizerPrecheckScreen`): its reference is awaited before the seller's clock
   * starts, and the seller's clock runs only while a pre-check request to it is out.
   */
  tokenizerPrecheck?: Pick<TokenizerPrecheckScreen<KbfReferenceV1>, 'ready' | 'check'>
  /**
   * When set, each first audit runs the cap check after thinking discovery (`output-cap.ts`): a seller whose
   * delivered answer measures more than twice the reply limit, twice, is DIFF and is asked no question.
   */
  outputCap?: Pick<OutputCapScreen<KbfReferenceV1>, 'ready' | 'check'>
  /**
   * When set, each first audit runs the echo check after the cap check (`output-echo.ts`): a seller that bills
   * output the model did not write, held against the model's other sellers, is DIFF and is asked no question.
   */
  outputEcho?: Pick<OutputEchoScreen<KbfReferenceV1>, 'ready' | 'check'>
  /** The randomness check of this model's sellers (`flips.ts`); absent when it does not run. */
  flips?: Pick<FlipsScreen<KbfReferenceV1>, 'check'> & Partial<Pick<FlipsScreen<KbfReferenceV1>, 'probing' | 'probeSettings' | 'warm'>>
}

/** What a seller's batch requests carry: its thinking suppression, token budget and timeout. */
interface SellerRequestSettings {
  queryProfile: KbfReferenceV1['queryProfile']
  thinking: KbfThinkingSuppression | null
  maxTokens: number
  requestTimeoutMs: number
}

/**
 * Shared by one seller audit: once the seller refuses the sampling fields or the
 * thinking suppression, later batches leave them out.
 */
interface AuditSamplingState {
  omit: boolean
  omitThinking?: boolean
}

export interface ModelVerificationResumeInput {
  parentAuditId: string
  reservationAuditId: string
  parentEvidenceHash: string
  exchanges: ProxyAuditEvidenceExchangeV1[]
  /** The test records an earlier attempt of this audit finished: they are carried, never asked again. */
  records?: StoredCheckRecords
}

/**
 * A running audit's state on disk, so an interrupted audit resumes without asking anything twice. Version 2 also
 * holds the finished test records; a version 1 checkpoint (written before every test ran in one audit) is not
 * resumed: its audit restarts clean.
 */
export interface ModelAuditCheckpointV1 {
  version: 2
  kind: 'antseed-verifier-audit-checkpoint'
  auditId: string
  parentAuditId: string | null
  reservationAuditId?: string
  /** Set on checkpoints of a close-call extension set, which a resume never repairs as a first check. */
  extension?: true
  /** The report a confirmation answers: a resume keeps to it. */
  confirming?: ConfirmationIdentity
  runId: string
  epoch: string
  model: string
  targetPeerId: string
  service: string
  referenceId: string
  queryProfileHash: string
  probeIds: string[]
  exchanges: ProxyAuditEvidenceExchangeV1[]
  /** The tests this audit finished so far. */
  records: StoredCheckRecords
  updatedAt: string
}

export interface ModelVerificationTargetResult {
  peerId: string
  displayName: string | null
  agentId: string | null
  service: string
  status: 'SAME' | 'DIFF' | 'UNDETERMINED'
  outcomeReason?: VerificationOutcomeReasonV1 | null
  /**
   * Unix seconds of the earliest request of this set on the auditor's own clock (`earliestAuditorTime`); null when none
   * has a time. The planner reads it for "fresh"; absent on summaries written before it, which are never fresh.
   */
  firstRequestAt?: number | null
  /**
   * The questions' own verdict, after any close call (`extension-round.ts`). `status` is the audit's verdict over
   * every test (`settleAuditVerdict`): DIFF when any test flagged, whatever the questions said.
   */
  questionsStatus?: 'SAME' | 'DIFF' | 'UNDETERMINED'
  /** The questions' own outcome reason; `outcomeReason` is the audit's (an undecided confirmation's, for one). */
  questionsOutcomeReason?: VerificationOutcomeReasonV1 | null
  /** The tests this audit repeats for another auditor's waiting DIFF (`confirming`); absent on a first look. */
  confirming?: AuditCheckId[]
  /** The chain time of the report it confirms: with `confirming`, which report this is. */
  confirmingReportedAt?: number
  /**
   * Set by the epoch submission on another report's own result it offers beside the seller's latest: submit sends it
   * only when the confirmation decision sends it for the report waiting now.
   */
  offeredAsAlternate?: true
  /** An undecided confirmation's cause when it was the auditor's own (`outcomeReason` says `confirmation_undecided`). */
  undecidedCause?: VerificationOutcomeReasonV1 | null
  /**
   * A close call whose extra set will not be asked: in the run, beside a flag of another test (a flagged result never
   * waits across runs); at submit, when its window closed or its extra questions were published. Its questions are
   * undecided, and the closure is published (`questionsClosed`).
   */
  closeCallClosed?: { reason: string }
  /**
   * This audit answered another auditor's DIFF on this service waiting for this auditor's
   * confirmation. An UNDETERMINED from a seller failure is then audited again before it is
   * submitted (see `CONFIRMATION_ATTEMPTS`). Local only; not part of the submitted evidence.
   */
  confirmsDiff?: boolean
  auditId: string
  parsedProbeCount: number
  probeCount: number
  correctProbeCount: number
  incorrectProbeCount: number
  correctRate: number | null
  requestCount: number
  cost: AuditCostSummaryV1
  cumulativeCost?: AuditCostSummaryV1
  evidencePath: string
  evidenceHash: string
  /**
   * Close-call rule this first audit is decided by (`kbf-extension-v2`: up to two extra sets;
   * `kbf-extension-v1`: one). Absent on audits from before close calls were extended (and with
   * `verifier.closeCallExtensions = 0`): those keep the single-look rule.
   */
  decisionRule?: 'kbf-extension-v1' | 'kbf-extension-v2'
  /** This set's own KBF statistics, as in its evidence file. */
  stats?: FingerprintStats
  /** False when a successful batch lacked verified ResponseAuth (the set's verdict is then UNDETERMINED). */
  responseAuthVerified?: boolean
  /**
   * The tokenizer pre-check this audit started with; absent when none ran. On a `mismatch` the status is DIFF
   * and no question was asked, so the audit has no close call to extend.
   */
  tokenizerPrecheck?: TokenizerPrecheckSummary
  /**
   * The cap check this audit ran before its questions; absent when none ran. On a `flag` the status is DIFF and
   * no question was asked, so the audit has no close call to extend.
   */
  outputCap?: OutputCapSummary
  /** The echo check this audit ran before its questions; absent when none ran. On a `flag` the status is DIFF. */
  outputEcho?: OutputEchoSummary
  /** The randomness check (FLIPS) this audit ran last before its verdict; absent when none ran. */
  flips?: FlipsSummary
  /**
   * Extra set of never-seen probes asked after a close-call first audit; `status` above is then the
   * verdict on both sets pooled.
   */
  extension?: ModelVerificationExtensionV1
  /**
   * Second extra set (`kbf-extension-v2`), asked when the first set pooled with `extension` was
   * still a close call; its `pooled` is the look over all three sets.
   */
  extension2?: ModelVerificationExtensionV1
  /**
   * Set on a close-call first audit whose extension could not run. Nothing is submitted for it; the
   * next `verifier run` in the same epoch extends it without repeating the first audit.
   */
  extensionPending?: { reason: string; since: string }
}

export interface ModelVerificationExtensionV1 {
  rule: 'kbf-extension-v1' | 'kbf-extension-v2'
  auditId: string
  /** The extra set's own earliest request (`earliestAuditorTime`, seconds); absent on sets pooled before it was kept. */
  firstRequestAt?: number | null
  /** The extension set's own single-set verdict (never used on its own). */
  status: 'SAME' | 'DIFF' | 'UNDETERMINED'
  referenceId: string
  probeCount: number
  parsedProbeCount: number
  correctProbeCount: number
  responseAuthVerified: boolean
  /** This extra set's own KBF statistics, as in its evidence file (absent on `kbf-extension-v1` records). */
  stats?: FingerprintStats
  cost: AuditCostSummaryV1
  evidencePath: string
  evidenceHash: string
  firstLook: { status: 'SAME' | 'DIFF' | 'UNDETERMINED'; pValue: number | null }
  /**
   * The look over the first set and every extra set up to this one. `extendNext` is true when that
   * look was still a close call and one more set decides (`verdict` is then UNDETERMINED).
   */
  pooled: KbfVerdictStats & { verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'; verdictReason: string | null; extendNext?: boolean }
}

export interface ModelVerificationFailure {
  peerId: string
  displayName?: string | null
  agentId: string | null
  service: string
  status: 'FAILED'
  reason: string
  outcomeReason?: VerificationOutcomeReasonV1
  /** A failed confirmation: the report it was for (`confirmationReportKey`), so the attempt counts for that report. */
  confirming?: AuditCheckId[]
  confirmingReportedAt?: number
}

export interface ModelVerificationSkip {
  peerId: string
  displayName: string | null
  agentId: string | null
  service: string
  status: 'SKIPPED'
  code: VerificationSkipCode
  reason: string
  outcomeReason?: VerificationOutcomeReasonV1
  source: 'preflight' | 'runtime'
  auditId: string | null
  evidencePath: string | null
  evidenceHash: string | null
  /** Set when a tokenizer pre-check ran before the seller was skipped: the requests it sent and what they cost. */
  requestCount?: number
  cost?: AuditCostSummaryV1
  /** A skipped confirmation: the report it was for, so the attempt counts for that report. */
  confirming?: AuditCheckId[]
  confirmingReportedAt?: number
}

export interface VerificationTargetPolicy {
  minReputation: number
  /**
   * The audited model's reference price cap. A seller priced above it is skipped
   * (`price_above_reference`) before any request is sent.
   */
  priceCap: AuditPriceCap
}

export async function loadBuyerProxySnapshot(dataDir: string): Promise<BuyerProxySnapshot> {
  const statePath = join(dataDir, 'buyer.state.json')
  let parsed: {
    state?: unknown
    pid?: unknown
    port?: unknown
    discoveredPeers?: unknown
    settings?: unknown
  }
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf8')) as typeof parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`buyer proxy state not found at ${statePath}; start antseed buyer first`)
    }
    throw new Error(`invalid buyer proxy state at ${statePath}: ${asError(error).message}`)
  }
  if (parsed.state !== 'connected') throw new Error('buyer proxy is not connected; start antseed buyer first')
  if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0 || !isProcessAlive(Number(parsed.pid))) {
    throw new Error('buyer proxy state is stale; start antseed buyer first')
  }
  if (!Number.isInteger(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535) {
    throw new Error('buyer proxy state has an invalid port')
  }
  const peers = parsePersistedPeers(parsed)
  if (peers.length === 0) throw new Error('buyer proxy has no live discovered peers')
  return {
    baseUrl: `http://127.0.0.1:${String(parsed.port)}`,
    statePath,
    pid: Number(parsed.pid),
    peers,
    settings: parseRunningBuyerSettings(parsed.settings),
  }
}

export function classifyVerificationTarget(
  peer: PeerInfo,
  normalizedModel: string,
  policy: VerificationTargetPolicy,
): { eligible: true; service: string }
  | { eligible: false; code: 'model_not_advertised'; service: null; reason: string }
  | {
    eligible: false
    code: 'missing_response_auth' | 'reputation_below_minimum' | 'price_above_reference' | 'policy_rejected'
    service: string
    reason: string
  } {
  const match = findAdvertisedService(peer, normalizedModel)
  if (!match) {
    return { eligible: false, code: 'model_not_advertised', service: null, reason: 'model not advertised' }
  }
  const service = match.advertised
  if (!peer.capabilities?.includes(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1)) {
    return {
      eligible: false,
      code: 'missing_response_auth',
      service,
      reason: `missing ${CONNECTION_CAPABILITY_RESPONSE_AUTH_V1}`,
    }
  }

  const reputation = trustScore(peer) ?? peer.reputationScore ?? 0
  if (reputation < policy.minReputation) {
    return {
      eligible: false,
      code: 'reputation_below_minimum',
      service,
      reason: `peer reputation ${reputation} is below buyer minimum ${policy.minReputation}`,
    }
  }

  const advertised = resolveAdvertisedOffer(peer, match.service)
  if (!advertised || advertised.kind === 'invalid') {
    return {
      eligible: false,
      code: 'policy_rejected',
      service,
      reason: advertised?.kind === 'invalid'
        ? `the advertised price for ${service} is invalid (${advertised.problem}), so the buyer refuses it · not audited`
        : `could not read a valid advertised price for ${service}`,
    }
  }
  const offer = advertised.offer

  const priceRejection = auditPriceRejection(offer, policy.priceCap)
  if (priceRejection) {
    return { eligible: false, code: 'price_above_reference', service, reason: priceRejection }
  }

  return { eligible: true, service }
}

export function classifyVerificationTargetServices(
  peer: PeerInfo,
  services: readonly string[],
  policy: VerificationTargetPolicy,
): ReturnType<typeof classifyVerificationTarget> {
  const names = services
    .map((service) => service.trim().toLowerCase())
    .filter((service, index, all) => service.length > 0 && all.indexOf(service) === index)
  // A listing under one of the model's exact names wins over another spelling of it, whatever the
  // order of the names: only if the peer lists none of them is a canonical spelling matched.
  const advertised = advertisedServices(peer)
  const exact = names.filter((name) => advertised.has(name))
  const candidates = (exact.length > 0 ? exact : names).map((service) => classifyVerificationTarget(peer, service, policy))
  return candidates.find((candidate) => candidate.eligible)
    ?? candidates.find((candidate) => !candidate.eligible && candidate.code !== 'model_not_advertised')
    ?? { eligible: false, code: 'model_not_advertised', service: null, reason: 'model not advertised' }
}

/**
 * The crowd of a model's tokenizer pre-check (`createTokenizerPrecheckScreen`): every peer the buyer sees that it
 * would audit for the model under the model's own service names, whether or not this run audits it. So a retry,
 * a confirmation, a `--peer` run, and a run in which most sellers are finished, held or judged by another auditor
 * still have the model's other sellers to hold a wrong reference against. A peer the buyer would refuse (priced
 * above the reference, under the reputation floor, without ResponseAuth) is left out: a request to it could
 * only fail. One entry per peer.
 */
export function tokenizerPrecheckSellers(
  peers: readonly PeerInfo[],
  services: readonly string[],
  policy: VerificationTargetPolicy,
): TokenizerPrecheckSeller[] {
  const sellers = new Map<string, TokenizerPrecheckSeller>()
  for (const peer of peers) {
    const key = peer.peerId.replace(/^0x/i, '').toLowerCase()
    if (sellers.has(key)) continue
    const eligibility = classifyVerificationTargetServices(peer, services, policy)
    if (eligibility.eligible) sellers.set(key, { peerId: peer.peerId, service: eligibility.service })
  }
  return [...sellers.values()]
}

/**
 * The seller's price for the model, as the buyer's router reads it: a provider's offer for the
 * service (or that provider's defaults) is final, so an invalid one is refused rather than replaced
 * by a cheaper or valid fallback, which would let the audit pick a seller the buyer never routes to.
 */
function resolveAdvertisedOffer(
  peer: PeerInfo,
  normalizedModel: string,
):
  | { kind: 'valid'; offer: TokenPricingUsdPerMillion }
  | { kind: 'invalid'; problem: string }
  | null {
  const providers = [
    ...peer.providers,
    ...(peer.metadata?.providers ?? []).map((entry) => entry.provider),
    ...Object.keys(peer.providerPricing ?? {}),
  ].filter((provider, index, all) => provider.trim().length > 0 && all.indexOf(provider) === index)

  for (const provider of providers) {
    const matrixEntry = Object.entries(peer.providerPricing ?? {})
      .find(([name]) => name.toLowerCase() === provider.toLowerCase())?.[1]
    const announcement = peer.metadata?.providers?.find(
      (entry) => entry.provider.toLowerCase() === provider.toLowerCase(),
    )
    const matrixService = Object.entries(matrixEntry?.services ?? {})
      .find(([service]) => service.trim().toLowerCase() === normalizedModel)?.[1]
    const announcedService = announcement?.services
      .some((service) => service.trim().toLowerCase() === normalizedModel) ?? false
    const announcementServicePrice = Object.entries(announcement?.servicePricing ?? {})
      .find(([service]) => service.trim().toLowerCase() === normalizedModel)?.[1]

    if (!matrixService && !announcedService && !announcementServicePrice) continue
    const offer = matrixService ?? announcementServicePrice ?? matrixEntry?.defaults ?? announcement?.defaultPricing
    if (isValidOffer(offer)) return { kind: 'valid', offer }
    if (offer) return { kind: 'invalid', problem: offerProblem(offer) }
  }

  if (
    isFiniteNonNegative(peer.defaultInputUsdPerMillion)
    && isFiniteNonNegative(peer.defaultOutputUsdPerMillion)
  ) {
    const offer: TokenPricingUsdPerMillion = {
      inputUsdPerMillion: peer.defaultInputUsdPerMillion,
      outputUsdPerMillion: peer.defaultOutputUsdPerMillion,
      ...(isFiniteNonNegative(peer.defaultCachedInputUsdPerMillion)
        ? { cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion }
        : {}),
    }
    return isValidOffer(offer) ? { kind: 'valid', offer } : { kind: 'invalid', problem: offerProblem(offer) }
  }

  return null
}

/** What makes an advertised offer invalid for the buyer's router, in a few words. */
function offerProblem(offer: TokenPricingUsdPerMillion): string {
  const cached = offer.cachedInputUsdPerMillion
  if (
    isFiniteNonNegative(offer.inputUsdPerMillion) && isFiniteNonNegative(offer.outputUsdPerMillion)
    && cached !== undefined && isFiniteNonNegative(cached) && cached > offer.inputUsdPerMillion
  ) {
    return `cached input $${cached} per 1M is above input $${offer.inputUsdPerMillion}`
  }
  return 'a price is missing, negative or not a number'
}

function isValidOffer(offer: TokenPricingUsdPerMillion | undefined): offer is TokenPricingUsdPerMillion {
  return !!offer
    && isFiniteNonNegative(offer.inputUsdPerMillion)
    && isFiniteNonNegative(offer.outputUsdPerMillion)
    && (offer.cachedInputUsdPerMillion === undefined || isFiniteNonNegative(offer.cachedInputUsdPerMillion))
    // The buyer's router refuses an offer whose cached input costs more than input, so it is not audited either.
    && (offer.cachedInputUsdPerMillion === undefined || offer.cachedInputUsdPerMillion <= offer.inputUsdPerMillion)
}

/** Every name the audited model currently goes by (empty for a model that is not audited). */
function currentServiceNames(model: string): string[] {
  return auditedServiceNames(model)
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export async function verifyModelTarget(input: {
  context: ProxyVerificationContext
  target: PeerInfo
  service: string
  reference: KbfReferenceV1
  auditId?: string
  resume?: ModelVerificationResumeInput
  checkpointIdentity?: {
    runId: string
    epoch: string
    model: string
  }
  extension?: boolean
  /**
   * Settled test records of an earlier attempt that this fresh audit carries without resuming its questions (a retry
   * after a close call's extra set, or after its question set was retired): they are not asked again.
   */
  carried?: StoredCheckRecords
  /**
   * The audit answers another auditor's waiting DIFF, flagged by these checks (`same-check.ts`): a flag by any
   * other check does not end it, so the checks that must confirm always run to their end.
   */
  confirming?: ConfirmationIdentity
}): Promise<ModelVerificationTargetResult | ModelVerificationSkip> {
  const confirmingIdentity = input.confirming
    ? { checks: [...input.confirming.checks], ...(input.confirming.reportedAt !== undefined ? { reportedAt: input.confirming.reportedAt } : {}) }
    : null
  const confirmingEvidence = confirmingIdentity ? { confirming: confirmingIdentity } : {}
  const batches = kbfAuditBatches(input.reference.probes)
  const deadline = new LazyAuditDeadline(
    input.context.auditTimeoutMs,
    Math.max(input.context.auditTimeoutMs, input.context.auditMaxTimeoutMs ?? DEFAULT_AUDIT_MAX_TIMEOUT_MS),
  )
  const auditId = input.auditId ?? canonicalHashBytes32({
    domain: 'antseed-verifier-provisional-audit-v1',
    peerId: input.target.peerId,
    referenceId: input.reference.referenceId,
    startedAt: Date.now(),
  })
  const exchangeByBatch = new Map<number, ProxyAuditEvidenceExchangeV1>()
  for (const exchange of input.resume?.exchanges ?? []) {
    const expectedProbeIds = batches[exchange.batchIndex]?.probes.map((probe) => probe.id)
    if (isReusableExchange(exchange) && expectedProbeIds && sameStrings(exchange.probeIds, expectedProbeIds)) {
      // Re-score with the current rule so a checkpoint written before unscoreable
      // answers were left out does not count them as wrong.
      exchangeByBatch.set(exchange.batchIndex, {
        ...exchange,
        matches: computeMatchVector(exchange.answers, batches[exchange.batchIndex]!.probes),
      })
    }
  }
  const reusedBatchIndexes = [...exchangeByBatch.keys()].sort((left, right) => left - right)
  const pending = batches.flatMap((batch, batchIndex) => exchangeByBatch.has(batchIndex)
    ? []
    : [{ probes: batch.probes, batchIndex }])
  const sampling: AuditSamplingState = {
    omit: input.resume?.exchanges.some((exchange) => exchange.omittedSamplingFields?.length) ?? false,
    omitThinking: input.resume?.exchanges.some((exchange) => exchange.omittedThinkingSuppression === true) ?? false,
  }
  const target = {
    peerId: input.target.peerId,
    displayName: input.target.displayName ?? null,
    agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
    service: input.service,
  }
  const evidenceHead = (createdAt: number) => ({
    version: 1 as const,
    kind: 'antseed-buyer-proxy-kbf-audit' as const,
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence' as const,
    createdAt: new Date(createdAt).toISOString(),
    buyerProxy: {
      baseUrl: input.context.proxy.baseUrl,
      statePath: basename(input.context.proxy.statePath),
      pid: input.context.proxy.pid,
    },
    target,
    reference: {
      referenceId: input.reference.referenceId,
      referenceModel: input.reference.referenceModel,
      queryProfileHash: queryProfileHash(input.reference.queryProfile),
      queryProfile: input.reference.queryProfile,
      statisticalPower: input.reference.statisticalPower,
      statisticalPowerEvidence: input.reference.statisticalPowerEvidence as unknown as Record<string, unknown>,
      selfTest: input.reference.selfTest,
      ...(input.reference.calibration ? { calibration: input.reference.calibration } : {}),
      probes: input.reference.probes,
    },
  })
  const resumeEvidence = input.resume ? {
    resume: {
      parentAuditId: input.resume.parentAuditId,
      reservationAuditId: input.resume.reservationAuditId,
      parentEvidenceHash: input.resume.parentEvidenceHash,
      reusedBatchIndexes,
    },
  } : {}
  // Every test of the audit runs, and none ends it (rule `all-tests-v1`, `audit-checks.ts` `verdictOf`): the
  // pre-check, thinking discovery, the questions, then the cap check and the echo check. The questions come before
  // the other output tests, so they keep their time and are not announced by requests a seller could recognise; a
  // test that runs out of time has no result, which blocks nothing. An extra set of a close call asks questions only.
  // Each test runs once in an audit's chain of attempts: a resume or a retry carries what an earlier attempt found
  // (`resume.records`) and does not ask it again.
  const runsTests = !input.extension
  // A carried test judged against an earlier test that is asked now is asked again with it (`withoutOrphans`).
  const carried: StoredCheckRecords = withoutOrphans(input.resume?.records ?? input.carried ?? {})
  const sellerTarget = {
    peerId: input.target.peerId,
    service: input.service,
    serviceAliases: [...input.reference.serviceAliases, ...currentServiceNames(input.reference.referenceModel)],
  }
  // The seller's clock runs only while one of its requests is out: references and crowds are the auditor's time.
  const clock = () => ({
    signal: deadline.controller.signal,
    start: () => deadline.start(),
    finish: (answered: boolean) => deadline.finish(answered),
  })
  if (runsTests) {
    await Promise.all([
      carried.outputCap == null ? input.context.outputCap?.ready(input.reference) : undefined,
      carried.outputEcho == null ? input.context.outputEcho?.ready(input.reference) : undefined,
    ])
  }
  let precheck: TokenizerPrecheckV1 | null = carried.tokenizerPrecheck ?? null
  const screen = input.context.tokenizerPrecheck
  if (runsTests && precheck === null && screen) {
    try {
      await screen.ready(input.reference)
      precheck = await screen.check(sellerTarget, input.reference, clock())
    } catch (error) {
      deadline.close()
      throw error
    }
  }
  let outputCap: OutputCapV1 | null = carried.outputCap ?? null
  let outputEcho: OutputEchoV1 | null = carried.outputEcho ?? null
  // FLIPS's stage, and its reference asked while the questions run: FLIPS then adds only the seller's own time.
  const flipsStage = input.confirming?.checks.includes('flips') ? 'confirm' as const : 'first' as const
  // A carried record is kept only for its own stage: a first look's FLIPS never stands for a confirmation of FLIPS, or
  // the other way round. A requested probe is always run: a carried record that is no probe's, or a probe of other
  // settings, is asked again and not kept.
  const flipsToAsk = runsTests && input.context.flips !== undefined
    && (carried.flips == null || carried.flips.draw.stage !== flipsStage
      || (input.context.flips.probing === true
        && (!isProbeDraw(carried.flips.draw) || carried.flips.probeSettings !== input.context.flips.probeSettings)))
  // Without a screen too: a carried record of another stage is not this audit's, so it is not kept.
  let flips: FlipsV1 | null = flipsToAsk || carried.flips?.draw.stage !== flipsStage ? null : carried.flips ?? null
  if (flipsToAsk) input.context.flips!.warm?.(input.service, input.reference, flipsStage)
  /** The tests this attempt ran itself: a carried record was paid for by the attempt that ran it. */
  const freshRecords = (): StoredCheckRecords => ({
    ...(precheck && precheck !== carried.tokenizerPrecheck ? { tokenizerPrecheck: precheck } : {}),
    ...(outputCap && outputCap !== carried.outputCap ? { outputCap } : {}),
    ...(outputEcho && outputEcho !== carried.outputEcho ? { outputEcho } : {}),
    ...(flips && flips !== carried.flips ? { flips } : {}),
  })
  /** The tests finished so far, as the checkpoint and the evidence store them. */
  const records = (): StoredCheckRecords => ({
    ...(precheck ? { tokenizerPrecheck: precheck } : {}),
    ...(outputCap ? { outputCap } : {}),
    ...(outputEcho ? { outputEcho } : {}),
    ...(flips ? { flips } : {}),
  })
  // Discovery runs whenever the seller is still to be asked something with its own thinking setting: a question batch,
  // or a test a retry asks again after every batch was answered.
  const testsToAsk = runsTests && ((input.context.outputCap !== undefined && carried.outputCap == null)
    || (input.context.outputEcho !== undefined && carried.outputEcho == null))
  const discovery = (pending.length > 0 || testsToAsk) && input.context.sellerThinking
    // The pre-check may have started the audit's clock: an audit that ends here stops it.
    ? await sellerThinkingFor(input.context, input.target, input.service, input.reference, sampling).catch((error: unknown) => {
      deadline.close()
      throw error
    })
    : null
  const settings = sellerRequestSettings(input.context, input.reference, discovery?.record ?? null)
  const sellerThinkingEvidence = discovery
    ? { sellerThinking: discovery.fresh ? discovery.record : { ...discovery.record, reused: true as const } }
    : {}
  const discoveryCost = discovery?.fresh ? summarizeDiscoveryCosts(discovery.record.attempts) : null
  let checkpointTail = Promise.resolve()
  let checkpointFailure: Error | null = null
  /** `bestEffort`: a write made only for a diagnostic (FLIPS) never stops the audit when it fails. */
  const persistCheckpoint = async (options: { bestEffort?: boolean } = {}): Promise<void> => {
    const snapshot = [...exchangeByBatch.values()].sort((left, right) => left.batchIndex - right.batchIndex)
    const checkpoint: ModelAuditCheckpointV1 = {
      version: 2,
      kind: 'antseed-verifier-audit-checkpoint',
      auditId,
      parentAuditId: input.resume?.parentAuditId ?? null,
      reservationAuditId: input.resume?.reservationAuditId ?? auditId,
      ...(input.extension ? { extension: true as const } : {}),
      ...(confirmingIdentity ? { confirming: confirmingIdentity } : {}),
      runId: input.checkpointIdentity?.runId ?? '',
      epoch: input.checkpointIdentity?.epoch ?? '',
      model: input.checkpointIdentity?.model ?? input.reference.referenceModel,
      targetPeerId: input.target.peerId,
      service: input.service,
      referenceId: input.reference.referenceId,
      queryProfileHash: queryProfileHash(input.reference.queryProfile),
      probeIds: input.reference.probes.map((probe) => probe.id),
      exchanges: snapshot,
      records: records(),
      updatedAt: new Date().toISOString(),
    }
    const path = join(input.context.checkpointRootDir ?? input.context.evidenceDir, '.checkpoints', `${auditId}.json`)
    checkpointTail = checkpointTail.then(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await (input.context.writeCheckpoint ?? writeJsonAtomic)(path, checkpoint)
          return
        } catch (error) {
          if (attempt === 1 && options.bestEffort) return
          if (attempt === 1) {
            checkpointFailure = new Error(`audit stopped: checkpoint could not be persisted at ${path}; resume from the last durable checkpoint`, { cause: error })
            deadline.controller.abort()
            throw checkpointFailure
          }
        }
      }
    })
    await checkpointTail
  }
  /** The seller was skipped while its questions were asked (it refused them, its key is gone, ...). */
  let skip: VerificationSkipSignal | null = null
  /** The questions ended in a seller failure (its first batch failed): no other test is started in this attempt. */
  let sellerFailed = false
  try {
    // A pre-check finished before the questions is kept, so an interrupted audit does not ask it again.
    if (precheck && !carried.tokenizerPrecheck) await persistCheckpoint()
    const executed = await mapWithAdaptiveConcurrency(
      pending,
      input.context.batchConcurrency,
      async ({ probes, batchIndex }, _pendingIndex, control) => input.context.batchLimiter.run(async () => {
        if (checkpointFailure) throw checkpointFailure
        let answered = false
        let exchange: ProxyAuditEvidenceExchangeV1
        try {
          exchange = await executeProxyProbeBatch(
          { ...input.context, signal: deadline.start(), describeDeadline: () => deadline.describe() },
          input.target,
          input.service,
          input.reference,
          probes,
          batchIndex,
          settings,
          control.reduceToOne,
          sampling,
          )
          answered = exchange.status === 'succeeded'
        } finally {
          deadline.finish(answered)
        }
        exchangeByBatch.set(batchIndex, exchange)
        await persistCheckpoint()
        if (batchIndex === 0 && exchange.status === 'failed' && exchange.outcomeReason?.retryable) {
          throw new VerificationTerminalTransientSignal(exchange)
        }
        return exchange
      }),
      (exchange) => exchange.status === 'succeeded'
        && exchange.responseAuth.status === 'verified'
        && exchange.timing.responseLatencyMs <= input.context.batchConcurrencyPromotionLatencyMs,
    )
    for (const exchange of executed) exchangeByBatch.set(exchange.batchIndex, exchange)
  } catch (error) {
    if (error instanceof VerificationTerminalTransientSignal) {
      sellerFailed = true
      exchangeByBatch.set(error.exchange.batchIndex, error.exchange)
      for (const { probes, batchIndex } of pending) {
        if (!exchangeByBatch.has(batchIndex)) {
          exchangeByBatch.set(batchIndex, notAttemptedExchange(
            input.context,
            input.target,
            input.service,
            probes,
            batchIndex,
            settings,
            error.exchange.outcomeReason!,
          ))
        }
      }
      await persistCheckpoint().catch((persistError: unknown) => {
        deadline.close()
        throw persistError
      })
    } else if (error instanceof VerificationSkipSignal) {
      skip = error
    } else {
      deadline.close()
      throw error
    }
  }
  const flaggedSoFar = (): boolean => readingsOfEvidence({ ...records(), exchanges: [] }, null).some((reading) => reading.outcome === 'flag')
  if (skip && !flaggedSoFar()) {
    // A skip with no flag is today's skip: the seller is not audited this run, and what ran before is paid for.
    deadline.close()
    return writeSkip(skip)
  }
  // The other output tests, after the questions, unless the seller was skipped (a flag stands through a skip: the
  // audit is a DIFF with its questions unfinished, and nothing more is asked of the seller), or the questions ended in
  // a seller failure or on the time limit: a test started then could only find nothing, and a retry asks it again.
  const timeIsUp = deadline.controller.signal.aborted
  if (runsTests && !skip && !sellerFailed && !timeIsUp) {
    try {
      const capScreen = input.context.outputCap
      // The time is checked before each test: one that starts after it ran out could only find nothing.
      const timeLeft = (): boolean => !deadline.controller.signal.aborted
      if (outputCap === null && capScreen && timeLeft()) {
        outputCap = await capScreen.check(sellerTarget, input.reference, settings.thinking, clock())
        if (outputCap) await persistCheckpoint()
      }
      const echoScreen = input.context.outputEcho
      if (outputEcho === null && echoScreen && timeLeft()) {
        outputEcho = await echoScreen.check(sellerTarget, input.reference, {
          thinking: settings.thinking,
          // The model's other sellers are asked with the reference's thinking setting.
          crowdThinking: kbfTargetThinkingSuppression(input.reference),
          precheckMatch: precheck?.outcome === 'match',
          clock: clock(),
          // Work for the fixed amount alone keeps to the audit's spare time.
          spare: () => deadline.spare(input.context.auditTimeoutMs),
        })
        if (outputEcho) await persistCheckpoint()
      }
      // FLIPS last: its stage is `confirm` only when this audit confirms another auditor's FLIPS flag.
      const flipsScreen = input.context.flips
      if (flipsToAsk && flipsScreen && timeLeft()) {
        const asked = await flipsScreen.check(sellerTarget, input.reference, {
          stage: flipsStage,
          clock: clock(),
          signal: deadline.controller.signal,
        })
        // Only a record every required write can hold: an unwritable diagnostic is dropped, never a failed audit.
        if (asked && isFlipsRecord(asked)) {
          flips = asked
          await persistCheckpoint({ bestEffort: true })
        }
      }
    } catch (error) {
      deadline.close()
      throw error
    }
  }
  deadline.close()

  /** The skip evidence, with what ran before the seller was skipped (hoisted: used above). */
  async function writeSkip(error: VerificationSkipSignal): Promise<ModelVerificationSkip> {
    const completedAt = Date.now()
    const ran = records()
    // Only what this attempt asked is its cost: a carried test was paid for by the attempt that ran it.
    const ranCosts = testCosts(freshRecords())
    const evidence: ProxyAuditSkipEvidenceV1 = {
      version: 1,
      kind: 'antseed-buyer-proxy-target-skip',
      evidenceLevel: 'proxy-observation-no-payment-evidence',
      createdAt: new Date(completedAt).toISOString(),
      buyerProxy: {
        baseUrl: input.context.proxy.baseUrl,
        statePath: basename(input.context.proxy.statePath),
        pid: input.context.proxy.pid,
      },
      target: {
        peerId: input.target.peerId,
        displayName: input.target.displayName ?? null,
        agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
        service: input.service,
      },
      reference: {
        referenceId: input.reference.referenceId,
        referenceModel: input.reference.referenceModel,
      },
      ...sellerThinkingEvidence,
      ...ran,
      exchange: error.exchange,
      result: {
        status: 'SKIPPED',
        code: error.code,
        reason: error.reason,
        outcomeReason: withBatchCounts(error.outcomeReason, 1, batches.length),
        // The tests that ran before the seller was skipped were paid for.
        ...(ranCosts.length > 0 ? { cost: addAuditCostSummaries(...ranCosts) } : {}),
      },
    }
    const evidenceHash = canonicalHashBytes32(evidence)
    const resolvedAuditId = input.auditId ?? deriveProxyAuditId({
      targetPeerId: input.target.peerId,
      referenceId: input.reference.referenceId,
      completedAt,
      evidenceHash,
    })
    const written = await writeProxyAuditSkipEvidence(input.context.evidenceDir, resolvedAuditId, evidence)
    return {
      peerId: input.target.peerId,
      displayName: input.target.displayName ?? null,
      agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
      service: input.service,
      status: 'SKIPPED',
      code: error.code,
      reason: error.reason,
      outcomeReason: withBatchCounts(error.outcomeReason, 1, batches.length),
      source: 'runtime',
      auditId: resolvedAuditId,
      evidencePath: written.path,
      evidenceHash: written.evidenceHash,
      ...(ranCosts.length > 0 ? { requestCount: testRequestCount(freshRecords()), cost: addAuditCostSummaries(...ranCosts) } : {}),
      ...(confirmingIdentity ? { confirming: [...confirmingIdentity.checks], ...(confirmingIdentity.reportedAt !== undefined ? { confirmingReportedAt: confirmingIdentity.reportedAt } : {}) } : {}),
    }
  }

  if (skip) exchangeByBatch.set(skip.exchange.batchIndex, skip.exchange)
  const exchanges = [...exchangeByBatch.values()].sort((left, right) => left.batchIndex - right.batchIndex)
  const answersByProbeId = new Map<string, number | null>()
  const matchesByProbeId = new Map<string, 0 | 1 | null>()
  for (const exchange of exchanges) {
    for (const [index, probeId] of exchange.probeIds.entries()) {
      answersByProbeId.set(probeId, exchange.answers[index] ?? null)
      matchesByProbeId.set(probeId, exchange.matches[index] ?? null)
    }
  }
  const answers = input.reference.probes.map((probe) => answersByProbeId.get(probe.id) ?? null)
  const matchVector = input.reference.probes.map((probe) => matchesByProbeId.get(probe.id) ?? null)
  const fragment = verifyKbf(input.reference, { answers, matchVector }, KBF_AUDIT_VERIFY_OPTIONS)
  if (fragment.verdict === 'UNKNOWN') throw new Error(fragment.verdictReason ?? 'verification returned UNKNOWN')

  const completedAt = Date.now()
  const authenticated = exchanges.every((exchange) => exchange.status !== 'succeeded'
    || exchange.responseAuth.status === 'verified')
  // The questions' own verdict, exactly as the questions decide alone; a skip leaves them unfinished.
  const questionsVerdict = skip ? 'UNDETERMINED' as const : authenticated ? fragment.verdict : 'UNDETERMINED' as const
  const questionsReason = skip
    ? `the questions were not finished: the seller was skipped (${skip.reason})`
    : authenticated ? fragment.verdictReason : 'one or more successful proxy batches lacked valid verified ResponseAuth'
  const questionsOutcome = skip
    ? withBatchCounts(skip.outcomeReason, 1, batches.length)
    : questionsVerdict === 'UNDETERMINED' ? summarizeUndeterminedReason(exchanges, batches.length) : null
  const ran = records()
  // Tests and discovery are paid for like batches, so the audit that sent them counts them; carried tests were paid
  // for by the attempt that ran them.
  const fresh = freshRecords()
  const extraCosts = [...testCosts(fresh), discoveryCost].filter((cost): cost is AuditCostSummaryV1 => cost !== null)
  const withExtras = (summary: AuditCostSummaryV1) => addAuditCostSummaries(summary, ...extraCosts)
  const cumulativeCost = withExtras(summarizeAuditExchangeCosts(exchanges))
  const newBatchIndexes = new Set(pending.map((entry) => entry.batchIndex))
  const cost = withExtras(summarizeAuditExchangeCosts(exchanges.filter((exchange) => newBatchIndexes.has(exchange.batchIndex))))
  const correctProbeCount = matchVector.filter((entry) => entry === 1).length
  const incorrectProbeCount = matchVector.filter((entry) => entry === 0).length
  const parsedProbeCount = correctProbeCount + incorrectProbeCount
  const evidence: ProxyAuditEvidenceV1 = {
    ...evidenceHead(completedAt),
    tests: ALL_TESTS_FORMAT,
    ...confirmingEvidence,
    ...sellerThinkingEvidence,
    ...ran,
    exchanges,
    ...resumeEvidence,
    // The questions' own result: the audit's verdict over every test is derived from it and the test records
    // (`verdictOf`), never stored in its place.
    result: {
      selectedProbeCount: input.reference.probes.length,
      parsedProbeCount,
      matchVector,
      matchVectorHash: fragment.matchVectorHash,
      stats: fragment.stats,
      verdict: questionsVerdict,
      verdictReason: questionsReason,
      outcomeReason: questionsOutcome,
      cost,
      cumulativeCost,
    },
  }
  const evidenceHash = canonicalHashBytes32(evidence)
  const resolvedAuditId = input.auditId ?? deriveProxyAuditId({
    targetPeerId: input.target.peerId,
    referenceId: input.reference.referenceId,
    completedAt,
    evidenceHash,
  })
  const written = await writeProxyAuditEvidence(input.context.evidenceDir, resolvedAuditId, evidence)
  return settleAuditVerdict({
    peerId: input.target.peerId,
    displayName: input.target.displayName ?? null,
    agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
    service: input.service,
    status: questionsVerdict,
    questionsStatus: questionsVerdict,
    outcomeReason: questionsOutcome,
    questionsOutcomeReason: questionsOutcome,
    ...(input.confirming ? { confirming: [...input.confirming.checks] } : {}),
    ...(input.confirming?.reportedAt !== undefined ? { confirmingReportedAt: input.confirming.reportedAt } : {}),
    auditId: resolvedAuditId,
    parsedProbeCount,
    probeCount: input.reference.probes.length,
    correctProbeCount,
    incorrectProbeCount,
    correctRate: parsedProbeCount === 0 ? null : correctProbeCount / parsedProbeCount,
    // The question batches, and the requests of the tests this attempt ran.
    requestCount: exchanges.length + testRequestCount(fresh),
    cost,
    cumulativeCost,
    evidencePath: written.path,
    evidenceHash: written.evidenceHash,
    firstRequestAt: earliestAuditorTime([evidence]),
    stats: fragment.stats,
    responseAuthVerified: authenticated,
    ...(precheck ? { tokenizerPrecheck: summarizeTokenizerPrecheck(precheck) } : {}),
    ...(outputCap ? { outputCap: summarizeOutputCap(outputCap) } : {}),
    ...(outputEcho ? { outputEcho: summarizeOutputEcho(outputEcho) } : {}),
    ...(flips ? { flips: summarizeFlips(flips) } : {}),
  })
}

/** What these test records' requests cost, in run order. */
function testCosts(records: StoredCheckRecords): AuditCostSummaryV1[] {
  return [
    ...(records.tokenizerPrecheck ? [tokenizerPrecheckCost(records.tokenizerPrecheck)] : []),
    ...(records.outputCap ? [outputCapCost(records.outputCap)] : []),
    ...(records.outputEcho ? [outputEchoCost(records.outputEcho)] : []),
    ...(records.flips ? [flipsCost(records.flips)] : []),
  ]
}

/** The requests these test records sent, counting tries. */
function testRequestCount(records: StoredCheckRecords): number {
  return (records.tokenizerPrecheck ? tokenizerPrecheckRequestCount(records.tokenizerPrecheck) : 0)
    + (records.outputCap ? outputCapRequestCount(records.outputCap) : 0)
    + (records.outputEcho ? outputEchoRequestCount(records.outputEcho) : 0)
    + (records.flips ? flipsRequestCount(records.flips) : 0)
}

export async function readModelAuditCheckpoints(
  evidenceDir: string,
): Promise<Array<{ path: string; checkpoint: ModelAuditCheckpointV1 }>> {
  const directory = join(evidenceDir, '.checkpoints')
  let filenames: string[]
  try {
    filenames = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const checkpointEntries = await Promise.all(filenames
    .filter((filename) => filename.endsWith('.json'))
    .map(async (filename) => {
      const path = join(directory, filename)
      const checkpoint = JSON.parse(await readFile(path, 'utf8')) as ModelAuditCheckpointV1 | { version: 1; kind: string }
      // A version 1 checkpoint was written before every test ran in one audit, and holds no test records: its
      // audit is not resumed, it restarts clean.
      if (checkpoint.version === 1 && checkpoint.kind === 'antseed-verifier-audit-checkpoint') return null
      if (checkpoint.version !== 2
        || checkpoint.kind !== 'antseed-verifier-audit-checkpoint'
        || typeof checkpoint.auditId !== 'string'
        || !Array.isArray(checkpoint.exchanges)
        || typeof checkpoint.records !== 'object' || checkpoint.records === null) {
        throw new Error(`invalid verifier audit checkpoint: ${path}`)
      }
      if (!checkpoint.runId || !checkpoint.epoch || !checkpoint.model) return null
      return { path, checkpoint }
    }))
  const checkpoints = checkpointEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  return checkpoints.sort((left, right) => left.checkpoint.updatedAt.localeCompare(right.checkpoint.updatedAt))
}

async function executeProxyProbeBatch(
  context: ProxyVerificationContext & { signal: AbortSignal; describeDeadline?: () => string },
  target: PeerInfo,
  service: string,
  reference: KbfReferenceV1,
  probes: KbfProbe[],
  batchIndex: number,
  settings: SellerRequestSettings,
  onRateLimited?: () => void,
  sampling: AuditSamplingState = { omit: false },
): Promise<ProxyAuditEvidenceExchangeV1> {
  const promptVariantId = pickKbfPromptVariantId()
  let samplingOmitted = sampling.omit
  let thinkingOmitted = sampling.omitThinking === true
  const thinking = settings.thinking
  let { url, headers, body, request } = buildProxyBatchRequest(
    context, target, service, probes, promptVariantId, settings, samplingOmitted, thinkingOmitted,
  )
  const samplingEvidence = () => ({
    ...(samplingOmitted ? { omittedSamplingFields: [...KBF_OPTIONAL_SAMPLING_FIELDS] } : {}),
    ...(thinking && thinkingOmitted ? { omittedThinkingSuppression: true as const } : {}),
  })
  const startedAt = Date.now()
  let attemptCount = 0
  let lastFailure = 'proxy request failed'
  let lastOutcomeReason: VerificationOutcomeReasonV1 = transportReason(lastFailure)
  let lastResponse: ProxyAuditEvidenceExchangeV1['response'] = null
  const requestIds: string[] = []
  let lastRequestId: string | null = null
  const attemptCosts = [] as NonNullable<ProxyAuditEvidenceExchangeV1['attemptCosts']>
  let responseAuthRetryCount = 0
  let lowCoverageRetryCount = 0
  let best: ProxyAuditEvidenceExchangeV1 | null = null
  const finalizeBest = (exchange: ProxyAuditEvidenceExchangeV1): ProxyAuditEvidenceExchangeV1 => {
    const completedAt = Date.now()
    return {
      ...exchange,
      attemptCount,
      requestIds: [...requestIds],
      attemptCosts: [...attemptCosts],
      timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
    }
  }
  const fetchFn = context.fetchFn ?? fetch
  const sleepFn = context.sleepFn ?? sleep
  const randomFn = context.randomFn ?? Math.random

  while (attemptCount < PROBE_REQUEST_ATTEMPTS && !context.signal.aborted) {
    attemptCount += 1
    const requestId = randomUUID()
    requestIds.push(requestId)
    lastRequestId = requestId
    const controller = new AbortController()
    const abortRequest = () => controller.abort()
    context.signal.addEventListener('abort', abortRequest, { once: true })
    const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs)
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { ...headers, 'x-antseed-request-id': requestId },
        body,
        signal: controller.signal,
      })
      const responseBody = new Uint8Array(await response.arrayBuffer())
      const responseHeaders = Object.fromEntries(response.headers.entries())
      const attemptCost = parseProxyAuditExchangeCost(responseHeaders)
      if (attemptCost) attemptCosts.push(attemptCost)
      lastResponse = {
        statusCode: response.status,
        headers: responseHeaders,
        bodyBase64: Buffer.from(responseBody).toString('base64'),
        hash: canonicalHashBytes32({
          statusCode: response.status,
          headers: responseHeaders,
          bodyBase64: Buffer.from(responseBody).toString('base64'),
        }),
      }
      if (!response.ok) {
        lastFailure = `buyer proxy HTTP ${response.status}: ${responseText(responseBody).slice(0, 500)}`
        if (thinking && !thinkingOmitted
          && isKbfThinkingSuppressionRejection(response.status, responseText(responseBody))) {
          sampling.omitThinking = true
          thinkingOmitted = true
          ;({ url, headers, body, request } = buildProxyBatchRequest(
            context, target, service, probes, promptVariantId, settings, samplingOmitted, true,
          ))
          continue
        }
        if (!samplingOmitted && isKbfSamplingFieldRejection(response.status, responseText(responseBody))) {
          sampling.omit = true
          samplingOmitted = true
          ;({ url, headers, body, request } = buildProxyBatchRequest(
            context, target, service, probes, promptVariantId, settings, true, thinkingOmitted,
          ))
          continue
        }
        const classified = classifyProxyFailure(response.status, responseBody)
        lastOutcomeReason = {
          ...classified.outcomeReason,
          upstreamStatus: response.status,
          ...(classified.outcomeReason.requestId ? {} : { requestId: safeRequestId(responseBody) ?? requestId }),
        }
        if (batchIndex === 0 && classified.skipCode && !best) {
          const completedAt = Date.now()
          throw new VerificationSkipSignal(classified.skipCode, lastOutcomeReason.summary, lastOutcomeReason, {
            batchIndex,
            attemptCount,
            requestIds,
            probeIds: probes.map((probe) => probe.id),
            promptVariantId,
            ...samplingEvidence(),
            request,
            response: lastResponse,
            timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
            answers: new Array<number | null>(probes.length).fill(null),
            matches: new Array<null>(probes.length).fill(null),
            status: 'failed',
            failureReason: lastFailure,
            cost: attemptCost,
            attemptCosts,
            outcomeReason: lastOutcomeReason,
            responseAuth: {
              requestId,
              status: 'missing',
              record: null,
              signedPreimages: null,
              failureReason: 'proxy batch was rejected before a successful authenticated response',
            },
          })
        }
        if (response.status === 429) onRateLimited?.()
        if (!classified.retryable) break
        if (attemptCount < PROBE_REQUEST_ATTEMPTS) {
          await sleepWithSignal(retryDelay(response, attemptCount, randomFn), context.signal, sleepFn)
          continue
        }
        break
      }
      const extracted = extractCompletionText(responseBody)
      // As the reference code does before parsing, `<think>…</think>` blocks are not answers.
      const completion = extracted === null ? null : stripKbfThinkBlocks(extracted)
      // A reply cut off at the token limit is not scored: the model was still writing (often
      // reasoning in the reply), so its numbers are not its answers. It is asked again below.
      const truncated = isKbfTokenLimitFinishReason(kbfResponseFinishReason(responseText(responseBody)))
      const answers = completion === null || truncated
        ? new Array<number | null>(probes.length).fill(null)
        : parseKbfAnswers(completion, probes.length)
      const malformedOutput = answers.every((answer) => answer === null)
      const matches = malformedOutput
        ? new Array<null>(probes.length).fill(null)
        : computeMatchVector(answers, probes)
      const completedAt = Date.now()
      const returnedRequestId = response.headers.get('x-antseed-request-id')
      const responseAuth = returnedRequestId === requestId
        ? await context.responseAuthReader.waitForVerified({
          requestId,
          sellerPeerId: target.peerId,
          advertisedService: service,
          // The bank's names plus the model's current ones: a seller may sign a name added later.
          serviceAliases: [...reference.serviceAliases, ...currentServiceNames(reference.referenceModel)],
          signal: context.signal,
        })
        : {
          requestId,
          status: returnedRequestId ? 'invalid' as const : 'missing' as const,
          responseAuth: null,
          signedPreimages: null,
          failureReason: returnedRequestId
            ? `buyer proxy request ID mismatch (${returnedRequestId} != ${requestId})`
            : 'successful buyer proxy response omitted x-antseed-request-id',
        }
      if (responseAuth.status !== 'verified' && responseAuthRetryCount < 1 && !context.signal.aborted) {
        responseAuthRetryCount += 1
        lastFailure = responseAuth.failureReason ?? 'successful response lacked verified ResponseAuth'
        lastOutcomeReason = responseAuthReason(responseAuth.status, lastFailure, requestId)
        await sleepWithSignal(PROBE_RETRY_BASE_DELAY_MS, context.signal, sleepFn)
        continue
      }
      const candidate: ProxyAuditEvidenceExchangeV1 = {
        batchIndex,
        attemptCount,
        requestIds: [...requestIds],
        probeIds: probes.map((probe) => probe.id),
        promptVariantId,
        ...samplingEvidence(),
        request,
        response: lastResponse,
        timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
        answers,
        matches,
        status: 'succeeded',
        failureReason: null,
        cost: attemptCost,
        attemptCosts: [...attemptCosts],
        outcomeReason: responseAuth.status === 'verified'
          ? truncated ? truncatedOutputReason(requestId) : malformedOutput ? malformedOutputReason(requestId) : null
          : responseAuthReason(responseAuth.status, responseAuth.failureReason, requestId),
        responseAuth: {
          requestId: responseAuth.requestId,
          status: responseAuth.status,
          record: responseAuth.responseAuth ? exportedResponseAuthRecord(responseAuth.responseAuth) : null,
          signedPreimages: responseAuth.signedPreimages ? {
            ...responseAuth.signedPreimages,
            hashAlgorithm: 'keccak256',
          } : null,
          failureReason: responseAuth.failureReason,
        },
      }
      if (!best || isBetterBatchAttempt(candidate, best)) best = candidate
      // A batch with any answer missing or unreadable is asked again (up to twice;
      // the KBF reference code only re-asks when more than half are missing) and
      // the attempt with the most scoreable answers is kept. Every request ID and
      // cost is recorded.
      if (responseAuth.status === 'verified'
        && lowCoverageRetryCount < KBF_LOW_COVERAGE_RETRIES
        && attemptCount < PROBE_REQUEST_ATTEMPTS
        && hasMissingKbfAnswers(best.matches)) {
        lowCoverageRetryCount += 1
        await sleepWithSignal(PROBE_RETRY_BASE_DELAY_MS, context.signal, sleepFn)
        continue
      }
      return finalizeBest(best)
    } catch (error) {
      if (error instanceof VerificationSkipSignal) throw error
      lastFailure = context.signal.aborted
        ? deadlineText(context)
        : controller.signal.aborted
          ? `buyer proxy request timed out after ${settings.requestTimeoutMs}ms`
        : asError(error).message
      lastOutcomeReason = context.signal.aborted
        ? deadlineReason(deadlineText(context))
        : controller.signal.aborted
          ? requestTimeoutReason(settings.requestTimeoutMs)
          : lastOutcomeReason.summary === 'proxy request failed'
            ? transportReason(lastFailure)
            : lastOutcomeReason
      if (!context.signal.aborted && attemptCount < PROBE_REQUEST_ATTEMPTS) {
        const delay = boundedBackoff(attemptCount, randomFn)
        await sleepWithSignal(delay, context.signal, sleepFn)
      }
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', abortRequest)
    }
  }
  if (best) return finalizeBest(best)
  if (context.signal.aborted) {
    lastFailure = deadlineText(context)
    lastOutcomeReason = deadlineReason(lastFailure)
  }
  const completedAt = Date.now()
  return {
    batchIndex,
    attemptCount,
    requestIds,
    probeIds: probes.map((probe) => probe.id),
    promptVariantId,
    ...samplingEvidence(),
    request,
    response: lastResponse,
    timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
    answers: new Array<number | null>(probes.length).fill(null),
    matches: new Array<null>(probes.length).fill(null),
    status: 'failed',
    failureReason: lastFailure,
    cost: attemptCosts.at(-1) ?? null,
    attemptCosts,
    outcomeReason: lastOutcomeReason,
    responseAuth: {
      requestId: lastRequestId,
      status: 'missing',
      record: null,
      signedPreimages: null,
      failureReason: 'proxy batch did not complete successfully',
    },
  }
}

/**
 * The seller's thinking suppression for this audit: discovered once per run for each seller and
 * service (`fresh` for the audit that sent the discovery requests), then shared by its other audits.
 */
async function sellerThinkingFor(
  context: ProxyVerificationContext,
  target: PeerInfo,
  service: string,
  reference: KbfReferenceV1,
  sampling: AuditSamplingState,
): Promise<{ record: SellerThinkingDiscoveryV1; fresh: boolean }> {
  const cache = context.sellerThinking!
  const key = `${target.peerId.replace(/^0x/i, '').toLowerCase()}\u0000${service}`
  const cached = cache.get(key)
  if (cached) return { record: await cached, fresh: false }
  const discovered = discoverSellerThinking(context, target, service, reference, sampling)
  cache.set(key, discovered)
  const record = await discovered
  // A failed discovery (the seller was down for a moment) is not reused: the next audit of the
  // seller discovers again instead of sending its batches without suppression.
  if (record.strategy === null && cache.get(key) === discovered) cache.delete(key)
  return { record, fresh: true }
}

/** Waits between the tries of one discovery strategy after a 429, 5xx or network error. */
const DISCOVERY_RETRY_DELAYS_MS = [5_000, 15_000] as const
/**
 * Strategies in a row that must fail every try with no answer before the seller counts as down and
 * the remaining strategies are not sent. One failed strategy is not enough: a single 502 from a
 * seller that answers its first batch seconds later would drop its discovery.
 */
const DISCOVERY_OUTAGE_STRATEGIES = 2

/**
 * `discover_thinking_strategy` from the KBF reference code, run on the seller as the reference code
 * runs it on every endpoint it queries: each strategy is sent the fixed ten-question batch, and the
 * first giving at least 5 answers with zero reasoning tokens is kept (`bare` may think); else `bare`
 * with 50x the token budget. When none works (the seller is down, or refuses every request), the
 * audit sends the reference's suppression as before and its batches record what went wrong. Never
 * rejects.
 */
async function discoverSellerThinking(
  context: ProxyVerificationContext,
  target: PeerInfo,
  service: string,
  reference: KbfReferenceV1,
  sampling: AuditSamplingState,
): Promise<SellerThinkingDiscoveryV1> {
  const fetchFn = context.fetchFn ?? fetch
  const sleepFn = context.sleepFn ?? sleep
  const randomFn = context.randomFn ?? Math.random
  const url = `${context.proxy.baseUrl}/v1/chat/completions`
  const overall = new AbortController()
  const overallTimer = setTimeout(() => overall.abort(), context.auditTimeoutMs)
  const sent: Array<Pick<SellerThinkingDiscoveryAttemptV1, 'requestIds' | 'attemptCosts'>> = []
  // A seller that failed every try of DISCOVERY_OUTAGE_STRATEGIES strategies in a row with no answer
  // (transport error or 5xx) is down, not refusing a field: the remaining strategies are not sent,
  // and the batches record the outage.
  let unreachable: { status: number | null; failure: string } | null = null
  let outages = 0
  const probe: ThinkingDiscoveryProbe = async ({ request, maxTokens }) => {
    const record = { requestIds: [] as string[], attemptCosts: [] as SellerThinkingDiscoveryAttemptV1['attemptCosts'] }
    sent.push(record)
    if (unreachable) return { ok: false, ...unreachable, failure: `not sent, seller unreachable: ${unreachable.failure}` }
    let failure: { status: number | null; failure: string } = { status: null, failure: 'not attempted' }
    // As in the reference code: 429, 5xx and network errors are tried up to three times, and any
    // other 4xx means the seller refuses this strategy.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (overall.signal.aborted) {
        return { ok: false, status: null, failure: `thinking discovery exceeded ${context.auditTimeoutMs}ms` }
      }
      const requestId = randomUUID()
      record.requestIds.push(requestId)
      const chat = buildKbfChatRequestBody(service, THINKING_DISCOVERY_PROBES, { maxTokens })
      const payload: Record<string, unknown> = {
        ...chat,
        ...(request.assistantPrefill
          ? { messages: [...chat.messages, { role: 'assistant', content: request.assistantPrefill }] }
          : {}),
        ...request.overrides,
        temperature: 0,
        stream: false,
      }
      if (sampling.omit) for (const field of KBF_OPTIONAL_SAMPLING_FIELDS) delete payload[field]
      const controller = new AbortController()
      const abort = () => controller.abort()
      overall.signal.addEventListener('abort', abort, { once: true })
      // A seller that is not suppressed yet is still thinking, so this is the slowest request sent.
      const timer = setTimeout(abort, THINKING_DISCOVERY_TIMEOUT_MS)
      try {
        const { response, responseBody } = await context.batchLimiter.run(async () => {
          const response = await fetchFn(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-antseed-pin-peer': target.peerId,
              'x-antseed-request-id': requestId,
            },
            body: new TextEncoder().encode(JSON.stringify(payload)),
            signal: controller.signal,
          })
          return { response, responseBody: new Uint8Array(await response.arrayBuffer()) }
        })
        const cost = parseProxyAuditExchangeCost(Object.fromEntries(response.headers.entries()))
        if (cost) record.attemptCosts.push(cost)
        if (response.ok) {
          outages = 0
          return {
            ok: true,
            content: extractCompletionText(responseBody),
            reasoningTokens: reportedReasoningTokens(responseText(responseBody)),
            truncated: isKbfTokenLimitFinishReason(kbfResponseFinishReason(responseText(responseBody))),
          }
        }
        const text = responseText(responseBody)
        failure = { status: response.status, failure: sanitizeOutcomeSummary(text.slice(0, 300)) }
        if (!sampling.omit && isKbfSamplingFieldRejection(response.status, text)) {
          sampling.omit = true
          continue
        }
        if (response.status !== 429 && response.status < 500) {
          outages = 0
          return { ok: false, ...failure }
        }
      } catch (error) {
        failure = {
          status: null,
          failure: controller.signal.aborted && !overall.signal.aborted
            ? `request timed out after ${THINKING_DISCOVERY_TIMEOUT_MS}ms`
            : asError(error).message,
        }
      } finally {
        clearTimeout(timer)
        overall.signal.removeEventListener('abort', abort)
      }
      if (attempt < 3) {
        const delay = DISCOVERY_RETRY_DELAYS_MS[attempt - 1]!
        await sleepWithSignal(Math.round(delay * (0.75 + randomFn() * 0.5)), overall.signal, sleepFn)
      }
    }
    if (failure.status === null || failure.status >= 500 || failure.status === 429) {
      outages += 1
      if (outages >= DISCOVERY_OUTAGE_STRATEGIES) unreachable = failure
    }
    return { ok: false, ...failure }
  }
  const withRequests = (attempts: ThinkingDiscoveryError['attempts']): SellerThinkingDiscoveryAttemptV1[] => attempts.map((attempt, index) => ({
    ...attempt,
    requestIds: sent[index]?.requestIds ?? [],
    attemptCosts: sent[index]?.attemptCosts ?? [],
  }))
  const budget = reference.queryProfile.maxTokensPerRequest
  try {
    const result = await discoverThinkingSuppression({
      model: service,
      label: `seller ${target.peerId}`,
      // Audits always send OpenAI Chat Completions to the buyer proxy.
      supportsPrefill: true,
      probe,
    })
    return {
      method: 'kbf-reference-code-2026-09-30',
      strategy: result.strategy,
      maxTokens: Math.max(budget, result.maxTokens ?? 0),
      attempts: withRequests(result.attempts),
    }
  } catch (error) {
    return {
      method: 'kbf-reference-code-2026-09-30',
      strategy: null,
      maxTokens: budget,
      attempts: withRequests(error instanceof ThinkingDiscoveryError ? error.attempts : []),
      failure: sanitizeOutcomeSummary(asError(error).message),
    }
  } finally {
    clearTimeout(overallTimer)
  }
}

/** Request settings for a seller's batches: its discovered suppression, or the reference's. */
function sellerRequestSettings(
  context: ProxyVerificationContext,
  reference: KbfReferenceV1,
  discovery: SellerThinkingDiscoveryV1 | null,
): SellerRequestSettings {
  const base = {
    queryProfile: reference.queryProfile,
    maxTokens: reference.queryProfile.maxTokensPerRequest,
    requestTimeoutMs: context.requestTimeoutMs,
  }
  if (!discovery || discovery.strategy === null) return { ...base, thinking: kbfTargetThinkingSuppression(reference) }
  const request = thinkingStrategyRequest(discovery.strategy)
  const thinking = Object.keys(request.overrides).length === 0 && !request.assistantPrefill
    ? null
    : {
      strategy: discovery.strategy,
      overrides: request.overrides,
      ...(request.assistantPrefill ? { assistantPrefill: request.assistantPrefill } : {}),
    }
  return {
    ...base,
    thinking,
    maxTokens: discovery.maxTokens,
    // A seller that thinks on every request gets as long per request as discovery gave it.
    requestTimeoutMs: discovery.strategy === 'bare-expanded'
      ? Math.max(context.requestTimeoutMs, THINKING_DISCOVERY_TIMEOUT_MS)
      : context.requestTimeoutMs,
  }
}

function summarizeDiscoveryCosts(attempts: SellerThinkingDiscoveryAttemptV1[]): AuditCostSummaryV1 {
  const priced = attempts.flatMap((attempt) => attempt.attemptCosts)
  const answered = attempts.filter((attempt) => attempt.requestIds.length > 0)
  return {
    inputTokens: priced.reduce((total, cost) => total + cost.inputTokens, 0),
    outputTokens: priced.reduce((total, cost) => total + cost.outputTokens, 0),
    totalTokens: priced.reduce((total, cost) => total + cost.totalTokens, 0),
    estimatedCostUsd: priced.reduce((total, cost) => total + cost.estimatedCostUsd, 0),
    pricedExchangeCount: answered.filter((attempt) => attempt.attemptCosts.length > 0).length,
    missingCostExchangeCount: answered.filter((attempt) => attempt.attemptCosts.length === 0).length,
  }
}

function classifyProxyFailure(
  statusCode: number,
  body: Uint8Array,
): {
  retryable: boolean
  skipCode: VerificationSkipCode | null
  outcomeReason: VerificationOutcomeReasonV1
} {
  const text = responseText(body)
  let code = ''
  let message = text
  let requestId: string | undefined
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const error = parsed.error
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>
      code = typeof record.code === 'string' ? record.code : ''
      message = typeof record.message === 'string' ? record.message : text
      requestId = typeof record.request_id === 'string' ? record.request_id : undefined
    } else if (typeof error === 'string') {
      message = error
    }
    if (!code && typeof parsed.code === 'string') code = parsed.code
    if (typeof parsed.message === 'string') message = parsed.message
    if (!requestId && typeof parsed.request_id === 'string') requestId = parsed.request_id
  } catch {
    // Plain-text proxy errors are supported for compatibility with older buyers.
  }

  const normalizedMessage = message.toLowerCase()
  const base = { affectedBatchCount: 1, totalBatchCount: 1, ...(code ? { providerCode: code } : {}), ...(requestId ? { requestId } : {}) }

  if (statusCode === 429 || normalizedMessage.includes('max concurrency') || normalizedMessage.includes('throttl')) {
    return {
      retryable: true,
      skipCode: null,
      outcomeReason: {
        ...base,
        code: 'rate_limited',
        summary: sanitizeOutcomeSummary(message),
        retryable: true,
        source: 'transport',
        nextAction: 'retry later',
      },
    }
  }
  if (normalizedMessage.includes('temporarily unavailable') || normalizedMessage.includes('temporary unavailable')) {
    return {
      retryable: true,
      skipCode: null,
      outcomeReason: {
        ...base,
        code: 'temporarily_unavailable',
        summary: sanitizeOutcomeSummary(message),
        retryable: true,
        source: 'provider',
        nextAction: 'retry later',
      },
    }
  }
  if (normalizedMessage.includes('lock confirmation timed out')) {
    return {
      retryable: true,
      skipCode: null,
      outcomeReason: {
        ...base,
        code: 'payment_lock_timeout',
        summary: sanitizeOutcomeSummary(message),
        retryable: true,
        source: 'payment',
        nextAction: 'restart or repair payment channel',
      },
    }
  }
  if (code === 'GROUP_DELETED' || normalizedMessage.includes('api key') && normalizedMessage.includes('deleted')) {
    return {
      retryable: false,
      skipCode: 'upstream_credentials_invalid',
      outcomeReason: {
        ...base,
        code: 'upstream_credentials_invalid',
        summary: sanitizeOutcomeSummary(message),
        retryable: false,
        source: 'provider',
        nextAction: 'seller must repair credentials',
      },
    }
  }
  const adapterProfileMismatch = (statusCode === 400 || statusCode === 422)
    && /^unsupported chat feature for claude messages:\s*(n|reasoning)\s*$/.test(normalizedMessage.trim())
  if (adapterProfileMismatch || normalizedMessage.includes('invalid temperature')
    || normalizedMessage.includes('invalid request parameter')
    || normalizedMessage.includes('only 0.6 is allowed')) {
    return {
      retryable: false,
      skipCode: 'request_profile_incompatible',
      outcomeReason: {
        ...base,
        code: 'request_profile_incompatible',
        summary: sanitizeOutcomeSummary(message),
        retryable: false,
        source: 'request_profile',
        nextAction: adapterProfileMismatch ? 'inspect verifier evidence' : 'seller must support canonical request profile',
      },
    }
  }

  if ((statusCode === 400 || statusCode === 404)
    && (code === 'model_not_found' || message.includes('is not served by this peer')
      // The seller's upstream no longer knows the model it advertises (e.g. "Unknown model: claude-sonnet-5.5").
      || /\b(unknown|invalid|unsupported) model\b|\bmodel\b[^.]{0,40}\b(does not exist|not found)\b/i.test(message))) {
    return {
      retryable: false,
      skipCode: 'stale_model_advertisement',
      outcomeReason: {
        ...base,
        code: 'stale_model_advertisement',
        summary: `peer advertised ${extractQuotedService(message) ?? 'the requested model'} but rejected it as unavailable`,
        retryable: false,
        source: 'provider',
        nextAction: 'seller must support canonical request profile',
      },
    }
  }
  return {
    retryable: isRetryableStatus(statusCode),
    skipCode: null,
    outcomeReason: {
      ...base,
      code: 'transport_error',
      summary: sanitizeOutcomeSummary(message),
      retryable: isRetryableStatus(statusCode),
      source: 'transport',
      nextAction: isRetryableStatus(statusCode) ? 'retry later' : 'inspect verifier evidence',
    },
  }
}

function extractQuotedService(message: string): string | null {
  return message.match(/Service\s+"([^"]+)"\s+is not served by this peer/i)?.[1] ?? null
}

/**
 * Each audit batch uses a crypto-random prompt variant so audit traffic has
 * no constant system prompt or header a seller could fingerprint. The id is
 * recorded on the exchange so third parties can re-parse the response.
 */
function pickKbfPromptVariantId(): string {
  return KBF_PROMPT_VARIANT_IDS[randomInt(KBF_PROMPT_VARIANT_IDS.length)]!
}

/** Exact buyer-proxy request body for one KBF probe batch; auditors and verifiers rebuild it identically. */
export function buildKbfProbeRequestBody(
  service: string,
  queryProfile: KbfReferenceV1['queryProfile'],
  probes: readonly KbfProbe[],
  promptVariantId: string,
  omitSampling = false,
  thinking: KbfThinkingSuppression | null = null,
  maxTokens = queryProfile.maxTokensPerRequest,
): Uint8Array {
  // Audits send the canonical KBF body plus the seller's own thinking suppression
  // (or the reference's), and a larger budget for a seller that thinks anyway, as
  // the KBF reference code does for every endpoint. Other reference-endpoint
  // settings (omitted fields, provider pins) never reach sellers.
  const chat = buildKbfChatRequestBody(service, probes, {
    maxTokens,
    variantId: promptVariantId,
  })
  const requestBody: Record<string, unknown> = {
    ...chat,
    ...(thinking?.assistantPrefill
      ? { messages: [...chat.messages, { role: 'assistant', content: thinking.assistantPrefill }] }
      : {}),
    ...thinking?.overrides,
    // No top_p: the KBF reference code sends only model, messages, temperature and
    // max_tokens, and several upstreams reject top_p (Kimi K3, Opus 5, Opus 4.6).
    temperature: queryProfile.auditTemperature,
    stream: false,
  }
  if (omitSampling) for (const field of KBF_OPTIONAL_SAMPLING_FIELDS) delete requestBody[field]
  return new TextEncoder().encode(JSON.stringify(requestBody))
}

function buildProxyBatchRequest(
  context: ProxyVerificationContext,
  target: PeerInfo,
  service: string,
  probes: KbfProbe[],
  promptVariantId: string,
  settings: SellerRequestSettings,
  omitSampling: boolean,
  omitThinking = false,
): {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  request: ProxyAuditEvidenceExchangeV1['request']
} {
  const url = `${context.proxy.baseUrl}/v1/chat/completions`
  const headers = {
    'content-type': 'application/json',
    'x-antseed-pin-peer': target.peerId,
    'x-antseed-capture-response-auth-preimages': '1',
  }
  const body = buildKbfProbeRequestBody(
    service, settings.queryProfile, probes, promptVariantId, omitSampling,
    omitThinking ? null : settings.thinking, settings.maxTokens,
  )
  const bodyBase64 = Buffer.from(body).toString('base64')
  return {
    url,
    headers,
    body,
    request: {
      method: 'POST',
      url,
      headers,
      bodyBase64,
      hash: canonicalHashBytes32({ method: 'POST', url, headers, bodyBase64 }),
    },
  }
}

function notAttemptedExchange(
  context: ProxyVerificationContext,
  target: PeerInfo,
  service: string,
  probes: KbfProbe[],
  batchIndex: number,
  settings: SellerRequestSettings,
  terminalReason: VerificationOutcomeReasonV1,
): ProxyAuditEvidenceExchangeV1 {
  const promptVariantId = pickKbfPromptVariantId()
  const { request } = buildProxyBatchRequest(context, target, service, probes, promptVariantId, settings, false)
  const now = Date.now()
  return {
    batchIndex,
    attemptCount: 0,
    requestIds: [],
    probeIds: probes.map((probe) => probe.id),
    promptVariantId,
    request,
    response: null,
    timing: { startedAt: now, completedAt: now, responseLatencyMs: 0 },
    answers: new Array<number | null>(probes.length).fill(null),
    matches: new Array<null>(probes.length).fill(null),
    status: 'failed',
    failureReason: `not attempted after terminal first-batch failure: ${terminalReason.summary}`,
    cost: null,
    attemptCosts: [],
    outcomeReason: terminalReason,
    responseAuth: {
      requestId: null,
      status: 'missing',
      record: null,
      signedPreimages: null,
      failureReason: 'batch was not attempted after terminal first-batch failure',
    },
  }
}

function isReusableExchange(exchange: ProxyAuditEvidenceExchangeV1): boolean {
  return exchange.status === 'succeeded'
    && exchange.responseAuth.status === 'verified'
    && exchange.responseAuth.signedPreimages !== null
    && exchange.outcomeReason?.code !== 'malformed_output'
    && exchange.answers.length === exchange.probeIds.length
    && exchange.matches.length === exchange.probeIds.length
}

function summarizeUndeterminedReason(
  exchanges: ProxyAuditEvidenceExchangeV1[],
  totalBatchCount: number,
): VerificationOutcomeReasonV1 {
  const reasons = exchanges.flatMap((exchange) => {
    if (exchange.status === 'succeeded') {
      if (exchange.outcomeReason) return [exchange.outcomeReason]
      if (exchange.responseAuth.status !== 'verified') {
        return [responseAuthReason(
          exchange.responseAuth.status,
          exchange.responseAuth.failureReason,
          exchange.responseAuth.requestId,
        )]
      }
      return []
    }
    return exchange.status === 'failed'
      ? [exchange.outcomeReason ?? transportReason(exchange.failureReason ?? 'proxy batch failed')]
      : []
  })
  const grouped = new Map<string, { reason: VerificationOutcomeReasonV1; count: number }>()
  for (const reason of reasons) {
    const current = grouped.get(reason.code)
    if (current) current.count += 1
    else grouped.set(reason.code, { reason, count: 1 })
  }
  const dominant = [...grouped.values()].sort((left, right) => right.count - left.count)[0]
    ?? { reason: transportReason('insufficient authenticated probe coverage'), count: totalBatchCount }
  const suffix = grouped.size > 1
    ? `; ${grouped.size - 1} additional reason type(s)`
    : ''
  return {
    ...dominant.reason,
    summary: `${dominant.reason.summary}${suffix}`,
    retryable: reasons.length > 0 && reasons.every((reason) => reason.retryable),
    affectedBatchCount: reasons.length,
    totalBatchCount,
    nextAction: reasons.some((reason) => reason.source === 'payment')
      ? 'restart or repair payment channel'
      : reasons.some((reason) => reason.code === 'malformed_output')
        ? 'seller must return parseable output'
      : 'resume audit',
  }
}

/** A reply that stopped at the token limit: the seller's model was still writing, so it is not scored. */
function truncatedOutputReason(requestId: string): VerificationOutcomeReasonV1 {
  return {
    code: 'malformed_output',
    summary: 'successful authenticated response stopped at the token limit, so its answers are not scored',
    retryable: false,
    source: 'provider',
    affectedBatchCount: 1,
    totalBatchCount: 1,
    nextAction: 'seller must return parseable output',
    requestId,
  }
}

function malformedOutputReason(requestId: string): VerificationOutcomeReasonV1 {
  return {
    code: 'malformed_output',
    summary: 'successful authenticated response contained no parseable final answers',
    retryable: false,
    source: 'provider',
    affectedBatchCount: 1,
    totalBatchCount: 1,
    nextAction: 'seller must return parseable output',
    requestId,
  }
}

function deadlineText(context: { auditTimeoutMs: number; describeDeadline?: () => string }): string {
  return context.describeDeadline?.() ?? `${AUDIT_IDLE_TEXT} ${context.auditTimeoutMs}ms`
}

function deadlineReason(summary: string): VerificationOutcomeReasonV1 {
  return {
    code: 'deadline_exceeded',
    summary,
    retryable: true,
    source: 'transport',
    affectedBatchCount: 1,
    totalBatchCount: 1,
    nextAction: 'resume audit',
  }
}

function requestTimeoutReason(timeoutMs: number): VerificationOutcomeReasonV1 {
  return {
    code: 'request_timeout',
    summary: `buyer proxy request timed out after ${timeoutMs}ms`,
    retryable: true,
    source: 'transport',
    affectedBatchCount: 1,
    totalBatchCount: 1,
    nextAction: 'resume audit',
  }
}

function responseAuthReason(
  status: 'missing' | 'invalid',
  failureReason: string | null,
  requestId: string | null,
): VerificationOutcomeReasonV1 {
  return {
    code: status === 'missing' ? 'response_auth_missing' : 'response_auth_invalid',
    summary: sanitizeOutcomeSummary(failureReason ?? `ResponseAuth ${status}`),
    retryable: true,
    source: 'response_auth',
    affectedBatchCount: 1,
    totalBatchCount: 1,
    nextAction: 'resume audit',
    ...(requestId ? { requestId } : {}),
  }
}

function transportReason(summary: string): VerificationOutcomeReasonV1 {
  return {
    code: 'transport_error',
    summary: sanitizeOutcomeSummary(summary),
    retryable: true,
    source: 'transport',
    affectedBatchCount: 1,
    totalBatchCount: 1,
    nextAction: 'retry later',
  }
}

function retryDelay(response: Response, attemptCount: number, randomFn: () => number): number {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, PROBE_RETRY_MAX_DELAY_MS)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), PROBE_RETRY_MAX_DELAY_MS)
  }
  return boundedBackoff(attemptCount, randomFn)
}

function boundedBackoff(attemptCount: number, randomFn: () => number): number {
  const base = Math.min(PROBE_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1), PROBE_RETRY_MAX_DELAY_MS)
  return Math.max(1, Math.round(base * (0.75 + randomFn() * 0.5)))
}

function safeRequestId(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(responseText(body)) as Record<string, unknown>
    if (typeof parsed.request_id === 'string') return parsed.request_id.slice(0, 128)
    const error = parsed.error
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const requestId = (error as Record<string, unknown>).request_id
      if (typeof requestId === 'string') return requestId.slice(0, 128)
    }
  } catch {
    return null
  }
  return null
}

export function extractCompletionText(body: Uint8Array): string | null {
  const text = responseText(body)
  try {
    return extractCompletionFromJson(JSON.parse(text) as Record<string, unknown>)
  } catch {
    return extractCompletionFromSse(text)
  }
}

/** Verified responses beat unverified ones; then the attempt with more scoreable answers wins. */
function isBetterBatchAttempt(candidate: ProxyAuditEvidenceExchangeV1, current: ProxyAuditEvidenceExchangeV1): boolean {
  const verified = (exchange: ProxyAuditEvidenceExchangeV1) => exchange.responseAuth.status === 'verified'
  if (verified(candidate) !== verified(current)) return verified(candidate)
  const scored = (exchange: ProxyAuditEvidenceExchangeV1) => exchange.matches.filter((match) => match !== null).length
  return scored(candidate) > scored(current)
}

function extractCompletionFromJson(parsed: Record<string, unknown>): string | null {
  const response = parsed as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
    content?: Array<{ type?: string; text?: unknown }>
    output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>
    output_text?: unknown
  }
  const chatContent = response.choices?.[0]?.message?.content
  if (typeof chatContent === 'string') return chatContent
  const completionText = response.choices?.[0]?.text
  if (typeof completionText === 'string') return completionText
  const anthropicText = response.content?.find((block) => block?.type === 'text')?.text
  if (typeof anthropicText === 'string') return anthropicText
  if (typeof response.output_text === 'string') return response.output_text
  const outputText = response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
  return outputText || null
}

function extractCompletionFromSse(text: string): string | null {
  const deltas: string[] = []
  let completed: string | null = null
  let done: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice('data:'.length).trim()
    if (!data || data === '[DONE]') continue
    try {
      const event = JSON.parse(data) as Record<string, unknown>
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        deltas.push(event.delta)
      } else if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
        done = event.text
      } else if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
        completed = extractCompletionFromJson(event.response as Record<string, unknown>)
      }
    } catch {
      continue
    }
  }
  if (deltas.length > 0) return deltas.join('')
  return completed ?? done
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function responseText(body: Uint8Array): string {
  return new TextDecoder().decode(body)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function sleepWithSignal(
  delayMs: number,
  signal: AbortSignal,
  sleepFn: (delayMs: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return
  let abort!: () => void
  const aborted = new Promise<void>((resolve) => { abort = resolve })
  signal.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([sleepFn(delayMs), aborted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
