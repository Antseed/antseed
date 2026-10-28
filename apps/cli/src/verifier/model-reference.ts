import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  KBF_DEFAULT_SELF_TEST_RUNS,
  KBF_ENROLLMENT_TEMPERATURES,
  KBF_LOW_COVERAGE_RETRIES,
  KBF_PROBES_PER_REQUEST,
  KBF_PROMPT_VARIANT_IDS,
  KBF_REFERENCE_VERSION,
  aggregateKbfSelfTestOutcomes,
  buildKbfChatRequestBody,
  canonicalHashBytes32,
  canonicalJsonStringify,
  computeBinomialPower,
  computeMatchVector,
  isLowCoverageKbfBatch,
  computeReferenceId,
  createReferenceQueryProfile,
  KBF_THINKING_PREFILL,
  type ReferenceEndpointRequestV1,
  type ReferenceReasoningStrategy,
  referenceEndpointRequest as recordedReferenceEndpointRequest,
  type ReferenceContrastDetectionV1,
  type ReferenceContrastV1,
  computeContrastDetection,
  matchesTolerance,
  parseKbfAnswers,
  rescoreKbfReference,
  sha256Hex,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceV1,
  type ReferenceProbeSelfTestV1,
} from '@antseed/fingerprints'
import type {
  VerifierCLIConfig,
  VerifierModelPricingConfig,
  VerifierReferenceEndpointConfig,
  VerifierUpstreamConfig,
} from '../config/types.js'
import {
  REFERENCE_MINIMUM_MISMATCH_DELTA,
  REFERENCE_POWER_ALPHA,
  REFERENCE_MAXIMUM_SELF_TEST_ERROR_RATE,
  REFERENCE_POWER_CONFIDENCE,
  isReferenceProbeCountAllowed,
  resolveReferenceSizingPolicy,
} from './reference-sizing.js'
import { probeBankCompatibilityHash } from './probe-bank.js'
import { safeServiceSlug } from './slug.js'
import { auditedVerifierModels, resolveVerifierModelConfig, type ResolvedVerifierModelConfig } from './model-config.js'
import type { VerifierModelCatalog, VerifierReasoningEffort } from './openrouter-catalog.js'
import {
  THINKING_DISCOVERY_PROBES,
  THINKING_DISCOVERY_TIMEOUT_MS,
  THINKING_FALLBACK_MAX_TOKENS,
  ThinkingDiscoveryError,
  discoverThinkingSuppression,
  thinkingStrategyRequest,
  type ThinkingDiscoveryAttemptV1,
  type ThinkingDiscoveryProbe,
  type ThinkingDiscoveryStrategy,
} from './thinking-suppression.js'
import {
  CANONICAL_KBF_DOMAINS,
  canonicalKbfTolerance,
  createCanonicalKbfProbe,
} from './canonical-kbf-domains.js'
import { writeJsonAtomic, writeTextAtomic } from './atomic-files.js'
import { createDomainHomogeneousKbfBatches } from './kbf-batching.js'
import { asError, normalized, sleep } from './utils.js'

const REFERENCE_BUILDER_VERSION = '6'
const CANDIDATE_COUNT = 300
const CANDIDATE_BATCH_SIZE = 20
const DEFAULT_MAX_REQUESTS_PER_BUILD = 2_000
const DEFAULT_BATCH_RETRY_COUNT = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 500
const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 3
// Candidate batches ask for a long list (up to 6000 tokens) and nothing is scored from them, so
// they get more time than the measured requests, whose timeout is part of the bank settings.
const CANDIDATE_GENERATION_TIMEOUT_MS = 300_000
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4
const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_MODEL = 3
const NEW_ACCOUNT_MINIMUM_REQUEST_INTERVAL_MS = 6_500
const NEW_ACCOUNT_RATE_LIMIT_COOLDOWN_MS = 65_000
const MAX_TOKENS = 1600
const ANTHROPIC_VERSION = '2023-06-01'
const REFERENCE_SIZING_ALGORITHM_VERSION = 2
const MINIMUM_SUPPORTED_REASONING_STRATEGY = 'reasoning-effort-minimum-supported' as const
const DISABLED_REASONING_STRATEGY = 'reasoning-effort-none' as const
const BARE_REASONING_STRATEGY = 'bare' as const
const DISABLED_REASONING_REQUEST_OVERRIDES = { reasoning_effort: 'none' } as const
const CONTRAST_EMPTY_BATCH_RETRIES = 2
const CONTRAST_MAX_CONSECUTIVE_EMPTY_BATCHES = 3
const TERMINAL_EMPTY_FINISH_REASONS = new Set(['content_filter', 'length', 'refusal'])
const REASONING_EFFORT_ASCENDING: readonly VerifierReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

interface CollectedReferenceProbes {
  probes: KbfProbe[]
  candidateCount: number
  distinguishingProbeIdsByModel: Map<string, string[]>
  /** Contrast models that returned a parseable answer, by accepted probe id. */
  answeredContrastModelsByProbeId?: Map<string, string[]>
  generatedProbeIds: Set<string>
  reserveProbes: KbfProbe[]
  generationRound: number
}

interface ReferenceBuildCheckpointV1 {
  version: 1
  kind: 'antseed-reference-build-checkpoint'
  compatibilityHash: string
  requestsUsed: number
  responses: Record<string, ReferenceCachedResponseV1>
}

interface ReferenceCachedResponseBaseV1 {
  model: string
  /** Upstream provider that served the response, when the endpoint reports it. */
  provider?: string | null
  purpose: ReferenceBuildCostPurposeV1['purpose']
  inputTokens: number
  outputTokens: number
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  costUsdMicros: string
  /** Hidden reasoning tokens the endpoint reported (thinking discovery only). */
  reasoningTokens?: number
}

interface ReferenceCachedSuccessV1 extends ReferenceCachedResponseBaseV1 {
  outcome?: 'success'
  content: string
}

interface ReferenceCachedTerminalEmptyV1 extends ReferenceCachedResponseBaseV1 {
  outcome: 'terminal-empty'
  finishReason: string | null
  nativeFinishReason: string | null
  detail: string
}

type ReferenceCachedResponseV1 = ReferenceCachedSuccessV1 | ReferenceCachedTerminalEmptyV1

export interface ReferenceBuildCostModelV1 {
  model: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  costUsdMicros: string
}

export interface ReferenceBuildCostPurposeV1 extends ReferenceBuildCostModelV1 {
  purpose: 'candidate-generation' | 'target-model' | 'contrast-model' | 'self-test' | 'thinking-discovery'
}

export interface ReferenceBuildCostV1 {
  totalUsdMicros: string
  requestCount: number
  models: ReferenceBuildCostModelV1[]
  purposes: ReferenceBuildCostPurposeV1[]
}

export interface ReferenceRequestLimiter {
  run: <T>(model: string, execute: () => Promise<T>) => Promise<T>
  recordSuccess: (model: string) => void
}

export function createReferenceRequestLimiter(
  config: VerifierCLIConfig | undefined,
  options: {
    newAccountMinimumRequestIntervalMs?: number
    newAccountRateLimitCooldownMs?: number
  } = {},
): ReferenceRequestLimiter {
  return new AdaptiveRequestLimiter(
    config?.referenceMaxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    config?.referenceMaxConcurrentRequestsPerModel ?? DEFAULT_MAX_CONCURRENT_REQUESTS_PER_MODEL,
    options.newAccountMinimumRequestIntervalMs ?? NEW_ACCOUNT_MINIMUM_REQUEST_INTERVAL_MS,
    options.newAccountRateLimitCooldownMs ?? NEW_ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
  )
}

type ReferenceQuery = ((model: string, body: Record<string, unknown>) => Promise<string>) & {
  invalidate?: (model: string, body: Record<string, unknown>) => Promise<void>
  costSummary?: () => ReferenceBuildCostV1
  consumedResponses?: () => ReferenceCachedResponseV1[]
  /** One thinking-discovery request on an explicit route; see `discoverThinkingSuppression`. */
  probeThinking?: (model: string, route: ReferenceRequestRoute, maxTokens: number) => ReturnType<ThinkingDiscoveryProbe>
  /** Upstream providers that served this build's responses for a model, in first-seen order. */
  servedProviders?: (model: string) => string[]
}

/** OpenRouter provider routing that pins the reference upstream provider. */
interface ReferenceProviderRouting {
  order: string[]
  allow_fallbacks: false
}

export type ReferenceUpstreamType = 'openrouter' | 'openai' | 'anthropic' | 'antseed'
export type ReferenceUpstreamProtocol = 'openai-chat-completions' | 'anthropic-messages'

interface ReferenceRequestRoute {
  type: 'direct' | 'antseed'
  baseUrl: string
  model: string
  apiKey?: string
  peerId?: string
  pricing?: VerifierModelPricingConfig
  requestOverrides: Record<string, unknown>
  requestOmissions: Array<'temperature' | 'top_p'>
  providerRouting?: ReferenceProviderRouting
  /** Named `verifier.upstreams` entry; absent when requests go to `referenceEndpoint`. */
  upstream?: { name: string; type: ReferenceUpstreamType }
  /** Absent means OpenAI Chat Completions. */
  protocol?: 'anthropic-messages'
  /** Thinking suppression found by discovery (or recorded by the bank being extended). */
  reasoningStrategy?: ReferenceReasoningStrategy
  /** Assistant message appended to every request (`prefill` strategy, Chat Completions only). */
  assistantPrefill?: string
  /** Token budget floor for every request (`bare-expanded` strategy). */
  minMaxTokens?: number
}

/**
 * Where the reference model's answers came from. Never holds API keys. Stored in
 * `provenance.upstream` so anyone reading a published reference can see which API
 * produced it and with which request settings.
 */
export interface ReferenceUpstreamProvenanceV1 {
  /** `verifier.upstreams` entry name, or `referenceEndpoint`. */
  name: string
  type: ReferenceUpstreamType
  baseUrl: string
  model: string
  protocol: ReferenceUpstreamProtocol
  request: { overrides: Record<string, unknown>; omissions: string[]; assistantPrefill?: string; minMaxTokens?: number }
  providerPin: string[] | null
  peerId?: string
}

/** One raw request/response pair sent to a reference upstream, without credentials. */
export interface ReferenceExchangeV1 {
  cacheKey: string
  model: string
  purpose: ReferenceBuildCostPurposeV1['purpose']
  url: string
  protocol: ReferenceUpstreamProtocol
  requestBody: string
  status: number
  responseBody: string
  receivedAt: string
}

export interface ReferenceExchangesFileV1 {
  path: string
  /** sha256 of the file's exact bytes. */
  sha256: string
  upstream: ReferenceUpstreamProvenanceV1
  exchangeCount: number
  requestCount: number
}

/** Every upstream exchange behind one reference build, published as reference evidence. */
export interface ReferenceExchangesV1 {
  version: 1
  kind: 'antseed-reference-exchanges'
  model: string
  upstream: ReferenceUpstreamProvenanceV1
  requestCount: number
  exchangeCount: number
  exchanges: ReferenceExchangeV1[]
}

export async function loadModelReference(input: {
  model: string
  referencesDir: string
  config?: VerifierCLIConfig
}): Promise<{ reference: KbfReferenceV1; path: string }> {
  const path = referencePath(input.referencesDir, input.model)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no reference exists for ${input.model}; run antseed verifier reference build ${input.model}`)
    }
    throw error
  }
  try {
    const sizing = resolveReferenceSizingPolicy(input.config)
    // References built before unscoreable answers were left out are re-scored on load.
    const reference = rescoreKbfReference(validateKbfReferenceV1(JSON.parse(raw), {
      trustImported: true,
      minimumStatisticalPower: Number.EPSILON,
    }))
    if (!reference.serviceAliases.some((alias) => normalized(alias) === normalized(input.model))) {
      throw new Error(`reference does not include service alias ${input.model}`)
    }
    if (!isReferenceProbeCountAllowed(reference.probes.length, sizing)) {
      throw new Error(
        `reference probe count ${reference.probes.length} is outside the configured adaptive sizing sequence`,
      )
    }
    if (Math.abs(reference.minimumMismatchDelta - REFERENCE_MINIMUM_MISMATCH_DELTA) > 1e-12) {
      throw new Error(`reference minimumMismatchDelta must be ${REFERENCE_MINIMUM_MISMATCH_DELTA}`)
    }
    if (Math.abs(reference.statisticalPowerEvidence.alpha - REFERENCE_POWER_ALPHA) > 1e-12) {
      throw new Error(`reference statistical power alpha must be ${REFERENCE_POWER_ALPHA}`)
    }
    if (Math.abs(
      reference.statisticalPowerEvidence.clopperPearsonConfidence - REFERENCE_POWER_CONFIDENCE,
    ) > 1e-12) {
      throw new Error(
        `reference Clopper-Pearson confidence must be ${REFERENCE_POWER_CONFIDENCE}`,
      )
    }
    if (reference.statisticalPower < sizing.minimumStatisticalPower) {
      throw new Error(
        `reference statistical power ${reference.statisticalPower.toFixed(3)} is below `
        + sizing.minimumStatisticalPower.toFixed(3),
      )
    }
    return { reference, path }
  } catch (error) {
    throw new Error(`invalid reference for ${input.model}: ${asError(error).message}; run antseed verifier reference build ${input.model}`)
  }
}

export async function buildModelReference(input: {
  model: string
  referencesDir: string
  config: VerifierCLIConfig | undefined
  catalog?: VerifierModelCatalog | null
  buyerProxyPort?: number
  fetchFn?: typeof fetch
  log?: (message: string) => void
  requestLimiter?: ReferenceRequestLimiter
  initialReference?: KbfReferenceV1
  /**
   * Probes already certified stable for this model by an earlier enrollment
   * with the same enrollment prompt, temperatures and stability rule. They skip
   * candidate generation and stability passes only; contrast checks and
   * self-tests are measured again by this build.
   */
  seedProbes?: { probes: readonly KbfProbe[]; source: Record<string, unknown> }
  /** Probe ids already banked; generation never returns them, so every selected probe is new. */
  excludedProbeIds?: ReadonlySet<string>
  /**
   * The bank's enrollment, used only for its recorded request settings (thinking suppression,
   * prefill, token limit) when building fresh probes for an existing bank. Its probes are not
   * reused. Without it a fresh build re-discovers the settings, and a bank enrolled with other
   * settings rejects the result as incompatible.
   */
  settingsReference?: KbfReferenceV1
}): Promise<{
  reference: KbfReferenceV1
  path: string
  /** Raw upstream exchanges behind this build (`ReferenceExchangesV1`). */
  exchanges?: ReferenceExchangesFileV1
  cost: ReferenceBuildCostV1
  /** Contrast models that returned a parseable answer, by selected probe id. */
  answeredContrastModelsByProbeId?: Map<string, string[]>
  finalize: () => Promise<void>
}> {
  const endpoint = input.config?.referenceEndpoint
  if (!endpoint) throw new Error('verifier.referenceEndpoint is required')
  const modelConfig = resolveVerifierModelConfig(input.config, input.model, input.catalog)
  const pricingByModel = referencePricingByModel(input.config, modelConfig, input.catalog ?? null)
  const apiKey = (endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined) ?? endpoint.apiKey
  const routesByModel = new Map(
    [modelConfig.upstreamModel, ...modelConfig.contrastModels].map((model) => {
      const isTarget = normalized(model) === normalized(modelConfig.upstreamModel)
      return [normalized(model), resolveReferenceRequestRoute({
        endpoint,
        model,
        apiKey,
        catalog: input.catalog ?? null,
        referenceRoute: isTarget ? modelConfig.referenceRoute : undefined,
        referenceProvider: isTarget ? modelConfig.referenceProvider : undefined,
        upstream: isTarget && modelConfig.upstream ? {
          name: modelConfig.upstream.name,
          model: modelConfig.upstream.model,
          config: input.config?.upstreams?.[modelConfig.upstream.name],
        } : undefined,
        buyerProxyPort: input.buyerProxyPort,
      })] as const
    }),
  )
  const sizing = resolveReferenceSizingPolicy(input.config)
  const selfTestRuns = input.config?.referenceSelfTestRuns ?? KBF_DEFAULT_SELF_TEST_RUNS
  assertPositiveInteger(selfTestRuns, 'referenceSelfTestRuns')
  const initial = input.initialReference && validateKbfReferenceV1(input.initialReference, {
    minimumStatisticalPower: Number.EPSILON,
  })
  if (initial && input.settingsReference) throw new Error('initialReference already carries the bank settings')
  // Where this build's request settings come from: the enrollment it extends, or the bank it adds
  // fresh probes to. Either way new probes are measured exactly like the banked ones.
  const settings = initial ?? (input.settingsReference && validateKbfReferenceV1(input.settingsReference, {
    minimumStatisticalPower: Number.EPSILON,
  }))
  // The request timeout is part of the measurement (it decides which slow answers count), so a
  // bank keeps the one it was enrolled with.
  const timeoutMs = settings?.queryProfile.requestTimeoutMs ?? input.config?.probeRequestTimeoutMs ?? 120_000
  const limiter = input.requestLimiter ?? createReferenceRequestLimiter(input.config)
  const pricingForModel = (model: string): VerifierModelPricingConfig => {
    const pricing = pricingByModel.get(normalized(model))
    if (!pricing) throw new Error(`no reference pricing is available for ${model}`)
    return pricing
  }
  // Thinking suppression, as in the KBF reference code: discovered per route on a
  // fixed test batch. A bank enrolled before discovery keeps the settings it recorded,
  // so new probes are measured exactly like the banked ones.
  const recordedEndpointRequest = settings ? recordedReferenceEndpointRequest(settings) : null
  const initialDiscovery = settings?.generator.params.thinkingDiscovery as ReferenceThinkingDiscoveryRecordV1 | undefined
  const discover = !settings
  if (settings && recordedEndpointRequest) {
    const target = routesByModel.get(normalized(modelConfig.upstreamModel))!
    routesByModel.set(normalized(modelConfig.upstreamModel), withRecordedEndpointRequest(target, recordedEndpointRequest, settings))
  }
  for (const entry of Object.values(initialDiscovery?.contrasts ?? {})) {
    const key = normalized(entry.model)
    const route = routesByModel.get(key)
    if (route && route.type !== 'antseed') routesByModel.set(key, routeWithThinkingStrategy(route, entry.strategy))
  }
  const discoveryCheckpointPath = join(input.referencesDir, '.checkpoints', `${safeServiceSlug(input.model)}.thinking.json`)
  const discoveryCheckpoint = discover ? await ReferenceBuildCheckpoint.open(discoveryCheckpointPath, canonicalHashBytes32({
    version: 1,
    model: normalized(input.model),
    routesByModel: [...routesByModel.entries()],
  })) : null
  const discoveryQuery = discoveryCheckpoint ? createReferenceQuery({
    timeoutMs: THINKING_DISCOVERY_TIMEOUT_MS,
    fetchFn: input.fetchFn ?? fetch,
    checkpoint: discoveryCheckpoint,
    limiter,
    maxRequests: input.config?.referenceMaxRequestsPerBuild ?? DEFAULT_MAX_REQUESTS_PER_BUILD,
    retryCount: input.config?.referenceBatchRetryCount ?? DEFAULT_BATCH_RETRY_COUNT,
    retryBaseDelayMs: input.config?.referenceRetryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    pricingForModel,
    routeForModel: (model) => routesByModel.get(normalized(model))!,
    log: input.log,
  }) : null
  let thinkingDiscovery: ReferenceThinkingDiscoveryRecordV1 | undefined
  if (discoveryQuery) {
    const targetKey = normalized(modelConfig.upstreamModel)
    const modelNames = new Map([modelConfig.upstreamModel, ...modelConfig.contrastModels].map((model) => [normalized(model), model]))
    const discovered = await allSettledOrThrow([...routesByModel.entries()].map(async ([key, route]) => {
      const isTarget = key === targetKey
      const model = modelNames.get(key) ?? route.model
      if (route.type === 'antseed') return [key, route, null] as const
      try {
        const result = await discoverThinkingSuppression({
          model: route.model,
          label: route.baseUrl,
          supportsPrefill: route.protocol !== 'anthropic-messages',
          probe: (attempt) => discoveryQuery.probeThinking!(model, routeWithThinkingStrategy(route, attempt.strategy), attempt.maxTokens),
          log: input.log,
        })
        return [key, routeWithThinkingStrategy(route, result.strategy), result] as const
      } catch (error) {
        if (isTarget && !(input.config?.referenceAllowThinking === true && error instanceof ThinkingDiscoveryError
          && !asError(error).message.includes('refused every request'))) {
          throw error
        }
        input.log?.(`${asError(error).message}; continuing with 'bare' and ${THINKING_FALLBACK_MAX_TOKENS} tokens per request`)
        const attempts = error instanceof ThinkingDiscoveryError ? error.attempts : []
        return [key, routeWithThinkingStrategy(route, 'bare-expanded'), { strategy: 'bare-expanded' as const, ...thinkingStrategyRequest('bare-expanded'), attempts }] as const
      }
    }))
    const contrasts: Record<string, ReferenceThinkingDiscoveryEntryV1> = {}
    let target: ReferenceThinkingDiscoveryEntryV1 | undefined
    for (const [key, route, result] of discovered) {
      routesByModel.set(key, route)
      if (!result) continue
      const model = modelNames.get(key) ?? route.model
      const entry = { model, strategy: result.strategy, attempts: result.attempts }
      if (key === targetKey) target = entry
      else contrasts[model] = entry
    }
    thinkingDiscovery = {
      version: 1,
      method: 'kbf-reference-code-2026-09-30',
      ...(target ? { target } : {}),
      contrasts,
    }
  }
  const targetRoute = routesByModel.get(normalized(modelConfig.upstreamModel))!
  const targetRequestOverrides = targetRoute.requestOverrides
  const targetReasoningStrategy = referenceReasoningStrategy(targetRoute)
  const upstreamProvenance = referenceUpstreamProvenance(endpoint, targetRoute)
  const queryProfile = createReferenceQueryProfile({
    upstreamModel: targetRoute.model,
    maxTokensPerRequest: Math.max(MAX_TOKENS, targetRoute.minMaxTokens ?? 0),
    requestTimeoutMs: timeoutMs,
  })
  // The reference endpoint's request settings stay out of the query profile. Audits
  // send targets only the thinking suppression from them (as the KBF reference code
  // does for every endpoint), never omissions or provider pins.
  const referenceEndpointRequest: ReferenceEndpointRequestV1 = {
    reasoningStrategy: targetReasoningStrategy,
    requestOverrides: targetRequestOverrides,
    requestOmissions: targetRoute.requestOmissions,
    ...(targetRoute.assistantPrefill ? { assistantPrefill: KBF_THINKING_PREFILL } : {}),
  }
  if (settings) {
    const expected = {
      ...settings,
      referenceModel: input.model,
      // Aliases don't change how answers are measured, so a changed alias list never blocks a bank.
      serviceAliases: settings.serviceAliases,
      queryProfile,
      minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
      generator: {
        name: 'antseed-simple-reference-builder', version: REFERENCE_BUILDER_VERSION, verifierKind: 'kbf',
        params: { enrollmentBatchingVersion: 2, enrollmentStabilityVersion: 2, referenceEndpointRequest },
      },
      provenance: { sourceId: referenceSourceId(endpoint, targetRoute), trust: endpoint.trust },
    }
    if (probeBankCompatibilityHash(input.model, settings) !== probeBankCompatibilityHash(input.model, expected)
      || settings.generator.params.selfTestRuns !== selfTestRuns
      || settings.statisticalPowerEvidence.alpha !== REFERENCE_POWER_ALPHA
      || settings.statisticalPowerEvidence.clopperPearsonConfidence !== REFERENCE_POWER_CONFIDENCE
      || canonicalHashBytes32(settings.contrasts.map((entry) => normalized(entry.model)).sort())
        !== canonicalHashBytes32(modelConfig.contrastModels.map(normalized).sort())
      || canonicalHashBytes32((settings.generator.params.referenceProvider as { pinned?: unknown } | undefined)?.pinned ?? null)
        !== canonicalHashBytes32(targetRoute.providerRouting
          ? { order: targetRoute.providerRouting.order, allowFallbacks: false } : null)) {
      throw new Error('existing bank enrollment is incompatible with this build; do not mix measurements')
    }
  }
  const checkpointPath = join(input.referencesDir, '.checkpoints', `${safeServiceSlug(input.model)}.json`)
  const compatibilityHash = canonicalHashBytes32({
    version: 4,
    model: normalized(input.model),
    endpoint: {
      baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
      sourceId: endpoint.sourceId,
      trust: endpoint.trust,
      antseedPeerId: endpoint.antseedPeerId ?? null,
    },
    modelConfig: {
      service: modelConfig.service,
      upstreamModel: modelConfig.upstreamModel,
      targetRoute,
      contrastModels: modelConfig.contrastModels,
    },
    sizing,
    minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
    sizingAlgorithmVersion: REFERENCE_SIZING_ALGORITHM_VERSION,
    candidateCountPerRound: CANDIDATE_COUNT,
    candidateBatchSize: CANDIDATE_BATCH_SIZE,
    candidatePromptVersion: 3,
    enrollmentBatchingVersion: 2,
    enrollmentStabilityVersion: 2,
    enrollmentEvidenceVersion: 1,
    timeoutMs,
    reasoningStrategy: targetReasoningStrategy,
    routesByModel: [...routesByModel.entries()],
    ...(initial ? { initialReferenceId: initial.referenceId } : {}),
    ...(input.excludedProbeIds ? { excludedProbeIds: canonicalHashBytes32([...input.excludedProbeIds].sort()) } : {}),
    ...(input.seedProbes ? {
      seedProbeIds: canonicalHashBytes32(input.seedProbes.probes.map((probe) => probe.id)),
      seedSource: input.seedProbes.source,
    } : {}),
  })
  const checkpoint = await ReferenceBuildCheckpoint.open(checkpointPath, compatibilityHash)
  const exchangesPath = referenceExchangesPath(input.referencesDir, input.model)
  const query = createReferenceQuery({
    timeoutMs,
    fetchFn: input.fetchFn ?? fetch,
    checkpoint,
    limiter,
    // Discovery requests count toward the same per-build budget.
    maxRequests: Math.max(1, (input.config?.referenceMaxRequestsPerBuild ?? DEFAULT_MAX_REQUESTS_PER_BUILD)
      - (discoveryCheckpoint?.requestsUsed ?? 0)),
    retryCount: input.config?.referenceBatchRetryCount ?? DEFAULT_BATCH_RETRY_COUNT,
    retryBaseDelayMs: input.config?.referenceRetryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    pricingForModel,
    routeForModel: (model) => routesByModel.get(normalized(model))
      ?? resolveReferenceRequestRoute({ endpoint, model, apiKey, catalog: input.catalog ?? null }),
    log: input.log,
  })
  const excludedDomains = new Set<string>(modelConfig.excludedDomains ?? [])
  const retained = initial?.probes.filter((probe) => !excludedDomains.has(probe.domain)) ?? []
  const selfById = new Map(initial?.selfTest.outcomes.map((outcome) => [outcome.probeId, outcome]) ?? [])
  let collected: CollectedReferenceProbes | undefined = initial ? {
    probes: [...retained],
    candidateCount: initial.probes.length,
    distinguishingProbeIdsByModel: new Map(initial.contrasts.map((entry) => [entry.model, [...entry.distinguishingProbeIds]])),
    answeredContrastModelsByProbeId: new Map(retained.map((probe) => [probe.id, [...modelConfig.contrastModels]])),
    generatedProbeIds: new Set(initial.probes.map((probe) => probe.id)),
    reserveProbes: [],
    generationRound: Math.max(0, ...initial.probes.map((probe) => Number(probe.generationRound) || 0)),
  } : undefined
  const selfOutcomes: ReferenceProbeSelfTestV1[] = retained.map((probe) => {
    const outcome = selfById.get(probe.id)
    if (!outcome) throw new Error(`existing bank enrollment lacks a self-test for probe ${probe.id}`)
    return outcome
  })
  if (initial) input.log?.(`reusing ${retained.length} enrolled probes and self-test outcomes; checking every contrast before audit`)
  let seededProbeCount = 0
  if (input.seedProbes) {
    if (initial) throw new Error('seed probes cannot be combined with an existing bank enrollment')
    const seeds = input.seedProbes.probes
      .filter((probe) => !excludedDomains.has(probe.domain))
      .map(({ contrast: _contrast, ...probe }) => probe as KbfProbe)
    input.log?.(`seeding ${seeds.length} previously certified stable probes; re-checking contrasts`)
    const { outcomes, answered } = await queryContrastOutcomes(seeds, modelConfig.contrastModels, query, input.log)
    const reserveProbes = seeds.flatMap((probe) => {
      const distinguishingModels = outcomes.get(probe.id) ?? []
      return modelConfig.contrastModels.length === 0 || distinguishingModels.length > 0
        ? [{ ...probe, ...(distinguishingModels.length > 0 ? { contrast: { distinguishingModels } } : {}) }]
        : []
    })
    seededProbeCount = reserveProbes.length
    input.log?.(`${reserveProbes.length}/${seeds.length} seeded probes distinguish at least one current contrast`)
    collected = {
      probes: [],
      candidateCount: seeds.length,
      distinguishingProbeIdsByModel: new Map(modelConfig.contrastModels.map((model) => [model, [] as string[]])),
      answeredContrastModelsByProbeId: answered,
      generatedProbeIds: new Set(seeds.map((probe) => probe.id)),
      reserveProbes,
      generationRound: Math.max(0, ...seeds.map((probe) => Number(probe.generationRound) || 0)),
    }
  }
  let selected: {
    probes: KbfProbe[]
    selfTest: ReturnType<typeof aggregateKbfSelfTestOutcomes>
    power: ReturnType<typeof computeBinomialPower>
    contrasts: ReferenceContrastV1[]
    contrastDetection: ReferenceContrastDetectionV1[]
  } | null = null
  let undetectedContrasts: string[] = []
  try {
    for (let targetCount = sizing.minimumProbeCount;
      targetCount <= sizing.maximumProbeCount;
      targetCount += sizing.probeStep) {
      collected = await collectReferenceProbes({
        model: modelConfig.upstreamModel,
        contrastModels: modelConfig.contrastModels,
        excludedDomains: modelConfig.excludedDomains,
        targetCount,
        candidateCountPerRound: CANDIDATE_COUNT,
        maxNoProgressRounds: input.config?.referenceMaxNoProgressRounds ?? DEFAULT_MAX_NO_PROGRESS_ROUNDS,
        query,
        log: input.log,
        initial: collected,
        preferredContrastModels: undetectedContrasts,
        excludedProbeIds: input.excludedProbeIds,
      })
      const additions = collected.probes.slice(selfOutcomes.length, targetCount)
      if (additions.length > 0) {
        input.log?.(
          `self-testing ${selfOutcomes.length + 1}-${targetCount} of ${targetCount} probes `
          + `(${selfTestRuns} runs)`,
        )
        selfOutcomes.push(...await querySelfTestOutcomes(
          modelConfig.upstreamModel,
          additions,
          selfTestRuns,
          query,
          input.log,
        ))
      }
      const probes = collected.probes.slice(0, targetCount)
      const selfTest = aggregateKbfSelfTestOutcomes(selfOutcomes.slice(0, targetCount))
      const power = computeBinomialPower({
        selfHamming: selfTest.hamming,
        selfTotal: selfTest.total,
        probeCount: targetCount,
        minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
        alpha: REFERENCE_POWER_ALPHA,
        cpConfidence: REFERENCE_POWER_CONFIDENCE,
      })
      const contrasts = referenceContrasts(modelConfig.contrastModels, collected, probes)
      const contrastDetection = computeContrastDetection({
        probeIds: probes.map((probe) => probe.id),
        contrasts,
        answeredProbeIds: contrastAnsweredProbeIds(modelConfig.contrastModels, collected),
        // p0 comes from the pooled self-test runs, as in the audit verdict.
        selfHamming: selfTest.hamming,
        selfTotal: selfTest.total,
        alpha: REFERENCE_POWER_ALPHA,
        cpConfidence: REFERENCE_POWER_CONFIDENCE,
      })
      // A contrast that answered none of the selected probes (for example, an
      // unavailable model) cannot be tested and does not block the build.
      undetectedContrasts = contrastDetection
        .filter((entry) => entry.total > 0 && !entry.detected)
        .map((entry) => entry.model)
      input.log?.(
        `reference size ${targetCount}: power ${power.power.toFixed(3)}, `
        + `self-test ${selfTest.hamming}/${selfTest.total}, coverage ${selfTest.coverage.toFixed(3)}`
        + (contrastDetection.length > 0
          ? `, contrasts detected ${contrastDetection.length - undetectedContrasts.length}/${contrastDetection.length}`
          : ''),
      )
      if (selfTest.coverage >= 0.8 && selfTest.errorRate <= REFERENCE_MAXIMUM_SELF_TEST_ERROR_RATE
        && power.power >= sizing.minimumStatisticalPower
        && undetectedContrasts.length === 0) {
        selected = { probes, selfTest, power, contrasts, contrastDetection }
        break
      }
    }
  } catch (error) {
    if (!initial && asError(error).message.includes('reference generation made no progress')) await checkpoint.remove()
    throw error
  }
  if (!collected || !selected) {
    throw new Error(
      `reference remains underpowered at ${sizing.maximumProbeCount} probes; `
      + `required power ${sizing.minimumStatisticalPower.toFixed(3)}`
      + (undetectedContrasts.length > 0
        ? `; contrast models that would pass as SAME: ${undetectedContrasts.join(', ')}`
        : ''),
    )
  }
  const { probes, selfTest, power, contrasts, contrastDetection } = selected
  if (selfTest.coverage < 0.8) {
    await checkpoint.remove()
    throw new Error(`self-test coverage ${selfTest.coverage.toFixed(3)} is below 0.8`)
  }
  if (selfTest.errorRate > REFERENCE_MAXIMUM_SELF_TEST_ERROR_RATE) {
    await checkpoint.remove()
    throw new Error(`self-test error rate ${selfTest.errorRate.toFixed(3)} exceeds ${REFERENCE_MAXIMUM_SELF_TEST_ERROR_RATE}`)
  }
  const servedTargetProviders = query.servedProviders?.(modelConfig.upstreamModel) ?? []
  if (!targetRoute.providerRouting && servedTargetProviders.length > 1) {
    input.log?.(
      `warning: reference provider for ${modelConfig.upstreamModel} changed during the build `
      + `(${servedTargetProviders.join(', ')}); pin referenceProvider.order for a reproducible reference`,
    )
  }
  const exchanges = await writeReferenceExchanges({
    path: exchangesPath,
    model: input.model,
    upstream: upstreamProvenance,
    checkpoints: discoveryCheckpoint ? [discoveryCheckpoint, checkpoint] : [checkpoint],
  })
  const reference: KbfReferenceV1 = {
    version: KBF_REFERENCE_VERSION,
    kind: 'kbf',
    referenceId: '',
    referenceModel: input.model,
    serviceAliases: [input.model, ...(modelConfig.serviceAliases ?? [])]
      .map(normalized)
      .filter((service, index, services) => services.indexOf(service) === index),
    createdAt: new Date().toISOString(),
    source: 'generated',
    generator: {
      name: 'antseed-simple-reference-builder',
      version: REFERENCE_BUILDER_VERSION,
      verifierKind: 'kbf',
      params: {
        sourceId: endpoint.sourceId,
        upstreamModel: modelConfig.upstreamModel,
        referenceRoute: targetRoute.type === 'antseed' ? {
          type: targetRoute.type,
          baseUrl: targetRoute.baseUrl,
          service: targetRoute.model,
          peerId: targetRoute.peerId,
        } : undefined,
        excludedDomains: [...(modelConfig.excludedDomains ?? [])],
        candidateCount: collected.candidateCount,
        sizing,
        sizingAlgorithmVersion: REFERENCE_SIZING_ALGORITHM_VERSION,
        enrollmentBatchingVersion: 2,
        enrollmentStabilityVersion: 2,
        enrollmentEvidenceVersion: 1,
        selfTestRuns,
        referenceEndpointRequest,
        ...(thinkingDiscovery ?? initialDiscovery ? { thinkingDiscovery: thinkingDiscovery ?? initialDiscovery } : {}),
        ...(initial ? { enrollmentSeedReferenceId: initial.referenceId, reusedProbeCount: retained.length } : {}),
        ...(input.seedProbes ? {
          seededStableProbes: { ...input.seedProbes.source, offeredProbeCount: input.seedProbes.probes.length, acceptedProbeCount: seededProbeCount },
        } : {}),
        ...(targetRoute.type === 'direct' ? {
          referenceProvider: {
            pinned: targetRoute.providerRouting
              ? { order: [...targetRoute.providerRouting.order], allowFallbacks: false }
              : null,
            served: servedTargetProviders,
          },
        } : {}),
      },
    },
    provenance: {
      sourceId: referenceSourceId(endpoint, targetRoute),
      trust: endpoint.trust,
      upstream: upstreamProvenance,
    },
    queryProfile,
    selfTest,
    probes,
    selectedProbeCount: probes.length,
    minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: REFERENCE_POWER_ALPHA,
      clopperPearsonConfidence: REFERENCE_POWER_CONFIDENCE,
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      probeCount: probes.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts,
    contrastDetection,
  }
  reference.referenceId = computeReferenceId(reference)
  const validated = validateKbfReferenceV1(reference, {
    minimumStatisticalPower: sizing.minimumStatisticalPower,
  })
  const path = referencePath(input.referencesDir, input.model)
  await writeJsonAtomic(path, validated)
  const cost = summarizeReferenceCosts([
    ...(discoveryQuery?.consumedResponses?.() ?? []),
    ...(query.consumedResponses?.() ?? []),
  ])
  const answeredContrastModelsByProbeId = new Map(validated.probes.map((probe) => [
    probe.id,
    [...(collected.answeredContrastModelsByProbeId?.get(probe.id) ?? modelConfig.contrastModels)],
  ]))
  return {
    reference: validated,
    path,
    exchanges,
    cost,
    answeredContrastModelsByProbeId,
    finalize: async () => {
      await checkpoint.remove()
      await discoveryCheckpoint?.remove()
    },
  }
}

function referenceContrasts(
  contrastModels: readonly string[],
  collected: CollectedReferenceProbes,
  probes: readonly KbfProbe[],
): ReferenceContrastV1[] {
  const selectedIds = new Set(probes.map((probe) => probe.id))
  return contrastModels.map((model) => ({
    model,
    distinguishingProbeIds: (collected.distinguishingProbeIdsByModel.get(model) ?? [])
      .filter((probeId) => selectedIds.has(probeId)),
  }))
}

function contrastAnsweredProbeIds(
  contrastModels: readonly string[],
  collected: CollectedReferenceProbes,
): Map<string, Set<string>> {
  const answered = new Map(contrastModels.map((model) => [model, new Set<string>()]))
  for (const [probeId, models] of collected.answeredContrastModelsByProbeId ?? []) {
    for (const model of models) answered.get(model)?.add(probeId)
  }
  return answered
}

export async function collectReferenceProbes(input: {
  model: string
  contrastModels: readonly string[]
  excludedDomains?: readonly string[]
  targetCount: number
  query: ReferenceQuery
  candidateCountPerRound?: number
  maxNoProgressRounds?: number
  log?: (message: string) => void
  initial?: CollectedReferenceProbes
  preferredContrastModels?: readonly string[]
  shuffle?: <T>(values: readonly T[]) => T[]
  excludedProbeIds?: ReadonlySet<string>
}): Promise<CollectedReferenceProbes> {
  assertPositiveInteger(input.targetCount, 'targetCount')
  const candidateCountPerRound = input.candidateCountPerRound ?? Math.max(CANDIDATE_COUNT, input.targetCount * 3)
  const maxNoProgressRounds = input.maxNoProgressRounds ?? DEFAULT_MAX_NO_PROGRESS_ROUNDS
  assertPositiveInteger(candidateCountPerRound, 'candidateCountPerRound')
  assertPositiveInteger(maxNoProgressRounds, 'maxNoProgressRounds')

  const state = input.initial ?? {
    probes: [],
    candidateCount: 0,
    distinguishingProbeIdsByModel: new Map(input.contrastModels.map((model) => [model, [] as string[]])),
    answeredContrastModelsByProbeId: new Map<string, string[]>(),
    generatedProbeIds: new Set<string>(),
    reserveProbes: [],
    generationRound: 0,
  }
  const promote = (probe: KbfProbe): void => {
    state.probes.push(probe)
    const distinguishingModels = (probe.contrast as { distinguishingModels?: string[] } | undefined)
      ?.distinguishingModels ?? []
    for (const model of distinguishingModels) state.distinguishingProbeIdsByModel.get(model)?.push(probe.id)
  }
  const priority = (probe: KbfProbe): number => {
    const models = (probe.contrast as { distinguishingModels?: string[] } | undefined)?.distinguishingModels ?? []
    return input.preferredContrastModels?.filter((model) => models.includes(model)).length ?? 0
  }
  state.reserveProbes.sort((left, right) => priority(right) - priority(left))
  while (state.probes.length < input.targetCount && state.reserveProbes.length > 0) promote(state.reserveProbes.shift()!)
  let noProgressRounds = 0

  while (state.probes.length < input.targetCount) {
    state.generationRound += 1
    input.log?.(`generation round ${state.generationRound}: collecting ${state.probes.length}/${input.targetCount} probes`)
    const generated = await generateCandidates(
      input.model,
      candidateCountPerRound,
      state.generationRound,
      input.query,
      input.excludedDomains,
      input.log,
    )
    const candidates = generated.filter((probe) => {
      if (state.generatedProbeIds.has(probe.id) || input.excludedProbeIds?.has(probe.id)) return false
      state.generatedProbeIds.add(probe.id)
      return true
    })
    state.candidateCount = state.generatedProbeIds.size
    input.log?.(`generation round ${state.generationRound}: testing ${candidates.length} new candidates for stability`)
    const stable = await certifyStableProbes(input.model, candidates, input.query, input.log, input.shuffle)
    const { outcomes: contrastOutcomes, answered: contrastAnswered } = await queryContrastOutcomes(
      stable,
      input.contrastModels,
      input.query,
      input.log,
    )
    state.answeredContrastModelsByProbeId ??= new Map()
    for (const [probeId, models] of contrastAnswered) state.answeredContrastModelsByProbeId.set(probeId, models)
    const accepted = stable.filter((probe) => input.contrastModels.length === 0
      || (contrastOutcomes.get(probe.id)?.length ?? 0) > 0)
    const prepared = accepted.map((probe) => {
      const distinguishingModels = contrastOutcomes.get(probe.id) ?? []
      return {
        ...probe,
        ...(distinguishingModels.length > 0 ? { contrast: { distinguishingModels } } : {}),
      }
    })
    prepared.sort((left, right) => priority(right) - priority(left))
    const selected = prepared.slice(0, input.targetCount - state.probes.length)
    for (const probe of selected) promote(probe)
    state.reserveProbes.push(...prepared.slice(selected.length))
    input.log?.(
      `generation round ${state.generationRound}: ${stable.length} stable, ${accepted.length} distinguish at least one contrast, `
      + `${state.probes.length}/${input.targetCount} selected`,
    )
    if (selected.length === 0) {
      noProgressRounds += 1
      if (noProgressRounds >= maxNoProgressRounds) {
        throw new Error(
          `reference generation made no progress for ${noProgressRounds} rounds; `
          + `collected ${state.probes.length}/${input.targetCount} probes from ${state.generatedProbeIds.size} unique candidates`,
        )
      }
    } else {
      noProgressRounds = 0
    }
  }

  return state
}

async function certifyStableProbes(
  model: string,
  candidates: readonly KbfProbe[],
  query: ReferenceQuery,
  log?: (message: string) => void,
  shuffle?: <T>(values: readonly T[]) => T[],
): Promise<KbfProbe[]> {
  if (candidates.length === 0) return []
  const passes = await allSettledOrThrow(KBF_ENROLLMENT_TEMPERATURES.map((temperature, passIndex) => {
    const passShuffle = shuffle ?? deterministicShuffle(`stability-${passIndex}`)
    return queryDomainGroupedProbeAnswers(
      model,
      candidates,
      temperature,
      `stability-${passIndex}`,
      query,
      log,
      passShuffle,
    )
  }))
  return candidates.flatMap((probe, index) => {
    const values = passes.map((pass) => pass[index] ?? null).filter((value): value is number => value !== null)
    if (values.length !== passes.length) return []
    const consensus = stableConsensus(values, probe)
    if (consensus === null) return []
    if (consensus < probe.range[0] || consensus > probe.range[1]) return []
    const tolerance = canonicalKbfTolerance(probe.domain)
    return [{
      ...probe,
      consensus,
      tolerance,
      enrollmentEvidence: {
        temperatures: [...KBF_ENROLLMENT_TEMPERATURES],
        answers: values,
        rule: tolerance.mode === 'absolute'
          ? 'rounded-exact-agreement'
          : 'relative-maximum-deviation-2-percent',
      },
    }]
  })
}

function stableConsensus(values: readonly number[], probe: KbfProbe): number | null {
  const tolerance = CANONICAL_KBF_DOMAINS.some((definition) => definition.key === probe.domain)
    ? canonicalKbfTolerance(probe.domain)
    : probe.tolerance
  if (tolerance.mode === 'absolute') {
    const rounded = values.map(roundHalfToEven)
    if (!rounded.every((value) => value === rounded[0])) return null
    const consensus = rounded[0]!
    return matchesTolerance(values[0]!, { ...probe, consensus, tolerance }) ? consensus : null
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (mean === 0) return null
  const maximumRelativeSpread = Math.max(...values.map((value) => Math.abs(value - mean) / Math.abs(mean)))
  if (maximumRelativeSpread > 0.02) return null
  const consensus = Math.round(mean * 10_000) / 10_000
  return matchesTolerance(values[0]!, { ...probe, consensus, tolerance }) ? consensus : null
}

function roundHalfToEven(value: number): number {
  const lower = Math.floor(value)
  const fraction = value - lower
  if (fraction < 0.5) return lower
  if (fraction > 0.5) return lower + 1
  return lower % 2 === 0 ? lower : lower + 1
}

async function queryDomainGroupedProbeAnswers(
  model: string,
  probes: readonly KbfProbe[],
  temperature: number,
  cacheDomain: string,
  query: ReferenceQuery,
  log?: (message: string) => void,
  shuffle?: <T>(values: readonly T[]) => T[],
  options: { allowIncomplete?: boolean; recoverTerminalEmptyBatches?: boolean } = {},
): Promise<Array<number | null>> {
  const answers = new Array<number | null>(probes.length).fill(null)
  const batches = createDomainHomogeneousKbfBatches(probes, KBF_PROBES_PER_REQUEST, shuffle)
  const queryBatch = async (batch: (typeof batches)[number]): Promise<void> => {
    const domainAnswers = await queryProbeAnswers(model, batch.probes, temperature, cacheDomain, query, {
      recoverTerminalEmptyBatches: options.recoverTerminalEmptyBatches ?? true,
      stabilityDomain: batch.probes[0]?.domain,
      log,
    })
    for (const [groupIndex, originalIndex] of batch.indexes.entries()) {
      answers[originalIndex] = domainAnswers[groupIndex] ?? null
    }
  }
  if (options.allowIncomplete) {
    let answeredBatches = 0
    let consecutiveEmptyBatches = 0
    for (const batch of batches) {
      let lastError: unknown = null
      for (let attempt = 0; attempt <= CONTRAST_EMPTY_BATCH_RETRIES; attempt += 1) {
        try {
          const domainAnswers = await queryProbeAnswers(
            model,
            batch.probes,
            temperature,
            attempt === 0 ? cacheDomain : `${cacheDomain}:empty-retry-${attempt}`,
            query,
            { recoverTerminalEmptyBatches: false, stabilityDomain: batch.probes[0]?.domain, log },
          )
          for (const [groupIndex, originalIndex] of batch.indexes.entries()) {
            answers[originalIndex] = domainAnswers[groupIndex] ?? null
          }
          lastError = null
          break
        } catch (error) {
          if (!isRecoverableContrastError(error)) throw error
          lastError = error
          if (!isTerminalEmptyReferenceError(error)) break
        }
      }
      if (lastError === null) {
        answeredBatches += 1
        consecutiveEmptyBatches = 0
        continue
      }
      consecutiveEmptyBatches += 1
      if (!isTerminalEmptyReferenceError(lastError) || answeredBatches === 0
        || consecutiveEmptyBatches >= CONTRAST_MAX_CONSECUTIVE_EMPTY_BATCHES) {
        log?.(`contrast model ${model} unavailable; skipping remaining probe answers: ${asError(lastError).message}`)
        break
      }
      log?.(
        `contrast model ${model} returned no text for a ${batch.probes.length}-probe batch after `
        + `${CONTRAST_EMPTY_BATCH_RETRIES + 1} attempts; continuing with the next batch`,
      )
    }
  } else {
    await allSettledOrThrow(batches.map(queryBatch))
  }
  return answers
}

async function queryContrastOutcomes(
  probes: readonly KbfProbe[],
  contrastModels: readonly string[],
  query: ReferenceQuery,
  log?: (message: string) => void,
): Promise<{ outcomes: Map<string, string[]>; answered: Map<string, string[]> }> {
  const outcomes = new Map(probes.map((probe) => [probe.id, [] as string[]]))
  const answered = new Map(probes.map((probe) => [probe.id, [] as string[]]))
  const answersByModel = await allSettledOrThrow(contrastModels.map(async (contrastModel) => {
    log?.(`checking contrast model ${contrastModel}`)
    return queryDomainGroupedProbeAnswers(
      contrastModel,
      probes,
      0,
      `contrast-${contrastModel}`,
      query,
      log,
      identityShuffle,
      { allowIncomplete: true, recoverTerminalEmptyBatches: false },
    )
  }))
  for (const [modelIndex, contrastModel] of contrastModels.entries()) {
    const answers = answersByModel[modelIndex]!
    for (const [index, probe] of probes.entries()) {
      const answer = answers[index] ?? null
      if (answer !== null) answered.get(probe.id)!.push(contrastModel)
      if (answer !== null && !matchesTolerance(answer, probe)) outcomes.get(probe.id)!.push(contrastModel)
    }
  }
  return { outcomes, answered }
}

async function generateCandidates(
  model: string,
  count: number,
  round: number,
  query: ReferenceQuery,
  excludedDomains: readonly string[] = [],
  log?: (message: string) => void,
): Promise<KbfProbe[]> {
  const excluded = new Set(excludedDomains)
  const activeDomains = CANONICAL_KBF_DOMAINS.filter((definition) => !excluded.has(definition.key))
  if (activeDomains.length === 0) throw new Error('reference generation requires at least one enabled canonical KBF domain')
  const baseCount = Math.floor(count / activeDomains.length)
  const remainder = count % activeDomains.length
  const generatedByDomain = await allSettledOrThrow(activeDomains.map(async (definition, domainIndex) => {
    const countPerDomain = baseCount + (domainIndex < remainder ? 1 : 0)
    if (countPerDomain === 0) return []
    const probes: KbfProbe[] = []
    const seen = new Set<string>()
    for (let offset = 0; offset < countPerDomain; offset += CANDIDATE_BATCH_SIZE) {
      const batchSize = Math.min(CANDIDATE_BATCH_SIZE, countPerDomain - offset)
      const theme = definition.themes[(round + domainIndex - 1) % definition.themes.length]!
      const batch = offset / CANDIDATE_BATCH_SIZE + 1
      const prompt = canonicalCandidatePrompt(definition, batchSize, round, batch, theme)
      const body = {
        model,
        temperature: 0.7,
        max_tokens: 6000,
        messages: [
          { role: 'system', content: 'Create stable numeric factual-recall probes. Output only the requested list.' },
          { role: 'user', content: prompt },
        ],
      }
      let content: string
      try {
        content = await query(model, body)
      } catch (error) {
        // A candidate batch only proposes questions; nothing is measured from it. A batch that
        // stays empty, or keeps timing out or failing upstream after its retries, is skipped and
        // the next generation round makes up the shortfall (bounded by the no-progress limit).
        if (error instanceof EmptyReferenceResponseError) {
          log?.(`skipping empty candidate batch for ${definition.key}: ${error.message}`)
          continue
        }
        if (!isRetryableReferenceError(error)) throw error
        log?.(`skipping failed candidate batch for ${definition.key} after retries: ${asError(error).message}`)
        continue
      }
      for (const fact of parseCanonicalFacts(content, definition.range)) {
        const probe = createCanonicalKbfProbe({
          domainKey: definition.key,
          name: fact.name,
          consensus: fact.value,
          generationRound: round,
          generationTheme: theme,
        })
        if (!seen.has(probe.id)) {
          seen.add(probe.id)
          probes.push(probe)
        }
      }
    }
    return probes
  }))
  const probes: KbfProbe[] = []
  for (let index = 0; probes.length < count; index += 1) {
    let added = false
    for (const domainProbes of generatedByDomain) {
      const probe = domainProbes[index]
      if (!probe) continue
      probes.push(probe)
      added = true
      if (probes.length >= count) break
    }
    if (!added) break
  }
  return probes
}

function canonicalCandidatePrompt(
  definition: (typeof CANONICAL_KBF_DOMAINS)[number],
  count: number,
  round: number,
  batch: number,
  theme: string,
): string {
  return [
    `Generate exactly ${count} facts in canonical KBF domain ${definition.key} for generation round ${round}, batch ${batch}.`,
    `List ${definition.generationSubject}.`,
    `Focus on: ${theme}.`,
    difficultyInstruction(round),
    'Use only facts with one stable, defensible, finite numeric answer.',
    'Put units and scale in the fact name so the answer is only the number.',
    'Format every line exactly as: fact_name | numeric_value',
    'Output only the list. Do not choose a range or tolerance.',
  ].join('\n')
}

function difficultyInstruction(round: number): string {
  if (round <= 1) return 'Choose specialist-level facts and avoid textbook examples.'
  if (round === 2) return 'Choose very obscure facts unlikely to appear in general references.'
  return 'Choose frontier-obscure facts from specialist reference material.'
}

function parseCanonicalFacts(text: string, range: readonly [number, number]): Array<{ name: string; value: number }> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Array<{ name?: unknown; consensus?: unknown; value?: unknown }>
      return parsed.flatMap((entry) => {
        const value = typeof entry.consensus === 'number' ? entry.consensus : entry.value
        return typeof entry.name === 'string'
          && entry.name.trim().length > 0
          && entry.name.length <= 240
          && typeof value === 'number'
          && Number.isFinite(value)
          && value >= range[0]
          && value <= range[1]
          ? [{ name: entry.name.trim(), value }]
          : []
      })
    } catch {
      return []
    }
  }
  const facts: Array<{ name: string; value: number }> = []
  for (const rawLine of text.replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n')) {
    const line = rawLine.trim().replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, '')
    const separator = line.lastIndexOf('|')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().replaceAll('**', '')
    const numeric = line.slice(separator + 1).trim().replace(/[,_\s]/g, '').replace(/[−–]/g, '-')
    if (!name || name.length > 240 || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(numeric)) continue
    const value = Number(numeric)
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) continue
    facts.push({ name, value })
  }
  return facts
}

function createReferenceQuery(input: {
  timeoutMs: number
  fetchFn: typeof fetch
  checkpoint: ReferenceBuildCheckpoint
    limiter: ReferenceRequestLimiter
  maxRequests: number
  retryCount: number
  retryBaseDelayMs: number
  pricingForModel: (model: string) => VerifierModelPricingConfig
  routeForModel: (model: string) => ReferenceRequestRoute
  log?: (message: string) => void
}): ReferenceQuery {
  assertPositiveInteger(input.maxRequests, 'referenceMaxRequestsPerBuild')
  assertNonNegativeInteger(input.retryCount, 'referenceBatchRetryCount')
  assertPositiveInteger(input.retryBaseDelayMs, 'referenceRetryBaseDelayMs')
  const consumed = new Map<string, ReferenceCachedResponseV1>()
  const providersByModel = new Map<string, string[]>()
  const recordProvider = (model: string, provider: string | null | undefined): void => {
    if (!provider) return
    const key = normalized(model)
    const seen = providersByModel.get(key) ?? []
    if (seen.includes(provider)) return
    if (seen.length > 0) {
      input.log?.(
        `warning: reference provider for ${model} changed mid-build from ${seen.at(-1)} to ${provider}`,
      )
    }
    seen.push(provider)
    providersByModel.set(key, seen)
  }
  const query = (async (model: string, body: Record<string, unknown>) => {
    const { __antseedReferenceCacheDomain, ...requestBody } = body
    const route = input.routeForModel(model)
    const cacheKey = canonicalHashBytes32({
      model,
      cacheDomain: __antseedReferenceCacheDomain ?? null,
      body: requestBody,
      route,
    })
    const cached = input.checkpoint.get(cacheKey)
    if (cached !== undefined) {
      consumed.set(cacheKey, cached)
      recordProvider(model, cached.provider)
      if (cached.outcome === 'terminal-empty') {
        throw new EmptyReferenceResponseError(
          cached.finishReason,
          cached.nativeFinishReason,
          cached.detail,
          cached.inputTokens,
          cached.outputTokens,
        )
      }
      return cached.content
    }
    let attempt = 0
    for (;;) {
      attempt += 1
      await input.checkpoint.reserveRequest(input.maxRequests)
      try {
        const response = await input.limiter.run(model, () => postChatCompletion(
          route,
          requestBody,
          referenceRequestPurpose(__antseedReferenceCacheDomain) === 'candidate-generation'
            ? Math.max(input.timeoutMs, CANDIDATE_GENERATION_TIMEOUT_MS)
            : input.timeoutMs,
          input.fetchFn,
        ))
        const pricing = input.pricingForModel(model)
        const cachedResponse: ReferenceCachedSuccessV1 = {
          outcome: 'success',
          content: response.content,
          model,
          ...(response.provider ? { provider: response.provider } : {}),
          purpose: referenceRequestPurpose(__antseedReferenceCacheDomain),
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          inputUsdPerMillion: pricing.inputUsdPerMillion,
          outputUsdPerMillion: pricing.outputUsdPerMillion,
          costUsdMicros: String(Math.ceil(
            response.inputTokens * pricing.inputUsdPerMillion
            + response.outputTokens * pricing.outputUsdPerMillion,
          )),
        }
        await input.checkpoint.appendExchange({
          cacheKey,
          model,
          purpose: cachedResponse.purpose,
          ...response.exchange,
          receivedAt: new Date().toISOString(),
        })
        await input.checkpoint.set(cacheKey, cachedResponse)
        consumed.set(cacheKey, cachedResponse)
        recordProvider(model, response.provider)
        input.limiter.recordSuccess(model)
        return response.content
      } catch (error) {
        if (isTerminalEmptyReferenceError(error)) {
          const pricing = input.pricingForModel(model)
          const cachedResponse: ReferenceCachedTerminalEmptyV1 = {
            outcome: 'terminal-empty',
            model,
            purpose: referenceRequestPurpose(__antseedReferenceCacheDomain),
            finishReason: error.finishReason,
            nativeFinishReason: error.nativeFinishReason,
            detail: error.detail,
            inputTokens: error.inputTokens,
            outputTokens: error.outputTokens,
            inputUsdPerMillion: pricing.inputUsdPerMillion,
            outputUsdPerMillion: pricing.outputUsdPerMillion,
            costUsdMicros: String(Math.ceil(
              error.inputTokens * pricing.inputUsdPerMillion
              + error.outputTokens * pricing.outputUsdPerMillion,
            )),
          }
          if (error.exchange) {
            await input.checkpoint.appendExchange({
              cacheKey,
              model,
              purpose: cachedResponse.purpose,
              ...error.exchange,
              receivedAt: new Date().toISOString(),
            })
          }
          await input.checkpoint.set(cacheKey, cachedResponse)
          consumed.set(cacheKey, cachedResponse)
        }
        const retryable = isRetryableReferenceError(error)
        if (!retryable || attempt >= input.retryCount + 1) throw error
        const delayMs = retryDelayMs(error, input.retryBaseDelayMs, attempt)
        input.log?.(`reference request retry ${attempt}/${input.retryCount + 1} for ${model} in ${delayMs}ms: ${asError(error).message}`)
        await sleep(delayMs)
      }
    }
  }) as ReferenceQuery
  query.invalidate = async (model, body) => {
    const { __antseedReferenceCacheDomain, ...requestBody } = body
    const cacheKey = canonicalHashBytes32({
      model,
      cacheDomain: __antseedReferenceCacheDomain ?? null,
      body: requestBody,
      route: input.routeForModel(model),
    })
    consumed.delete(cacheKey)
    await input.checkpoint.delete(cacheKey)
  }
  query.costSummary = () => summarizeReferenceCosts([...consumed.values()])
  query.consumedResponses = () => [...consumed.values()]
  query.probeThinking = async (model, route, maxTokens) => {
    const body = {
      ...buildKbfChatRequestBody(model, THINKING_DISCOVERY_PROBES, { maxTokens }),
      temperature: 0,
    }
    const cacheKey = canonicalHashBytes32({ model, cacheDomain: 'thinking-discovery', body, route })
    const cached = input.checkpoint.get(cacheKey)
    if (cached !== undefined) {
      consumed.set(cacheKey, cached)
      return {
        ok: true,
        content: cached.outcome === 'terminal-empty' ? null : cached.content,
        reasoningTokens: cached.reasoningTokens ?? 0,
      }
    }
    // As in the reference code: 429 waits, 5xx and network errors retry up to three
    // times, and any other 4xx means this strategy is refused.
    let failure: { status: number | null; failure: string } = { status: null, failure: 'not attempted' }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await input.checkpoint.reserveRequest(input.maxRequests)
      try {
        const response = await input.limiter.run(model, () => postChatCompletion(route, body, input.timeoutMs, input.fetchFn))
        const success: ReferenceCachedSuccessV1 = {
          outcome: 'success',
          ...cachedCost(model, 'thinking-discovery', response.inputTokens, response.outputTokens),
          content: response.content,
          reasoningTokens: response.reasoningTokens ?? 0,
          ...(response.provider ? { provider: response.provider } : {}),
        }
        await input.checkpoint.appendExchange({
          cacheKey, model, purpose: 'thinking-discovery', ...response.exchange, receivedAt: new Date().toISOString(),
        })
        await input.checkpoint.set(cacheKey, success)
        consumed.set(cacheKey, success)
        return { ok: true, content: response.content, reasoningTokens: response.reasoningTokens ?? 0 }
      } catch (error) {
        if (error instanceof EmptyReferenceResponseError) {
          const empty: ReferenceCachedTerminalEmptyV1 = {
            outcome: 'terminal-empty',
            ...cachedCost(model, 'thinking-discovery', error.inputTokens, error.outputTokens),
            finishReason: error.finishReason,
            nativeFinishReason: error.nativeFinishReason,
            detail: error.detail,
            reasoningTokens: error.reasoningTokens ?? 0,
          }
          if (error.exchange) {
            await input.checkpoint.appendExchange({
              cacheKey, model, purpose: 'thinking-discovery', ...error.exchange, receivedAt: new Date().toISOString(),
            })
          }
          await input.checkpoint.set(cacheKey, empty)
          consumed.set(cacheKey, empty)
          return { ok: true, content: null, reasoningTokens: error.reasoningTokens ?? 0 }
        }
        if (error instanceof ReferenceEndpointError) {
          failure = { status: error.status, failure: error.detail }
          if (error.status !== 429 && error.status < 500) return { ok: false, ...failure }
        } else {
          failure = { status: null, failure: asError(error).message }
        }
        if (attempt < 3) {
          await sleep(isThrottleError(error) ? retryDelayMs(error, 5_000 * attempt, 1) : Math.min(30_000, input.retryBaseDelayMs * 3 * attempt))
        }
      }
    }
    return { ok: false, ...failure }
  }
  const cachedCost = (
    model: string,
    purpose: ReferenceBuildCostPurposeV1['purpose'],
    inputTokens: number,
    outputTokens: number,
  ): ReferenceCachedResponseBaseV1 => {
    const pricing = input.pricingForModel(model)
    return {
      model,
      purpose,
      inputTokens,
      outputTokens,
      inputUsdPerMillion: pricing.inputUsdPerMillion,
      outputUsdPerMillion: pricing.outputUsdPerMillion,
      costUsdMicros: String(Math.ceil(inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion)),
    }
  }
  query.servedProviders = (model) => [...(providersByModel.get(normalized(model)) ?? [])]
  return query
}

export class ReferenceBuildCheckpoint {
  private saveChain = Promise.resolve()

  private exchangeChain = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly value: ReferenceBuildCheckpointV1,
  ) {}

  /**
   * Raw exchanges live in a JSONL sidecar so the checkpoint itself stays small. It records
   * every answered request (failed HTTP calls are not recorded), including ones later retried.
   */
  get exchangesPath(): string {
    return this.path.replace(/\.json$/, '') + '.exchanges.jsonl'
  }

  static async open(path: string, compatibilityHash: string): Promise<ReferenceBuildCheckpoint> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ReferenceBuildCheckpointV1>
      if (parsed.version === 1
        && parsed.kind === 'antseed-reference-build-checkpoint'
        && parsed.compatibilityHash === compatibilityHash
        && Number.isInteger(parsed.requestsUsed)
        && parsed.requestsUsed! >= 0
        && parsed.responses
        && typeof parsed.responses === 'object'
        && Object.values(parsed.responses).every(isReferenceCachedResponse)) {
        return new ReferenceBuildCheckpoint(path, parsed as ReferenceBuildCheckpointV1)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const checkpoint = new ReferenceBuildCheckpoint(path, {
      version: 1,
      kind: 'antseed-reference-build-checkpoint',
      compatibilityHash,
      requestsUsed: 0,
      responses: {},
    })
    await removeIfExists(checkpoint.exchangesPath)
    await checkpoint.save()
    return checkpoint
  }

  get(key: string): ReferenceCachedResponseV1 | undefined {
    return this.value.responses[key]
  }

  async reserveRequest(maxRequests: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.value.requestsUsed >= maxRequests) {
        throw new Error(`reference build request budget exhausted (${maxRequests})`)
      }
      this.value.requestsUsed += 1
      await writeJsonAtomic(this.path, this.value)
    })
  }

  async set(key: string, response: ReferenceCachedResponseV1): Promise<void> {
    this.value.responses[key] = response
    await this.save()
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.value.responses)) return
    delete this.value.responses[key]
    await this.save()
  }

  get requestsUsed(): number {
    return this.value.requestsUsed
  }

  async appendExchange(exchange: ReferenceExchangeV1): Promise<void> {
    const run = this.exchangeChain.then(async () => {
      await mkdir(dirname(this.exchangesPath), { recursive: true })
      await appendFile(this.exchangesPath, `${JSON.stringify(exchange)}\n`, 'utf8')
    })
    this.exchangeChain = run.catch(() => {})
    await run
  }

  /** Every exchange this build recorded, in the order received. */
  async readExchanges(): Promise<ReferenceExchangeV1[]> {
    await this.exchangeChain
    const exchanges: ReferenceExchangeV1[] = []
    let raw: string
    try {
      raw = await readFile(this.exchangesPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return exchanges
      throw error
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const exchange = JSON.parse(line) as ReferenceExchangeV1
        if (typeof exchange.cacheKey === 'string') exchanges.push(exchange)
      } catch {
        // A crash can leave a torn last line; that response is simply not published.
      }
    }
    return exchanges
  }

  async remove(): Promise<void> {
    await removeIfExists(this.path)
    await this.exchangeChain
    await removeIfExists(this.exchangesPath)
  }

  private async save(): Promise<void> {
    await this.enqueue(() => writeJsonAtomic(this.path, this.value))
  }

  /**
   * Serialize writes. Each task runs after the previous one settles, so a
   * failed write is reported to its own caller without poisoning the chain.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.saveChain.then(task)
    this.saveChain = run.catch(() => {})
    return run
  }
}

class AdaptiveRequestLimiter implements ReferenceRequestLimiter {
  private active = 0
  private limit: number
  private successesSinceThrottle = 0
  private readonly activeByModel = new Map<string, number>()
  private readonly maximumByModelOverride = new Map<string, number>()
  private readonly minimumIntervalMsByModel = new Map<string, number>()
  private readonly nextAllowedAtByModel = new Map<string, number>()
  private readonly waiters: Array<{ model: string; resolve: () => void }> = []
  private wakeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly maximum: number,
    private readonly maximumPerModel: number,
    private readonly newAccountMinimumRequestIntervalMs: number,
    private readonly newAccountRateLimitCooldownMs: number,
  ) {
    assertPositiveInteger(maximum, 'referenceMaxConcurrentRequests')
    assertPositiveInteger(maximumPerModel, 'referenceMaxConcurrentRequestsPerModel')
    assertPositiveInteger(newAccountMinimumRequestIntervalMs, 'newAccountMinimumRequestIntervalMs')
    assertPositiveInteger(newAccountRateLimitCooldownMs, 'newAccountRateLimitCooldownMs')
    this.limit = maximum
  }

  async run<T>(model: string, execute: () => Promise<T>): Promise<T> {
    await this.acquire(model)
    try {
      return await execute()
    } catch (error) {
      throw this.recordThrottle(error, model)
    } finally {
      this.active -= 1
      this.activeByModel.set(model, (this.activeByModel.get(model) ?? 1) - 1)
      this.drain()
    }
  }

  private recordThrottle(error: unknown, model: string): unknown {
    if (!isThrottleError(error)) return error
    this.limit = Math.max(1, Math.floor(this.limit / 2))
    this.successesSinceThrottle = 0
    if (isNewAccountRateLimit(error)) {
      const cooldownMs = Math.max(error.retryAfterMs ?? 0, this.newAccountRateLimitCooldownMs)
      this.maximumByModelOverride.set(model, 1)
      this.minimumIntervalMsByModel.set(model, this.newAccountMinimumRequestIntervalMs)
      this.nextAllowedAtByModel.set(
        model,
        Math.max(this.nextAllowedAtByModel.get(model) ?? 0, Date.now() + cooldownMs),
      )
      return new ReferenceEndpointError(error.status, cooldownMs, error.detail)
    }
    return error
  }

  recordSuccess(_model: string): void {
    this.successesSinceThrottle += 1
    if (this.limit < this.maximum && this.successesSinceThrottle >= this.limit * 10) {
      this.limit += 1
      this.successesSinceThrottle = 0
      this.drain()
    }
  }

  private async acquire(model: string): Promise<void> {
    if (this.canRun(model)) {
      this.reserve(model)
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ model, resolve })
      this.scheduleDrain()
    })
  }

  private drain(): void {
    while (this.active < this.limit) {
      const index = this.waiters.findIndex(({ model }) => this.canRun(model))
      if (index < 0) {
        this.scheduleDrain()
        return
      }
      const waiter = this.waiters.splice(index, 1)[0]!
      this.reserve(waiter.model)
      waiter.resolve()
    }
    this.scheduleDrain()
  }

  private canRun(model: string): boolean {
    const maximumPerModel = this.maximumByModelOverride.get(model) ?? this.maximumPerModel
    return this.active < this.limit
      && (this.activeByModel.get(model) ?? 0) < maximumPerModel
      && Date.now() >= (this.nextAllowedAtByModel.get(model) ?? 0)
  }

  private reserve(model: string): void {
    this.active += 1
    this.activeByModel.set(model, (this.activeByModel.get(model) ?? 0) + 1)
    const minimumIntervalMs = this.minimumIntervalMsByModel.get(model)
    if (minimumIntervalMs !== undefined) this.nextAllowedAtByModel.set(model, Date.now() + minimumIntervalMs)
  }

  private scheduleDrain(): void {
    if (this.wakeTimer !== null || this.waiters.length === 0) return
    const now = Date.now()
    const delayMs = Math.min(...this.waiters.map(({ model }) => Math.max(
      0,
      (this.nextAllowedAtByModel.get(model) ?? now) - now,
    )))
    if (delayMs <= 0) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.drain()
    }, delayMs)
  }
}

async function queryProbeAnswers(
  model: string,
  probes: readonly KbfProbe[],
  temperature: number,
  cacheDomain: string,
  query: (model: string, body: Record<string, unknown>) => Promise<string>,
  options: {
    recoverTerminalEmptyBatches?: boolean
    stabilityDomain?: string
    log?: (message: string) => void
    variantId?: string
  } = {},
): Promise<Array<number | null>> {
  const answers: Array<number | null> = []
  for (let offset = 0; offset < probes.length; offset += KBF_PROBES_PER_REQUEST) {
    const batch = probes.slice(offset, offset + KBF_PROBES_PER_REQUEST)
    const body = {
      ...buildKbfChatRequestBody(model, batch, { maxTokens: MAX_TOKENS, variantId: options.variantId }),
      // No top_p, matching audits and the KBF reference code.
      temperature,
      __antseedReferenceCacheDomain: cacheDomain,
    }
    try {
      const content = await query(model, body)
      answers.push(...parseKbfAnswers(content, batch.length))
    } catch (error) {
      if (options.recoverTerminalEmptyBatches && isTerminalEmptyReferenceError(error)) {
        const domain = options.stabilityDomain ? ` in domain ${options.stabilityDomain}` : ''
        options.log?.(`skipping ${batch.length}-probe stability batch for ${model}${domain}: ${asError(error).message}`)
        answers.push(...new Array<number | null>(batch.length).fill(null))
        continue
      }
      throw error
    }
  }
  return answers
}

/**
 * Self-test the reference under audit conditions: each run shuffles the
 * probes into domain batches of ten and asks every batch with a prompt
 * variant, so the honest-error baseline includes order and wording effects
 * that audits see. Shuffles and variant picks are seeded per run so a resumed
 * build reuses its checkpointed responses. Answers are scored like target
 * answers: a missing, refused, or unreadable answer is unscored (null), as in
 * the KBF paper (v3) and its reference code. A batch with more than half its
 * answers unscored is asked again (up to twice) and the best attempt is kept.
 */
async function querySelfTestOutcomes(
  model: string,
  probes: readonly KbfProbe[],
  runs: number,
  query: ReferenceQuery,
  log?: (message: string) => void,
): Promise<ReferenceProbeSelfTestV1[]> {
  const answersByRun = await allSettledOrThrow(Array.from({ length: runs }, async (_unused, run) => {
    const seed = `self-test-${run}`
    const answers = new Array<number | null>(probes.length).fill(null)
    const batches = createDomainHomogeneousKbfBatches(probes, KBF_PROBES_PER_REQUEST, deterministicShuffle(seed))
    for (const batch of batches) {
      const variantId = seededPromptVariantId(seed, batch.probes)
      const batchAnswers = await querySelfTestBatchWithRetries(model, batch.probes, query, log, seed, variantId)
      for (const [batchIndex, originalIndex] of batch.indexes.entries()) {
        answers[originalIndex] = batchAnswers[batchIndex] ?? null
      }
    }
    return answers
  }))
  return probes.map((probe, index) => {
    const answers = answersByRun.map((runAnswers) => runAnswers[index] ?? null)
    return { probeId: probe.id, answers, matches: computeMatchVector(answers, answers.map(() => probe)) }
  })
}

function seededPromptVariantId(seed: string, probes: readonly KbfProbe[]): string {
  const hash = canonicalHashBytes32({ seed, probeIds: probes.map((probe) => probe.id) })
  return KBF_PROMPT_VARIANT_IDS[Number.parseInt(hash.slice(2, 10), 16) % KBF_PROMPT_VARIANT_IDS.length]!
}

function identityShuffle<T>(values: readonly T[]): T[] {
  return [...values]
}

function deterministicShuffle(seed: string): <T>(values: readonly T[]) => T[] {
  return <T>(values: readonly T[]): T[] => {
    const shuffled = [...values]
    let state = Number.parseInt(canonicalHashBytes32({ seed, length: values.length }).slice(2, 10), 16) >>> 0
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      const swapIndex = state % (index + 1)
      ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!]
    }
    return shuffled
  }
}

async function querySelfTestBatchWithRetries(
  model: string,
  probes: readonly KbfProbe[],
  query: ReferenceQuery,
  log: ((message: string) => void) | undefined,
  seed: string,
  variantId: string,
): Promise<Array<number | null>> {
  let best: Array<number | null> | null = null
  let bestScored = -1
  for (let attempt = 0; attempt <= KBF_LOW_COVERAGE_RETRIES; attempt += 1) {
    // The first attempt keeps the original cache domain, so checkpointed builds resume unchanged.
    const cacheDomain = attempt === 0 ? seed : `${seed}-low-coverage-retry-${attempt}`
    const answers = await querySelfTestBatch(model, probes, query, log, cacheDomain, variantId)
    const matches = computeMatchVector(answers, [...probes])
    const scored = matches.filter((match) => match !== null).length
    if (scored > bestScored) {
      best = answers
      bestScored = scored
    }
    if (!isLowCoverageKbfBatch(matches)) break
    if (attempt < KBF_LOW_COVERAGE_RETRIES) {
      log?.(`self-test batch for ${model} had ${probes.length - scored}/${probes.length} unscoreable answers; asking again`)
    }
  }
  return best!
}

async function querySelfTestBatch(
  model: string,
  probes: readonly KbfProbe[],
  query: ReferenceQuery,
  log: ((message: string) => void) | undefined,
  cacheDomain: string,
  variantId: string,
): Promise<Array<number | null>> {
  try {
    return await queryProbeAnswers(model, probes, 0, cacheDomain, query, { variantId })
  } catch (error) {
    if (!isTerminalEmptyReferenceError(error)) throw error
    if (probes.length === 1) {
      log?.(`skipping refused self-test probe ${probes[0]!.id}: ${asError(error).message}`)
      return [null]
    }
    const splitAt = Math.ceil(probes.length / 2)
    log?.(`splitting refused ${probes.length}-probe self-test batch into ${splitAt} and ${probes.length - splitAt}`)
    const left = await querySelfTestBatch(model, probes.slice(0, splitAt), query, log, cacheDomain, variantId)
    const right = await querySelfTestBatch(model, probes.slice(splitAt), query, log, cacheDomain, variantId)
    return [...left, ...right]
  }
}

interface ReferenceRawExchange {
  url: string
  protocol: ReferenceUpstreamProtocol
  requestBody: string
  status: number
  responseBody: string
}

interface ReferenceCompletion {
  content: string
  inputTokens: number
  outputTokens: number
  /** Hidden reasoning tokens the endpoint reported; null when it reports none. */
  reasoningTokens: number | null
  provider: string | null
  exchange: ReferenceRawExchange
}

async function postChatCompletion(
  route: ReferenceRequestRoute,
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ReferenceCompletion> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const anthropic = route.protocol === 'anthropic-messages'
  const baseUrl = route.baseUrl.replace(/\/+$/, '')
  const url = anthropic ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`
  const routedBody = applyReferenceRouteToBody(route, body)
  const requestBody = JSON.stringify(anthropic ? toAnthropicMessagesBody(routedBody) : routedBody)
  try {
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(route.apiKey
            ? anthropic
              ? { 'x-api-key': route.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
              : { authorization: `Bearer ${route.apiKey}` }
            : anthropic ? { 'anthropic-version': ANTHROPIC_VERSION } : {}),
          ...(route.peerId ? { 'x-antseed-pin-peer': route.peerId } : {}),
        },
        body: requestBody,
        signal: controller.signal,
      })
    } catch (error) {
      if (route.type !== 'antseed') throw error
      throw new Error(
        `Antseed reference route unavailable for peer ${route.peerId} service ${route.model}: ${asError(error).message}`,
        { cause: error },
      )
    }
    const responseBody = await response.text()
    if (!response.ok) {
      const detail = responseBody.slice(0, 200)
      throw new ReferenceEndpointError(
        response.status,
        parseRetryAfterMs(response.headers.get('retry-after')),
        route.type === 'antseed'
          ? `Antseed peer ${route.peerId} service ${route.model}: ${detail}`
          : detail,
      )
    }
    const exchange: ReferenceRawExchange = {
      url,
      protocol: anthropic ? 'anthropic-messages' : 'openai-chat-completions',
      requestBody,
      status: response.status,
      responseBody,
    }
    const parsed = parseCompletion(anthropic, responseBody)
    assertPinnedProvider(route, parsed.provider)
    if (parsed.content === null) {
      throw new EmptyReferenceResponseError(
        parsed.finishReason,
        parsed.nativeFinishReason,
        parsed.emptyDetail,
        parsed.inputTokens ?? 0,
        parsed.outputTokens ?? 0,
        exchange,
        parsed.reasoningTokens,
      )
    }
    if (parsed.inputTokens === null || parsed.outputTokens === null) {
      throw new Error(`reference endpoint omitted token usage for ${route.model}`)
    }
    return {
      content: parsed.content,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      reasoningTokens: parsed.reasoningTokens,
      provider: parsed.provider,
      exchange,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function parseCompletion(anthropic: boolean, responseBody: string): {
  content: string | null
  inputTokens: number | null
  outputTokens: number | null
  provider: string | null
  reasoningTokens: number | null
  finishReason: string | null
  nativeFinishReason: string | null
  emptyDetail: string
} {
  if (anthropic) {
    const parsed = JSON.parse(responseBody) as {
      content?: Array<{ type?: unknown; text?: unknown }>
      stop_reason?: unknown
      usage?: { input_tokens?: unknown; output_tokens?: unknown }
    }
    const text = (parsed.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')
    const stopReason = optionalString(parsed.stop_reason)
    const finishReason = stopReason === 'max_tokens' ? 'length' : stopReason
    const outputTokens = nonNegativeInteger(parsed.usage?.output_tokens)
    return {
      content: text.trim() ? text : null,
      inputTokens: nonNegativeInteger(parsed.usage?.input_tokens),
      outputTokens,
      provider: null,
      reasoningTokens: null,
      finishReason,
      nativeFinishReason: stopReason,
      emptyDetail: JSON.stringify({ finishReason, nativeFinishReason: stopReason, completionTokens: outputTokens }),
    }
  }
  const parsed = JSON.parse(responseBody) as {
    provider?: unknown
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown; native_finish_reason?: unknown }>
    usage?: {
      prompt_tokens?: unknown
      completion_tokens?: unknown
      completion_tokens_details?: { reasoning_tokens?: unknown }
    }
  }
  const choice = parsed.choices?.[0]
  const finishReason = optionalString(choice?.finish_reason)
  const nativeFinishReason = optionalString(choice?.native_finish_reason)
  return {
    content: completionText(choice?.message?.content),
    inputTokens: nonNegativeInteger(parsed.usage?.prompt_tokens),
    outputTokens: nonNegativeInteger(parsed.usage?.completion_tokens),
    provider: optionalString(parsed.provider),
    reasoningTokens: nonNegativeInteger(parsed.usage?.completion_tokens_details?.reasoning_tokens),
    finishReason,
    nativeFinishReason,
    emptyDetail: JSON.stringify({
      finishReason,
      nativeFinishReason,
      completionTokens: parsed.usage?.completion_tokens ?? null,
      reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    }),
  }
}

/** Converts an OpenAI chat body to the Anthropic Messages API: system prompts move to `system`. */
function toAnthropicMessagesBody(body: Record<string, unknown>): Record<string, unknown> {
  const { messages, max_tokens: maxTokens, ...rest } = body
  const system: string[] = []
  const turns: Array<{ role: string; content: unknown }> = []
  for (const message of (messages ?? []) as Array<{ role: string; content: unknown }>) {
    if (message.role === 'system' && typeof message.content === 'string') system.push(message.content)
    else turns.push({ role: message.role, content: message.content })
  }
  return {
    ...rest,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    messages: turns,
    max_tokens: maxTokens ?? MAX_TOKENS,
  }
}

/**
 * OpenRouter pins a provider by endpoint tag (`alibaba/prime`, `amazon-bedrock`) and enforces the
 * pin itself (`allow_fallbacks: false`), but reports only the provider name (`Alibaba`, `Amazon
 * Bedrock`). So the served name matches a pin when it equals the tag or the tag's provider part.
 */
function providerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function assertPinnedProvider(route: ReferenceRequestRoute, provider: string | null): void {
  if (!route.providerRouting || provider === null) return
  const served = providerKey(provider)
  const matches = route.providerRouting.order.some((pin) => providerKey(pin) === served
    || providerKey(pin.split('/')[0] ?? '') === served)
  if (!matches) {
    throw new Error(
      `reference endpoint served ${route.model} from provider ${provider}, `
      + `outside the pinned providers ${route.providerRouting.order.join(', ')}`,
    )
  }
}

function completionText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (!Array.isArray(value)) return null
  const text = value.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return []
    const record = part as Record<string, unknown>
    return typeof record.text === 'string' ? [record.text] : []
  }).join('')
  return text.trim() === '' ? null : text
}

export function resolveReferenceRequestOverrides(
  model: string,
  catalog: VerifierModelCatalog | null,
): Record<string, unknown> {
  const reasoning = catalog?.get(normalized(model))?.reasoning
  if (reasoning?.mandatory !== true) return DISABLED_REASONING_REQUEST_OVERRIDES
  const effort = reasoning.supportedEfforts === null
    ? 'minimal'
    : REASONING_EFFORT_ASCENDING.find((candidate) => reasoning.supportedEfforts!.includes(candidate))
  if (!effort) throw new Error(`mandatory reasoning model ${model} exposes no supported reasoning effort`)
  return { reasoning: { effort, exclude: true } }
}

class ReferenceEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    readonly detail: string,
  ) {
    super(`reference endpoint ${status}: ${detail}`)
  }
}

class EmptyReferenceResponseError extends Error {
  constructor(
    readonly finishReason: string | null,
    readonly nativeFinishReason: string | null,
    readonly detail = '',
    readonly inputTokens = 0,
    readonly outputTokens = 0,
    readonly exchange?: ReferenceRawExchange,
    readonly reasoningTokens: number | null = null,
  ) {
    super(`reference endpoint returned no text content${detail ? `: ${detail}` : ''}`)
  }
}

function summarizeReferenceCosts(responses: ReferenceCachedResponseV1[]): ReferenceBuildCostV1 {
  const byModel = new Map<string, ReferenceBuildCostModelV1>()
  const byPurpose = new Map<string, ReferenceBuildCostPurposeV1>()
  let totalUsdMicros = 0n
  for (const response of responses) {
    totalUsdMicros += BigInt(response.costUsdMicros)
    const key = normalized(response.model)
    const current = byModel.get(key) ?? {
      model: response.model,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      inputUsdPerMillion: response.inputUsdPerMillion,
      outputUsdPerMillion: response.outputUsdPerMillion,
      costUsdMicros: '0',
    }
    current.requestCount += 1
    current.inputTokens += response.inputTokens
    current.outputTokens += response.outputTokens
    current.costUsdMicros = String(BigInt(current.costUsdMicros) + BigInt(response.costUsdMicros))
    byModel.set(key, current)
    const purposeKey = `${response.purpose}:${key}`
    const purpose = byPurpose.get(purposeKey) ?? {
      purpose: response.purpose,
      model: response.model,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      inputUsdPerMillion: response.inputUsdPerMillion,
      outputUsdPerMillion: response.outputUsdPerMillion,
      costUsdMicros: '0',
    }
    purpose.requestCount += 1
    purpose.inputTokens += response.inputTokens
    purpose.outputTokens += response.outputTokens
    purpose.costUsdMicros = String(BigInt(purpose.costUsdMicros) + BigInt(response.costUsdMicros))
    byPurpose.set(purposeKey, purpose)
  }
  return {
    totalUsdMicros: totalUsdMicros.toString(),
    requestCount: responses.length,
    models: [...byModel.values()].sort((left, right) => left.model.localeCompare(right.model)),
    purposes: [...byPurpose.values()].sort((left, right) => (
      left.purpose.localeCompare(right.purpose) || left.model.localeCompare(right.model)
    )),
  }
}

function referenceRequestPurpose(value: unknown): ReferenceBuildCostPurposeV1['purpose'] {
  if (typeof value === 'string' && value.startsWith('self-test')) return 'self-test'
  if (typeof value === 'string' && value.startsWith('contrast-')) return 'contrast-model'
  if (typeof value === 'string' && value.startsWith('stability-')) return 'target-model'
  return 'candidate-generation'
}

function referencePricingByModel(
  config: VerifierCLIConfig | undefined,
  resolved: ResolvedVerifierModelConfig,
  catalog: VerifierModelCatalog | null,
): Map<string, VerifierModelPricingConfig> {
  const prices = new Map<string, VerifierModelPricingConfig>()
  const targetPricing = resolved.referenceRoute?.pricing
    ?? resolved.pricing
    ?? catalog?.get(normalized(resolved.upstreamModel))?.pricing
  if (!targetPricing) throw new Error(`no reference pricing is available for ${resolved.upstreamModel}`)
  prices.set(normalized(resolved.upstreamModel), targetPricing)
  for (const contrastModel of resolved.contrastModels) {
    const catalogPricing = catalog?.get(normalized(contrastModel))?.pricing
    const configuredPricing = Object.values(config?.referenceEndpoint?.contrastModelBank ?? {})
      .find((candidate) => normalized(candidate.upstreamModel) === normalized(contrastModel))?.pricing
    const auditedPricing = auditedVerifierModels(config)
      .find(([, candidate]) => normalized(candidate.upstreamModel) === normalized(contrastModel))?.[1].pricing
    const pricing = catalogPricing ?? configuredPricing ?? auditedPricing
    if (!pricing) throw new Error(`no reference pricing is available for ${contrastModel}`)
    prices.set(normalized(contrastModel), pricing)
  }
  return prices
}

function resolveReferenceRequestRoute(input: {
  endpoint: VerifierReferenceEndpointConfig
  model: string
  apiKey: string | undefined
  catalog: VerifierModelCatalog | null
  referenceRoute?: ResolvedVerifierModelConfig['referenceRoute']
  referenceProvider?: ResolvedVerifierModelConfig['referenceProvider']
  upstream?: { name: string; model?: string; config: VerifierUpstreamConfig | undefined }
  buyerProxyPort?: number
}): ReferenceRequestRoute {
  if (input.upstream && input.referenceRoute?.type !== 'antseed') {
    const config = input.upstream.config
    if (!config) throw new Error(`verifier.upstreams.${input.upstream.name} is not configured`)
    if (config.type === 'antseed') throw new Error(`antseed upstream ${input.upstream.name} must resolve to a referenceRoute`)
    const apiKey = (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? config.apiKey
    if (!apiKey) {
      throw new Error(
        `verifier.upstreams.${input.upstream.name} has no API key`
        + (config.apiKeyEnv ? `; set ${config.apiKeyEnv}` : ''),
      )
    }
    const model = (input.upstream.model ?? input.model).trim()
    return {
      type: 'direct',
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      model,
      apiKey,
      requestOverrides: config.type === 'openrouter'
        ? resolveReferenceRequestOverrides(input.model, input.catalog)
        : {},
      requestOmissions: config.type === 'anthropic' ? ['top_p'] : [],
      upstream: { name: input.upstream.name, type: config.type },
      ...(config.type === 'anthropic' ? { protocol: 'anthropic-messages' as const } : {}),
      ...(input.referenceProvider && config.type === 'openrouter' ? {
        providerRouting: {
          order: input.referenceProvider.order.map((provider) => provider.trim()),
          allow_fallbacks: false as const,
        },
      } : {}),
    }
  }
  if (input.referenceRoute?.type === 'antseed') {
    const port = input.buyerProxyPort
    if (!Number.isInteger(port) || port! < 1 || port! > 65_535) {
      throw new Error('buyer.proxyPort must be configured to use an Antseed reference route')
    }
    return {
      type: 'antseed',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: input.referenceRoute.service.trim(),
      peerId: normalized(input.referenceRoute.peerId),
      pricing: input.referenceRoute.pricing,
      requestOverrides: {},
      requestOmissions: ['temperature', 'top_p'],
      ...(input.upstream ? { upstream: { name: input.upstream.name, type: 'antseed' as const } } : {}),
    }
  }
  return {
    type: 'direct',
    baseUrl: input.endpoint.baseUrl.replace(/\/+$/, ''),
    model: input.model,
    apiKey: input.apiKey,
    peerId: input.endpoint.antseedPeerId,
    requestOverrides: resolveReferenceRequestOverrides(input.model, input.catalog),
    requestOmissions: [],
    ...(input.referenceProvider ? {
      providerRouting: {
        order: input.referenceProvider.order.map((provider) => provider.trim()),
        allow_fallbacks: false,
      },
    } : {}),
  }
}

function applyReferenceRouteToBody(
  route: ReferenceRequestRoute,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const routed: Record<string, unknown> = {
    ...body,
    ...route.requestOverrides,
    ...(route.providerRouting ? { provider: route.providerRouting } : {}),
    model: route.model,
  }
  for (const field of route.requestOmissions) delete routed[field]
  if (route.assistantPrefill && route.protocol !== 'anthropic-messages' && Array.isArray(routed.messages)) {
    routed.messages = [...routed.messages as unknown[], { role: 'assistant', content: route.assistantPrefill }]
  }
  if (route.minMaxTokens && typeof routed.max_tokens === 'number' && routed.max_tokens < route.minMaxTokens) {
    routed.max_tokens = route.minMaxTokens
  }
  return routed
}

export interface ReferenceThinkingDiscoveryEntryV1 {
  model: string
  strategy: ThinkingDiscoveryStrategy
  attempts: ThinkingDiscoveryAttemptV1[]
}

/** Recorded in `generator.params.thinkingDiscovery` of references built with discovery. */
export interface ReferenceThinkingDiscoveryRecordV1 {
  version: 1
  method: 'kbf-reference-code-2026-09-30'
  target?: ReferenceThinkingDiscoveryEntryV1
  contrasts: Record<string, ReferenceThinkingDiscoveryEntryV1>
}

/** The route with exactly one thinking strategy applied, replacing catalog-based reasoning fields. */
function routeWithThinkingStrategy(route: ReferenceRequestRoute, strategy: ThinkingDiscoveryStrategy): ReferenceRequestRoute {
  const request = thinkingStrategyRequest(strategy)
  const {
    assistantPrefill: _prefill,
    minMaxTokens: _minMaxTokens,
    reasoningStrategy: _strategy,
    ...base
  } = route
  return {
    ...base,
    requestOverrides: request.overrides,
    reasoningStrategy: strategy,
    ...(request.assistantPrefill ? { assistantPrefill: request.assistantPrefill } : {}),
    ...(request.maxTokens ? { minMaxTokens: request.maxTokens } : {}),
  }
}

/** Applies the request settings a bank recorded, so a top-up measures probes the same way. */
function withRecordedEndpointRequest(
  route: ReferenceRequestRoute,
  recorded: ReferenceEndpointRequestV1,
  initial: KbfReferenceV1,
): ReferenceRequestRoute {
  if (route.type === 'antseed') return route
  const {
    assistantPrefill: _prefill,
    minMaxTokens: _minMaxTokens,
    reasoningStrategy: _strategy,
    ...base
  } = route
  return {
    ...base,
    requestOverrides: recorded.requestOverrides ?? route.requestOverrides,
    requestOmissions: recorded.requestOmissions ?? route.requestOmissions,
    ...(recorded.reasoningStrategy ? { reasoningStrategy: recorded.reasoningStrategy } : {}),
    ...(recorded.assistantPrefill ? { assistantPrefill: recorded.assistantPrefill } : {}),
    ...(initial.queryProfile.maxTokensPerRequest > MAX_TOKENS ? { minMaxTokens: initial.queryProfile.maxTokensPerRequest } : {}),
  }
}

function isReferenceCachedResponse(value: unknown): value is ReferenceCachedResponseV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const common = typeof response.model === 'string'
    && typeof response.purpose === 'string'
    && ['candidate-generation', 'target-model', 'contrast-model', 'self-test', 'thinking-discovery'].includes(response.purpose)
    && (response.reasoningTokens === undefined || nonNegativeInteger(response.reasoningTokens) !== null)
    && nonNegativeInteger(response.inputTokens) !== null
    && nonNegativeInteger(response.outputTokens) !== null
    && typeof response.inputUsdPerMillion === 'number'
    && Number.isFinite(response.inputUsdPerMillion)
    && response.inputUsdPerMillion >= 0
    && typeof response.outputUsdPerMillion === 'number'
    && Number.isFinite(response.outputUsdPerMillion)
    && response.outputUsdPerMillion >= 0
    && typeof response.costUsdMicros === 'string'
    && /^\d+$/.test(response.costUsdMicros)
  if (!common) return false
  if (response.outcome === 'terminal-empty') {
    return (typeof response.finishReason === 'string' || response.finishReason === null)
      && (typeof response.nativeFinishReason === 'string' || response.nativeFinishReason === null)
      && typeof response.detail === 'string'
  }
  return (response.outcome === undefined || response.outcome === 'success')
    && typeof response.content === 'string'
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isRetryableReferenceError(error: unknown): boolean {
  if (error instanceof ReferenceEndpointError) return error.status === 429 || error.status >= 500
  if (error instanceof EmptyReferenceResponseError) return !isTerminalEmptyReferenceError(error)
  if (error instanceof Error && error.name === 'AbortError') return true
  const retryableCodes = new Set([
    'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETDOWN', 'ENETRESET',
    'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  ])
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code
    if (typeof code === 'string' && retryableCodes.has(code)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function isTerminalEmptyReferenceError(error: unknown): error is EmptyReferenceResponseError {
  return error instanceof EmptyReferenceResponseError
    && [error.finishReason, error.nativeFinishReason]
      .some((reason) => reason !== null && TERMINAL_EMPTY_FINISH_REASONS.has(normalized(reason)))
}

function isRecoverableContrastError(error: unknown): boolean {
  return error instanceof ReferenceEndpointError || error instanceof EmptyReferenceResponseError
}

function isThrottleError(error: unknown): error is ReferenceEndpointError {
  return error instanceof ReferenceEndpointError && error.status === 429
}

function isNewAccountRateLimit(error: unknown): boolean {
  return error instanceof ReferenceEndpointError
    && error.status === 429
    && normalized(error.detail).includes('new-account-rpm')
}

function retryDelayMs(error: unknown, baseDelayMs: number, attempt: number): number {
  if (error instanceof ReferenceEndpointError && error.retryAfterMs !== null) return error.retryAfterMs
  if (isNewAccountRateLimit(error)) return NEW_ACCOUNT_MINIMUM_REQUEST_INTERVAL_MS
  return Math.min(30_000, baseDelayMs * 2 ** Math.max(0, attempt - 1))
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

async function allSettledOrThrow<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises)
  const rejection = results.find((result) => result.status === 'rejected')
  if (rejection?.status === 'rejected') throw rejection.reason
  return results.map((result) => (result as PromiseFulfilledResult<T>).value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

function referencePath(referencesDir: string, model: string): string {
  return join(referencesDir, `${safeServiceSlug(model)}.json`)
}

function referenceExchangesPath(referencesDir: string, model: string): string {
  return join(referencesDir, `${safeServiceSlug(model)}.exchanges.json`)
}

function referenceReasoningStrategy(route: ReferenceRequestRoute): ReferenceEndpointRequestV1['reasoningStrategy'] {
  if (route.reasoningStrategy) return route.reasoningStrategy
  if (route.type === 'antseed') return BARE_REASONING_STRATEGY
  if ('reasoning' in route.requestOverrides) return MINIMUM_SUPPORTED_REASONING_STRATEGY
  if ('reasoning_effort' in route.requestOverrides) return DISABLED_REASONING_STRATEGY
  return BARE_REASONING_STRATEGY
}

/** Builds from different upstreams get different source ids, so their probes never share a bank. */
function referenceSourceId(endpoint: VerifierReferenceEndpointConfig, route: ReferenceRequestRoute): string {
  if (route.type === 'antseed') return `${endpoint.sourceId}:antseed:${route.peerId}:${route.model}`
  if (route.upstream) return `upstream:${route.upstream.name}:${route.upstream.type}:${route.model}`
  return endpoint.sourceId
}

function referenceUpstreamProvenance(
  endpoint: VerifierReferenceEndpointConfig,
  route: ReferenceRequestRoute,
): ReferenceUpstreamProvenanceV1 {
  const type: ReferenceUpstreamType = route.type === 'antseed'
    ? 'antseed'
    : route.upstream?.type ?? (/openrouter\.ai/i.test(endpoint.baseUrl) ? 'openrouter' : 'openai')
  return {
    name: route.upstream?.name ?? 'referenceEndpoint',
    type,
    baseUrl: route.baseUrl,
    model: route.model,
    protocol: route.protocol ?? 'openai-chat-completions',
    request: {
      overrides: route.requestOverrides,
      omissions: [...route.requestOmissions],
      ...(route.assistantPrefill ? { assistantPrefill: route.assistantPrefill } : {}),
      ...(route.minMaxTokens ? { minMaxTokens: route.minMaxTokens } : {}),
    },
    providerPin: route.providerRouting ? [...route.providerRouting.order] : null,
    ...(route.peerId ? { peerId: route.peerId } : {}),
  }
}

async function writeReferenceExchanges(input: {
  path: string
  model: string
  upstream: ReferenceUpstreamProvenanceV1
  checkpoints: readonly ReferenceBuildCheckpoint[]
}): Promise<ReferenceExchangesFileV1> {
  const exchanges = (await Promise.all(input.checkpoints.map((checkpoint) => checkpoint.readExchanges()))).flat()
  const requestCount = input.checkpoints.reduce((total, checkpoint) => total + checkpoint.requestsUsed, 0)
  const document: ReferenceExchangesV1 = {
    version: 1,
    kind: 'antseed-reference-exchanges',
    model: input.model,
    upstream: input.upstream,
    requestCount,
    exchangeCount: exchanges.length,
    exchanges,
  }
  const bytes = Buffer.from(canonicalJsonStringify(document), 'utf8')
  await writeTextAtomic(input.path, bytes.toString('utf8'))
  return {
    path: input.path,
    sha256: `sha256:${sha256Hex(bytes)}`,
    upstream: input.upstream,
    exchangeCount: exchanges.length,
    requestCount,
  }
}

async function removeIfExists(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}
