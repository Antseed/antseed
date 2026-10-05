import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KBF_ENROLLMENT_TEMPERATURES,
  KBF_PROBES_PER_REQUEST,
  buildKbfChatRequestBody,
  canonicalHashBytes32,
  computeBinomialPower,
  computeMatchVector,
  computeReferenceId,
  createReferenceQueryProfile,
  matchesTolerance,
  parseKbfAnswers,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type {
  VerifierCLIConfig,
  VerifierModelPricingConfig,
  VerifierReferenceEndpointConfig,
} from '../config/types.js'
import {
  REFERENCE_MINIMUM_MISMATCH_DELTA,
  REFERENCE_POWER_ALPHA,
  REFERENCE_POWER_CONFIDENCE,
  isReferenceProbeCountAllowed,
  resolveReferenceSizingPolicy,
} from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'
import { resolveVerifierModelConfig, type ResolvedVerifierModelConfig } from './model-config.js'
import type { VerifierModelCatalog, VerifierReasoningEffort } from './openrouter-catalog.js'
import {
  CANONICAL_KBF_DOMAINS,
  canonicalKbfTolerance,
  createCanonicalKbfProbe,
} from './canonical-kbf-domains.js'
import { writeJsonAtomic } from './atomic-files.js'
import { createDomainHomogeneousKbfBatches } from './kbf-batching.js'
import { asError, normalized, sleep } from './utils.js'

const CANDIDATE_COUNT = 300
const CANDIDATE_BATCH_SIZE = 20
const DEFAULT_MAX_REQUESTS_PER_BUILD = 2_000
const DEFAULT_BATCH_RETRY_COUNT = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 500
const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 3
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4
const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_MODEL = 3
const NEW_ACCOUNT_MINIMUM_REQUEST_INTERVAL_MS = 6_500
const NEW_ACCOUNT_RATE_LIMIT_COOLDOWN_MS = 65_000
const MAX_TOKENS = 1600
const REFERENCE_SIZING_ALGORITHM_VERSION = 2
const MINIMUM_SUPPORTED_REASONING_STRATEGY = 'reasoning-effort-minimum-supported' as const
const DISABLED_REASONING_STRATEGY = 'reasoning-effort-none' as const
const BARE_REASONING_STRATEGY = 'bare' as const
const DISABLED_REASONING_REQUEST_OVERRIDES = { reasoning_effort: 'none' } as const
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
  purpose: ReferenceBuildCostPurposeV1['purpose']
  inputTokens: number
  outputTokens: number
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  costUsdMicros: string
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
  purpose: 'candidate-generation' | 'target-model' | 'contrast-model' | 'self-test'
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
}

interface ReferenceRequestRoute {
  type: 'direct' | 'antseed'
  baseUrl: string
  model: string
  apiKey?: string
  peerId?: string
  pricing?: VerifierModelPricingConfig
  requestOverrides: Record<string, unknown>
  requestOmissions: Array<'temperature' | 'top_p'>
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
    const reference = validateKbfReferenceV1(JSON.parse(raw), {
      trustImported: true,
      minimumStatisticalPower: Number.EPSILON,
    })
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
}): Promise<{
  reference: KbfReferenceV1
  path: string
  cost: ReferenceBuildCostV1
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
        buyerProxyPort: input.buyerProxyPort,
      })] as const
    }),
  )
  const targetRoute = routesByModel.get(normalized(modelConfig.upstreamModel))!
  const targetRequestOverrides = targetRoute.requestOverrides
  const targetReasoningStrategy = targetRoute.type === 'antseed'
    ? BARE_REASONING_STRATEGY
    : 'reasoning' in targetRequestOverrides
    ? MINIMUM_SUPPORTED_REASONING_STRATEGY
    : DISABLED_REASONING_STRATEGY
  const timeoutMs = input.config?.probeRequestTimeoutMs ?? 120_000
  const sizing = resolveReferenceSizingPolicy(input.config)
  const checkpointPath = join(input.referencesDir, '.checkpoints', `${safeServiceSlug(input.model)}.json`)
  const compatibilityHash = canonicalHashBytes32({
    version: 3,
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
  })
  const checkpoint = await ReferenceBuildCheckpoint.open(checkpointPath, compatibilityHash)
  const limiter = input.requestLimiter ?? createReferenceRequestLimiter(input.config)
  const query = createReferenceQuery({
    timeoutMs,
    fetchFn: input.fetchFn ?? fetch,
    checkpoint,
    limiter,
    maxRequests: input.config?.referenceMaxRequestsPerBuild ?? DEFAULT_MAX_REQUESTS_PER_BUILD,
    retryCount: input.config?.referenceBatchRetryCount ?? DEFAULT_BATCH_RETRY_COUNT,
    retryBaseDelayMs: input.config?.referenceRetryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    pricingForModel: (model) => {
      const pricing = pricingByModel.get(normalized(model))
      if (!pricing) throw new Error(`no reference pricing is available for ${model}`)
      return pricing
    },
    routeForModel: (model) => routesByModel.get(normalized(model))
      ?? resolveReferenceRequestRoute({ endpoint, model, apiKey, catalog: input.catalog ?? null }),
    log: input.log,
  })
  let collected: CollectedReferenceProbes | undefined
  const selfAnswers: Array<number | null> = []
  let selected: {
    probes: KbfProbe[]
    matches: Array<0 | 1 | null>
    answers: Array<number | null>
    power: ReturnType<typeof computeBinomialPower>
  } | null = null
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
      })
      const additions = collected.probes.slice(selfAnswers.length, targetCount)
      if (additions.length > 0) {
        input.log?.(`self-testing ${selfAnswers.length + 1}-${targetCount} of ${targetCount} probes`)
        selfAnswers.push(...await querySelfTestAnswers(
          modelConfig.upstreamModel,
          additions,
          query,
          input.log,
        ))
      }
      const probes = collected.probes.slice(0, targetCount)
      const answers = selfAnswers.slice(0, targetCount)
      const matches = computeMatchVector(answers, probes)
        .map((match, index) => answers[index] === null ? null : match)
      const parsed = answers.filter((answer) => answer !== null).length
      const hamming = matches.filter((match) => match !== 1).length
      const coverage = parsed / targetCount
      const errorRate = hamming / targetCount
      const power = computeBinomialPower({
        selfHamming: hamming,
        selfTotal: targetCount,
        minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
        alpha: REFERENCE_POWER_ALPHA,
        cpConfidence: REFERENCE_POWER_CONFIDENCE,
      })
      input.log?.(
        `reference size ${targetCount}: power ${power.power.toFixed(3)}, `
        + `self-test ${hamming}/${targetCount}, coverage ${coverage.toFixed(3)}`,
      )
      if (coverage >= 0.8 && errorRate <= 0.35 && power.power >= sizing.minimumStatisticalPower) {
        selected = { probes, matches, answers, power }
        break
      }
    }
  } catch (error) {
    if (asError(error).message.includes('reference generation made no progress')) await checkpoint.remove()
    throw error
  }
  if (!collected || !selected) {
    throw new Error(
      `reference remains underpowered at ${sizing.maximumProbeCount} probes; `
      + `required power ${sizing.minimumStatisticalPower.toFixed(3)}`,
    )
  }
  const { probes, matches, answers, power } = selected
  const parsed = answers.filter((answer) => answer !== null).length
  const hamming = matches.filter((match) => match !== 1).length
  const selfTest = {
    hamming,
    total: probes.length,
    coverage: parsed / probes.length,
    errorRate: hamming / probes.length,
    outcomes: probes.map((probe, index) => ({ probeId: probe.id, answer: answers[index] ?? null, match: matches[index]! })),
  }
  if (selfTest.coverage < 0.8) {
    await checkpoint.remove()
    throw new Error(`self-test coverage ${selfTest.coverage.toFixed(3)} is below 0.8`)
  }
  if (selfTest.errorRate > 0.35) {
    await checkpoint.remove()
    throw new Error(`self-test error rate ${selfTest.errorRate.toFixed(3)} exceeds 0.35`)
  }
  const queryProfile = createReferenceQueryProfile({
    upstreamModel: targetRoute.model,
    maxTokensPerRequest: MAX_TOKENS,
    requestTimeoutMs: timeoutMs,
  })
  queryProfile.reasoningStrategy = targetReasoningStrategy
  queryProfile.requestOverrides = targetRequestOverrides
  queryProfile.requestOmissions = targetRoute.requestOmissions
  const reference: KbfReferenceV1 = {
    version: 1,
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
      version: '4',
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
      },
    },
    provenance: {
      sourceId: targetRoute.type === 'antseed'
        ? `${endpoint.sourceId}:antseed:${targetRoute.peerId}:${targetRoute.model}`
        : endpoint.sourceId,
      trust: endpoint.trust,
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
      selfHamming: hamming,
      selfTotal: probes.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: modelConfig.contrastModels.map((model) => ({
      model,
      distinguishingProbeIds: (collected.distinguishingProbeIdsByModel.get(model) ?? [])
        .filter((probeId) => probes.some((probe) => probe.id === probeId)),
    })),
  }
  reference.referenceId = computeReferenceId(reference)
  const validated = validateKbfReferenceV1(reference, {
    minimumStatisticalPower: sizing.minimumStatisticalPower,
  })
  const path = referencePath(input.referencesDir, input.model)
  await writeJsonAtomic(path, validated)
  const cost = query.costSummary?.() ?? summarizeReferenceCosts([])
  return { reference: validated, path, cost, finalize: () => checkpoint.remove() }
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
  shuffle?: <T>(values: readonly T[]) => T[]
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
      if (state.generatedProbeIds.has(probe.id)) return false
      state.generatedProbeIds.add(probe.id)
      return true
    })
    state.candidateCount = state.generatedProbeIds.size
    input.log?.(`generation round ${state.generationRound}: testing ${candidates.length} new candidates for stability`)
    const stable = await certifyStableProbes(input.model, candidates, input.query, input.log, input.shuffle)
    const contrastOutcomes = await queryContrastOutcomes(stable, input.contrastModels, input.query, input.log)
    const accepted = stable.filter((probe) => input.contrastModels.length === 0
      || (contrastOutcomes.get(probe.id)?.length ?? 0) > 0)
    const prepared = accepted.map((probe) => {
      const distinguishingModels = contrastOutcomes.get(probe.id) ?? []
      return {
        ...probe,
        ...(distinguishingModels.length > 0 ? { contrast: { distinguishingModels } } : {}),
      }
    })
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
    for (const batch of batches) {
      try {
        await queryBatch(batch)
      } catch (error) {
        if (!isRecoverableContrastError(error)) throw error
        log?.(`contrast model ${model} unavailable; skipping remaining probe answers: ${asError(error).message}`)
        break
      }
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
): Promise<Map<string, string[]>> {
  const outcomes = new Map(probes.map((probe) => [probe.id, [] as string[]]))
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
      if (answer !== null && !matchesTolerance(answer, probe)) outcomes.get(probe.id)!.push(contrastModel)
    }
  }
  return outcomes
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
        if (!(error instanceof EmptyReferenceResponseError)) throw error
        log?.(`skipping empty candidate batch for ${definition.key}: ${error.message}`)
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
          input.timeoutMs,
          input.fetchFn,
        ))
        const pricing = input.pricingForModel(model)
        const cachedResponse: ReferenceCachedSuccessV1 = {
          outcome: 'success',
          content: response.content,
          model,
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
        await input.checkpoint.set(cacheKey, cachedResponse)
        consumed.set(cacheKey, cachedResponse)
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
  return query
}

class ReferenceBuildCheckpoint {
  private saveChain = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly value: ReferenceBuildCheckpointV1,
  ) {}

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
    await checkpoint.save()
    return checkpoint
  }

  get(key: string): ReferenceCachedResponseV1 | undefined {
    return this.value.responses[key]
  }

  async reserveRequest(maxRequests: number): Promise<void> {
    let budgetError: Error | null = null
    this.saveChain = this.saveChain.then(async () => {
      if (this.value.requestsUsed >= maxRequests) {
        budgetError = new Error(`reference build request budget exhausted (${maxRequests})`)
        return
      }
      this.value.requestsUsed += 1
      await writeJsonAtomic(this.path, this.value)
    })
    await this.saveChain
    if (budgetError) throw budgetError
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

  async remove(): Promise<void> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  private async save(): Promise<void> {
    this.saveChain = this.saveChain.then(() => writeJsonAtomic(this.path, this.value))
    await this.saveChain
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
    allowIncomplete?: boolean
    recoverTerminalEmptyBatches?: boolean
    stabilityDomain?: string
    log?: (message: string) => void
  } = {},
): Promise<Array<number | null>> {
  const answers: Array<number | null> = []
  for (let offset = 0; offset < probes.length; offset += KBF_PROBES_PER_REQUEST) {
    const batch = probes.slice(offset, offset + KBF_PROBES_PER_REQUEST)
    const body = {
      ...buildKbfChatRequestBody(model, batch, { maxTokens: MAX_TOKENS }),
      temperature,
      top_p: 1,
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
      if (!options.allowIncomplete || !isRecoverableContrastError(error)) throw error
      const remaining = probes.length - offset
      options.log?.(
        `contrast model ${model} unavailable; skipping ${remaining} probe answers: ${asError(error).message}`,
      )
      answers.push(...new Array<number | null>(remaining).fill(null))
      break
    }
  }
  return answers
}

async function querySelfTestAnswers(
  model: string,
  probes: readonly KbfProbe[],
  query: ReferenceQuery,
  log?: (message: string) => void,
): Promise<Array<number | null>> {
  const answers = new Array<number | null>(probes.length).fill(null)
  const batches = createDomainHomogeneousKbfBatches(probes, KBF_PROBES_PER_REQUEST, identityShuffle)
  for (const batch of batches) {
    const batchAnswers = await querySelfTestBatch(model, batch.probes, query, log)
    for (const [batchIndex, originalIndex] of batch.indexes.entries()) {
      answers[originalIndex] = batchAnswers[batchIndex] ?? null
    }
  }
  return answers
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

async function querySelfTestBatch(
  model: string,
  probes: readonly KbfProbe[],
  query: ReferenceQuery,
  log?: (message: string) => void,
): Promise<Array<number | null>> {
  try {
    return await queryProbeAnswers(model, probes, 0, 'self-test', query)
  } catch (error) {
    if (!isTerminalEmptyReferenceError(error)) throw error
    if (probes.length === 1) {
      log?.(`skipping refused self-test probe ${probes[0]!.id}: ${asError(error).message}`)
      return [null]
    }
    const splitAt = Math.ceil(probes.length / 2)
    log?.(`splitting refused ${probes.length}-probe self-test batch into ${splitAt} and ${probes.length - splitAt}`)
    const left = await querySelfTestBatch(model, probes.slice(0, splitAt), query, log)
    const right = await querySelfTestBatch(model, probes.slice(splitAt), query, log)
    return [...left, ...right]
  }
}

async function postChatCompletion(
  route: ReferenceRequestRoute,
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchFn(`${route.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}),
          ...(route.peerId ? { 'x-antseed-pin-peer': route.peerId } : {}),
        },
        body: JSON.stringify(applyReferenceRouteToBody(route, body)),
        signal: controller.signal,
      })
    } catch (error) {
      if (route.type !== 'antseed') throw error
      throw new Error(
        `AntSeed reference route unavailable for peer ${route.peerId} service ${route.model}: ${asError(error).message}`,
        { cause: error },
      )
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200)
      throw new ReferenceEndpointError(
        response.status,
        parseRetryAfterMs(response.headers.get('retry-after')),
        route.type === 'antseed'
          ? `AntSeed peer ${route.peerId} service ${route.model}: ${detail}`
          : detail,
      )
    }
    const parsed = await response.json() as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown; native_finish_reason?: unknown }>
      usage?: {
        prompt_tokens?: unknown
        completion_tokens?: unknown
        completion_tokens_details?: { reasoning_tokens?: unknown }
      }
    }
    const choice = parsed.choices?.[0]
    const content = completionText(choice?.message?.content)
    const inputTokens = nonNegativeInteger(parsed.usage?.prompt_tokens)
    const outputTokens = nonNegativeInteger(parsed.usage?.completion_tokens)
    if (content === null) {
      const finishReason = optionalString(choice?.finish_reason)
      const nativeFinishReason = optionalString(choice?.native_finish_reason)
      const detail = JSON.stringify({
        finishReason,
        nativeFinishReason,
        completionTokens: parsed.usage?.completion_tokens ?? null,
        reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      })
      throw new EmptyReferenceResponseError(
        finishReason,
        nativeFinishReason,
        detail,
        inputTokens ?? 0,
        outputTokens ?? 0,
      )
    }
    if (inputTokens === null || outputTokens === null) {
      throw new Error(`reference endpoint omitted token usage for ${route.model}`)
    }
    return { content, inputTokens, outputTokens }
  } finally {
    clearTimeout(timeout)
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
  if (value === 'self-test') return 'self-test'
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
    const auditedPricing = Object.values(config?.referenceEndpoint?.models ?? {})
      .find((candidate) => normalized(candidate.upstreamModel) === normalized(contrastModel))?.pricing
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
  buyerProxyPort?: number
}): ReferenceRequestRoute {
  if (input.referenceRoute?.type === 'antseed') {
    const port = input.buyerProxyPort
    if (!Number.isInteger(port) || port! < 1 || port! > 65_535) {
      throw new Error('buyer.proxyPort must be configured to use an AntSeed reference route')
    }
    return {
      type: 'antseed',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: input.referenceRoute.service.trim(),
      peerId: normalized(input.referenceRoute.peerId),
      pricing: input.referenceRoute.pricing,
      requestOverrides: {},
      requestOmissions: ['temperature', 'top_p'],
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
  }
}

function applyReferenceRouteToBody(
  route: ReferenceRequestRoute,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const routed: Record<string, unknown> = {
    ...body,
    ...route.requestOverrides,
    model: route.model,
  }
  for (const field of route.requestOmissions) delete routed[field]
  return routed
}

function isReferenceCachedResponse(value: unknown): value is ReferenceCachedResponseV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const common = typeof response.model === 'string'
    && typeof response.purpose === 'string'
    && ['candidate-generation', 'target-model', 'contrast-model', 'self-test'].includes(response.purpose)
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
