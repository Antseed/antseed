import { randomInt, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KBF_PROBES_PER_REQUEST,
  KBF_PROMPT_VARIANT_IDS,
  buildKbfChatRequestBody,
  canonicalHashBytes32,
  canonicalJsonStringify,
  computeMatchVector,
  parseKbfAnswers,
  queryProfileHash,
  verifyKbf,
  type KbfProbe,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  trustScore,
  type PeerInfo,
  type StoredResponseAuth,
  type TokenPricingUsdPerMillion,
} from '@antseed/node'
import { parsePersistedPeers } from '../proxy/buyer-proxy.js'
import { createDomainHomogeneousKbfBatches } from './kbf-batching.js'
import {
  deriveProxyAuditId,
  parseProxyAuditExchangeCost,
  summarizeAuditExchangeCosts,
  writeProxyAuditEvidence,
  writeProxyAuditSkipEvidence,
  type AuditCostSummaryV1,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditEvidenceV1,
  type ProxyAuditSkipEvidenceV1,
  type VerificationSkipCode,
} from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import { advertisedServices } from './service-discovery.js'
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

class LazyAuditDeadline {
  readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly timeoutMs: number) {}

  start(): AbortSignal {
    this.timer ??= setTimeout(() => this.controller.abort(), this.timeoutMs)
    return this.controller.signal
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
  }
}

export interface BuyerProxySnapshot {
  baseUrl: string
  statePath: string
  pid: number
  peers: PeerInfo[]
}

export interface ProxyVerificationContext {
  proxy: BuyerProxySnapshot
  evidenceDir: string
  checkpointRootDir?: string
  requestTimeoutMs: number
  auditTimeoutMs: number
  responseAuthReader: ResponseAuthReader
  batchConcurrency: number
  batchConcurrencyPromotionLatencyMs: number
  batchLimiter: AuditTaskLimiter
  fetchFn?: typeof fetch
  sleepFn?: (delayMs: number) => Promise<void>
  randomFn?: () => number
}

export interface ModelVerificationResumeInput {
  parentAuditId: string
  reservationAuditId: string
  parentEvidenceHash: string
  exchanges: ProxyAuditEvidenceExchangeV1[]
}

export interface ModelAuditCheckpointV1 {
  version: 1
  kind: 'antseed-verifier-audit-checkpoint'
  auditId: string
  parentAuditId: string | null
  reservationAuditId?: string
  runId: string
  epoch: string
  model: string
  targetPeerId: string
  service: string
  referenceId: string
  queryProfileHash: string
  probeIds: string[]
  exchanges: ProxyAuditEvidenceExchangeV1[]
  updatedAt: string
}

export interface ModelVerificationTargetResult {
  peerId: string
  displayName: string | null
  agentId: string | null
  service: string
  status: 'SAME' | 'DIFF' | 'UNDETERMINED'
  outcomeReason?: VerificationOutcomeReasonV1 | null
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
}

export interface ModelVerificationFailure {
  peerId: string
  displayName?: string | null
  agentId: string | null
  service: string
  status: 'FAILED'
  reason: string
  outcomeReason?: VerificationOutcomeReasonV1
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
}

export interface ModelVerificationRunSummary {
  version: 1
  kind: 'antseed-model-verification-run'
  runId: string
  model: string
  mode: 'buyer-proxy'
  proxyBaseUrl: string
  referenceId: string
  probeCount: number
  startedAt: string
  completedAt: string
  results: ModelVerificationTargetResult[]
  failures: ModelVerificationFailure[]
  skipped: ModelVerificationSkip[]
}

export interface VerificationTargetPolicy {
  minReputation: number
  maxPricing: TokenPricingUsdPerMillion
}

export async function loadBuyerProxySnapshot(dataDir: string): Promise<BuyerProxySnapshot> {
  const statePath = join(dataDir, 'buyer.state.json')
  let parsed: {
    state?: unknown
    pid?: unknown
    port?: unknown
    discoveredPeers?: unknown
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
    code: 'missing_response_auth' | 'reputation_below_minimum' | 'price_above_maximum' | 'policy_rejected'
    service: string
    reason: string
  } {
  const service = advertisedServices(peer).get(normalizedModel)
  if (!service) {
    return { eligible: false, code: 'model_not_advertised', service: null, reason: 'model not advertised' }
  }
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

  const offer = resolveAdvertisedOffer(peer, normalizedModel)
  if (!offer) {
    return {
      eligible: false,
      code: 'policy_rejected',
      service,
      reason: `buyer policy could not resolve valid advertised pricing for ${service}`,
    }
  }

  const maxCachedInput = policy.maxPricing.cachedInputUsdPerMillion ?? policy.maxPricing.inputUsdPerMillion
  if (
    offer.inputUsdPerMillion > policy.maxPricing.inputUsdPerMillion
    || offer.outputUsdPerMillion > policy.maxPricing.outputUsdPerMillion
    || (offer.cachedInputUsdPerMillion != null && offer.cachedInputUsdPerMillion > maxCachedInput)
  ) {
    return {
      eligible: false,
      code: 'price_above_maximum',
      service,
      reason: `advertised price input $${offer.inputUsdPerMillion}/M, output $${offer.outputUsdPerMillion}/M exceeds buyer maximum input $${policy.maxPricing.inputUsdPerMillion}/M, output $${policy.maxPricing.outputUsdPerMillion}/M`,
    }
  }

  return { eligible: true, service }
}

export function classifyVerificationTargetServices(
  peer: PeerInfo,
  services: readonly string[],
  policy: VerificationTargetPolicy,
): ReturnType<typeof classifyVerificationTarget> {
  const candidates = services
    .map((service) => service.trim().toLowerCase())
    .filter((service, index, all) => service.length > 0 && all.indexOf(service) === index)
    .map((service) => classifyVerificationTarget(peer, service, policy))
  return candidates.find((candidate) => candidate.eligible)
    ?? candidates.find((candidate) => !candidate.eligible && candidate.code !== 'model_not_advertised')
    ?? { eligible: false, code: 'model_not_advertised', service: null, reason: 'model not advertised' }
}

function resolveAdvertisedOffer(
  peer: PeerInfo,
  normalizedModel: string,
): TokenPricingUsdPerMillion | null {
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
    if (isValidOffer(offer)) return offer
  }

  if (
    isFiniteNonNegative(peer.defaultInputUsdPerMillion)
    && isFiniteNonNegative(peer.defaultOutputUsdPerMillion)
  ) {
    return {
      inputUsdPerMillion: peer.defaultInputUsdPerMillion,
      outputUsdPerMillion: peer.defaultOutputUsdPerMillion,
      ...(isFiniteNonNegative(peer.defaultCachedInputUsdPerMillion)
        ? { cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion }
        : {}),
    }
  }

  return null
}

function isValidOffer(offer: TokenPricingUsdPerMillion | undefined): offer is TokenPricingUsdPerMillion {
  return !!offer
    && isFiniteNonNegative(offer.inputUsdPerMillion)
    && isFiniteNonNegative(offer.outputUsdPerMillion)
    && (offer.cachedInputUsdPerMillion === undefined || isFiniteNonNegative(offer.cachedInputUsdPerMillion))
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
}): Promise<ModelVerificationTargetResult | ModelVerificationSkip> {
  const batches = createDomainHomogeneousKbfBatches(
    input.reference.probes,
    KBF_PROBES_PER_REQUEST,
    (values) => [...values],
  )
  const deadline = new LazyAuditDeadline(input.context.auditTimeoutMs)
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
      exchangeByBatch.set(exchange.batchIndex, exchange)
    }
  }
  const reusedBatchIndexes = [...exchangeByBatch.keys()].sort((left, right) => left - right)
  const pending = batches.flatMap((batch, batchIndex) => exchangeByBatch.has(batchIndex)
    ? []
    : [{ probes: batch.probes, batchIndex }])
  let checkpointTail = Promise.resolve()
  const persistCheckpoint = async (): Promise<void> => {
    const snapshot = [...exchangeByBatch.values()].sort((left, right) => left.batchIndex - right.batchIndex)
    checkpointTail = checkpointTail.then(() => writeJsonAtomic(
      join(input.context.checkpointRootDir ?? input.context.evidenceDir, '.checkpoints', `${auditId}.json`),
      {
        version: 1,
        kind: 'antseed-verifier-audit-checkpoint',
        auditId,
        parentAuditId: input.resume?.parentAuditId ?? null,
        reservationAuditId: input.resume?.reservationAuditId ?? auditId,
        runId: input.checkpointIdentity?.runId ?? '',
        epoch: input.checkpointIdentity?.epoch ?? '',
        model: input.checkpointIdentity?.model ?? input.reference.referenceModel,
        targetPeerId: input.target.peerId,
        service: input.service,
        referenceId: input.reference.referenceId,
        queryProfileHash: queryProfileHash(input.reference.queryProfile),
        probeIds: input.reference.probes.map((probe) => probe.id),
        exchanges: snapshot,
        updatedAt: new Date().toISOString(),
      },
    ))
    await checkpointTail
  }
  try {
    const executed = await mapWithAdaptiveConcurrency(
      pending,
      input.context.batchConcurrency,
      async ({ probes, batchIndex }, _pendingIndex, control) => input.context.batchLimiter.run(async () => {
        const exchange = await executeProxyProbeBatch(
        { ...input.context, signal: deadline.start() },
        input.target,
        input.service,
        input.reference,
        probes,
        batchIndex,
        control.reduceToOne,
        )
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
      exchangeByBatch.set(error.exchange.batchIndex, error.exchange)
      for (const { probes, batchIndex } of pending) {
        if (!exchangeByBatch.has(batchIndex)) {
          exchangeByBatch.set(batchIndex, notAttemptedExchange(
            input.context,
            input.target,
            input.service,
            input.reference,
            probes,
            batchIndex,
            error.exchange.outcomeReason!,
          ))
        }
      }
      await persistCheckpoint()
    } else if (!(error instanceof VerificationSkipSignal)) {
      throw error
    } else {
    const completedAt = Date.now()
    const evidence: ProxyAuditSkipEvidenceV1 = {
      version: 1,
      kind: 'antseed-buyer-proxy-target-skip',
      evidenceLevel: 'proxy-observation-no-payment-evidence',
      createdAt: new Date(completedAt).toISOString(),
      buyerProxy: {
        baseUrl: input.context.proxy.baseUrl,
        statePath: input.context.proxy.statePath,
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
      exchange: error.exchange,
      result: {
        status: 'SKIPPED',
        code: error.code,
        reason: error.reason,
        outcomeReason: withBatchCounts(error.outcomeReason, 1, batches.length),
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
    }
    }
  } finally {
    deadline.close()
  }
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
  const fragment = verifyKbf(input.reference, { answers, matchVector }, { minCoverage: 1 })
  if (fragment.verdict === 'UNKNOWN') throw new Error(fragment.verdictReason ?? 'verification returned UNKNOWN')

  const completedAt = Date.now()
  const authenticated = exchanges.every((exchange) => exchange.status !== 'succeeded'
    || exchange.responseAuth.status === 'verified')
  const verdict = authenticated ? fragment.verdict : 'UNDETERMINED'
  const verdictReason = authenticated
    ? fragment.verdictReason
    : 'one or more successful proxy batches lacked valid verified ResponseAuth'
  const outcomeReason = verdict === 'UNDETERMINED' ? summarizeUndeterminedReason(exchanges, batches.length) : null
  const cumulativeCost = summarizeAuditExchangeCosts(exchanges)
  const newBatchIndexes = new Set(pending.map((entry) => entry.batchIndex))
  const cost = summarizeAuditExchangeCosts(exchanges.filter((exchange) => newBatchIndexes.has(exchange.batchIndex)))
  const correctProbeCount = matchVector.filter((entry) => entry === 1).length
  const incorrectProbeCount = matchVector.filter((entry) => entry === 0).length
  const parsedProbeCount = correctProbeCount + incorrectProbeCount
  const evidence: ProxyAuditEvidenceV1 = {
    version: 1,
    kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: new Date(completedAt).toISOString(),
    buyerProxy: {
      baseUrl: input.context.proxy.baseUrl,
      statePath: input.context.proxy.statePath,
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
      queryProfileHash: queryProfileHash(input.reference.queryProfile),
      queryProfile: input.reference.queryProfile,
      statisticalPower: input.reference.statisticalPower,
      statisticalPowerEvidence: input.reference.statisticalPowerEvidence as unknown as Record<string, unknown>,
      selfTest: input.reference.selfTest,
      probes: input.reference.probes,
    },
    exchanges,
    ...(input.resume ? {
      resume: {
        parentAuditId: input.resume.parentAuditId,
        reservationAuditId: input.resume.reservationAuditId,
        parentEvidenceHash: input.resume.parentEvidenceHash,
        reusedBatchIndexes,
      },
    } : {}),
    result: {
      selectedProbeCount: input.reference.probes.length,
      parsedProbeCount,
      matchVector,
      matchVectorHash: fragment.matchVectorHash,
      stats: fragment.stats,
      verdict,
      verdictReason,
      outcomeReason,
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
  return {
    peerId: input.target.peerId,
    displayName: input.target.displayName ?? null,
    agentId: input.target.onChainAgentId ? String(input.target.onChainAgentId) : null,
    service: input.service,
    status: verdict,
    outcomeReason,
    auditId: resolvedAuditId,
    parsedProbeCount,
    probeCount: input.reference.probes.length,
    correctProbeCount,
    incorrectProbeCount,
    correctRate: parsedProbeCount === 0 ? null : correctProbeCount / parsedProbeCount,
    requestCount: exchanges.length,
    cost,
    cumulativeCost,
    evidencePath: written.path,
    evidenceHash: written.evidenceHash,
  }
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
      const checkpoint = JSON.parse(await readFile(path, 'utf8')) as ModelAuditCheckpointV1
      if (checkpoint.version !== 1
        || checkpoint.kind !== 'antseed-verifier-audit-checkpoint'
        || typeof checkpoint.auditId !== 'string'
        || !Array.isArray(checkpoint.exchanges)) {
        throw new Error(`invalid verifier audit checkpoint: ${path}`)
      }
      if (!checkpoint.runId || !checkpoint.epoch || !checkpoint.model) return null
      return { path, checkpoint }
    }))
  const checkpoints = checkpointEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  return checkpoints.sort((left, right) => left.checkpoint.updatedAt.localeCompare(right.checkpoint.updatedAt))
}

async function executeProxyProbeBatch(
  context: ProxyVerificationContext & { signal: AbortSignal },
  target: PeerInfo,
  service: string,
  reference: KbfReferenceV1,
  probes: KbfProbe[],
  batchIndex: number,
  onRateLimited?: () => void,
): Promise<ProxyAuditEvidenceExchangeV1> {
  const { url, headers, body, request, promptVariantId } = buildProxyBatchRequest(
    context, target, service, reference, probes,
  )
  const startedAt = Date.now()
  let attemptCount = 0
  let lastFailure = 'proxy request failed'
  let lastOutcomeReason: VerificationOutcomeReasonV1 = transportReason(lastFailure)
  let lastResponse: ProxyAuditEvidenceExchangeV1['response'] = null
  const requestIds: string[] = []
  let lastRequestId: string | null = null
  const attemptCosts = [] as NonNullable<ProxyAuditEvidenceExchangeV1['attemptCosts']>
  let responseAuthRetryCount = 0
  let blankLengthRetryCount = 0
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
    const timer = setTimeout(() => controller.abort(), context.requestTimeoutMs)
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
        const classified = classifyProxyFailure(response.status, responseBody)
        lastOutcomeReason = {
          ...classified.outcomeReason,
          upstreamStatus: response.status,
          ...(classified.outcomeReason.requestId ? {} : { requestId: safeRequestId(responseBody) ?? requestId }),
        }
        if (batchIndex === 0 && classified.skipCode) {
          const completedAt = Date.now()
          throw new VerificationSkipSignal(classified.skipCode, lastOutcomeReason.summary, lastOutcomeReason, {
            batchIndex,
            attemptCount,
            requestIds,
            probeIds: probes.map((probe) => probe.id),
            promptVariantId,
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
      const completion = extractCompletionText(responseBody)
      const answers = completion === null
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
      if (responseAuth.status === 'verified'
        && blankLengthRetryCount < 1
        && attemptCount < PROBE_REQUEST_ATTEMPTS
        && isBlankLengthResponse(responseBody, completion, answers)) {
        blankLengthRetryCount += 1
        await sleepWithSignal(PROBE_RETRY_BASE_DELAY_MS, context.signal, sleepFn)
        continue
      }
      return {
        batchIndex,
        attemptCount,
        requestIds,
        probeIds: probes.map((probe) => probe.id),
        promptVariantId,
        request,
        response: lastResponse,
        timing: { startedAt, completedAt, responseLatencyMs: Math.max(0, completedAt - startedAt) },
        answers,
        matches,
        status: 'succeeded',
        failureReason: null,
        cost: attemptCost,
        attemptCosts,
        outcomeReason: responseAuth.status === 'verified'
          ? malformedOutput ? malformedOutputReason(requestId) : null
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
    } catch (error) {
      if (error instanceof VerificationSkipSignal) throw error
      lastFailure = context.signal.aborted
        ? `seller audit deadline exceeded after ${context.auditTimeoutMs}ms`
        : controller.signal.aborted
          ? `buyer proxy request timed out after ${context.requestTimeoutMs}ms`
        : asError(error).message
      lastOutcomeReason = context.signal.aborted
        ? deadlineReason(context.auditTimeoutMs)
        : controller.signal.aborted
          ? requestTimeoutReason(context.requestTimeoutMs)
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
  if (context.signal.aborted) {
    lastFailure = `seller audit deadline exceeded after ${context.auditTimeoutMs}ms`
    lastOutcomeReason = deadlineReason(context.auditTimeoutMs)
  }
  const completedAt = Date.now()
  return {
    batchIndex,
    attemptCount,
    requestIds,
    probeIds: probes.map((probe) => probe.id),
    promptVariantId,
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
  if (normalizedMessage.includes('invalid temperature')
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
        nextAction: 'seller must support canonical request profile',
      },
    }
  }

  if ((statusCode === 400 || statusCode === 404)
    && (code === 'model_not_found' || message.includes('is not served by this peer'))) {
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

function buildProxyBatchRequest(
  context: ProxyVerificationContext,
  target: PeerInfo,
  service: string,
  reference: KbfReferenceV1,
  probes: KbfProbe[],
  promptVariantId: string = pickKbfPromptVariantId(),
): {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  request: ProxyAuditEvidenceExchangeV1['request']
  promptVariantId: string
} {
  const url = `${context.proxy.baseUrl}/v1/chat/completions`
  const headers = {
    'content-type': 'application/json',
    'x-antseed-pin-peer': target.peerId,
    'x-antseed-capture-response-auth-preimages': '1',
  }
  // Audits send the canonical KBF body. Reference-endpoint settings (legacy
  // queryProfile.requestOverrides / requestOmissions / reasoningStrategy) only
  // describe how the reference endpoint was queried and never reach sellers.
  const requestBody: Record<string, unknown> = {
    ...buildKbfChatRequestBody(service, probes, {
      maxTokens: reference.queryProfile.maxTokensPerRequest,
      variantId: promptVariantId,
    }),
    temperature: reference.queryProfile.auditTemperature,
    top_p: reference.queryProfile.generationSettings.topP,
    stream: false,
    n: 1,
  }
  const body = new TextEncoder().encode(JSON.stringify(requestBody))
  const bodyBase64 = Buffer.from(body).toString('base64')
  return {
    url,
    headers,
    body,
    promptVariantId,
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
  reference: KbfReferenceV1,
  probes: KbfProbe[],
  batchIndex: number,
  terminalReason: VerificationOutcomeReasonV1,
): ProxyAuditEvidenceExchangeV1 {
  const { request, promptVariantId } = buildProxyBatchRequest(context, target, service, reference, probes)
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

function deadlineReason(timeoutMs: number): VerificationOutcomeReasonV1 {
  return {
    code: 'deadline_exceeded',
    summary: `seller audit deadline exceeded after ${timeoutMs}ms`,
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

export async function writeRunSummary(evidenceDir: string, summary: ModelVerificationRunSummary): Promise<string> {
  const { mkdir, open, rename } = await import('node:fs/promises')
  const directory = join(evidenceDir, 'runs')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${summary.runId}.json`)
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(canonicalJsonStringify(summary))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  return path
}

export async function readRunSummary(path: string): Promise<ModelVerificationRunSummary> {
  return JSON.parse(await readFile(path, 'utf8')) as ModelVerificationRunSummary
}

function extractCompletionText(body: Uint8Array): string | null {
  const text = responseText(body)
  try {
    return extractCompletionFromJson(JSON.parse(text) as Record<string, unknown>)
  } catch {
    return extractCompletionFromSse(text)
  }
}

function isBlankLengthResponse(
  responseBody: Uint8Array,
  completion: string | null,
  answers: Array<number | null>,
): boolean {
  if ((completion ?? '').trim() !== '' || answers.some((answer) => answer !== null)) return false
  const text = responseText(responseBody)
  try {
    return hasLengthFinishReason(JSON.parse(text) as Record<string, unknown>)
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice('data:'.length).trim()
      if (!data || data === '[DONE]') continue
      try {
        if (hasLengthFinishReason(JSON.parse(data) as Record<string, unknown>)) return true
      } catch {
        continue
      }
    }
    return false
  }
}

function hasLengthFinishReason(value: Record<string, unknown>): boolean {
  const choices = Array.isArray(value.choices) ? value.choices : []
  return choices.some((choice) => choice !== null
    && typeof choice === 'object'
    && (choice as Record<string, unknown>).finish_reason === 'length')
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
