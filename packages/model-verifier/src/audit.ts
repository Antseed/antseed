import { randomInt } from 'node:crypto'
import {
  ThinkingDiscoveryError,
  discoverThinkingSuppression,
  isKbfTokenLimitFinishReason,
  reportedReasoningTokens,
  stripKbfThinkBlocks,
  thinkingStrategyRequest,
  THINKING_DISCOVERY_PROBES,
  THINKING_DISCOVERY_TIMEOUT_MS,
  KBF_AUDIT_VERIFY_OPTIONS,
  KBF_LOW_COVERAGE_RETRIES,
  KBF_OPTIONAL_SAMPLING_FIELDS,
  KBF_PROBES_PER_REQUEST,
  kbfDomainBatches,
  KBF_PROMPT_VARIANT_IDS,
  buildKbfPrompt,
  computeBinomialPower,
  computeMatchVector,
  getKbfPromptVariant,
  isKbfSamplingFieldRejection,
  isKbfThinkingSuppressionRejection,
  kbfAuditBaseline,
  kbfTargetThinkingSuppression,
  hasMissingKbfAnswers,
  parseKbfAnswers,
  verifyKbf,
  type FingerprintEvaluation,
  type KbfProbe,
  type KbfReferenceV1,
  type MatchEntry,
  type ThinkingDiscoveryAttemptV1,
  type ThinkingDiscoveryProbe,
  type ThinkingDiscoveryStrategy,
} from '@antseed/fingerprints'
import type { ModelBatchRequest, ModelEndpoint } from './endpoint.js'

export interface AuditOptions {
  endpoint: ModelEndpoint
  reference: KbfReferenceV1
  /** Model id to send to the endpoint; defaults to the reference model. */
  model?: string
  /** Fixed probe count (multiple of 10); otherwise the smallest powered random subset. */
  probeCount?: number
  minimumPower?: number
  minCoverage?: number
  /** Fraction of answers a DIFF needs (default 0.8); below it a significant result is UNDETERMINED. */
  minDiffCoverage?: number
  concurrency?: number
  maxAttempts?: number
  /**
   * First discover how to turn off the endpoint's hidden reasoning, as the KBF reference code does
   * for every endpoint it queries (default true); see `AuditThinkingDiscovery`. False sends the
   * reference's thinking suppression and budget instead.
   */
  discoverThinking?: boolean
  signal?: AbortSignal
  /** Uniform integer in [0, max); injectable for deterministic tests. */
  randomInt?: (max: number) => number
  onBatch?: (progress: { completed: number; total: number }) => void
}

export interface AuditBatchRecord {
  batchIndex: number
  probeIds: string[]
  promptVariantId: string
  /** Sampling fields left out after the endpoint refused them; absent when the canonical request was sent. */
  omittedSamplingFields?: string[]
  /** True when the endpoint refused the reference's thinking suppression and the batch was sent without it. */
  omittedThinkingSuppression?: true
  /** True when the kept reply stopped at the token limit; its answers are not scored. */
  truncated?: true
  attempts: number
  status: 'succeeded' | 'failed'
  failureReason: string | null
  completion: string | null
  answers: Array<number | null>
  usage: { inputTokens: number; outputTokens: number } | null
  raw: { requestBase64: string; responseBase64: string; status: number } | null
}

/**
 * How the endpoint's hidden reasoning was turned off (KBF reference code `discover_thinking_strategy`):
 * each strategy was sent a fixed ten-question batch and the first giving at least 5 answers with
 * zero reasoning tokens is used (`bare` may think); else `bare-expanded`, 50x the token budget.
 */
export interface AuditThinkingDiscovery {
  method: 'kbf-reference-code-2026-09-30'
  /** Strategy the batches used; null when none worked and the reference's suppression was sent. */
  strategy: ThinkingDiscoveryStrategy | null
  /** `max_tokens` of each batch request. */
  maxTokens: number
  attempts: ThinkingDiscoveryAttemptV1[]
  failure?: string
}

export interface AuditResult {
  target: { endpoint: string; model: string }
  /** Absent when the audit ran with `discoverThinking: false`. */
  thinkingDiscovery?: AuditThinkingDiscovery
  referenceId: string
  referenceModel: string
  probeIds: string[]
  statisticalPower: number
  evaluation: FingerprintEvaluation
  batches: AuditBatchRecord[]
  startedAt: string
  completedAt: string
}

export async function auditEndpoint(options: AuditOptions): Promise<AuditResult> {
  const startedAt = new Date().toISOString()
  const draw = options.randomInt ?? ((max: number) => randomInt(max))
  const model = options.model ?? options.reference.queryProfile.upstreamModel
  const { probes: selected, power } = selectProbes(options.reference, {
    draw,
    minimumPower: options.minimumPower ?? 0.9,
    ...(options.probeCount !== undefined ? { probeCount: options.probeCount } : {}),
  })

  const thinkingDiscovery = options.discoverThinking === false ? null : await discoverEndpointThinking(options, model)
  const settings = batchSettings(options.reference, thinkingDiscovery)
  const batches = domainBatches(selected, KBF_PROBES_PER_REQUEST)
  // Answers come back batch by batch, so everything scored against them follows the batch order.
  const probes = batches.flat()
  const records: AuditBatchRecord[] = new Array(batches.length)
  let next = 0
  let completed = 0
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batchIndex = next++
      const variantId = KBF_PROMPT_VARIANT_IDS[draw(KBF_PROMPT_VARIANT_IDS.length)]!
      records[batchIndex] = await runBatch(options, model, batches[batchIndex]!, batchIndex, variantId, settings)
      completed++
      options.onBatch?.({ completed, total: batches.length })
    }
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, batches.length))
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (records.every((record) => record.status === 'failed')) throw new AuditNoAnswersError(records)

  const answers = records.flatMap((record) => record.answers)
  const transportFailed = records.flatMap((record) => record.answers.map(() => record.status === 'failed'))
  const subset: KbfReferenceV1 = { ...options.reference, probes }
  // A batch that never returned is a transport failure (null), not a wrong answer.
  const matchVector = computeMatchVector(answers, probes)
    .map((entry, index): MatchEntry => (transportFailed[index] ? null : entry))
  const evaluation = verifyKbf(subset, { answers, matchVector }, {
    minCoverage: options.minCoverage ?? KBF_AUDIT_VERIFY_OPTIONS.minCoverage,
    minDiffCoverage: options.minDiffCoverage ?? KBF_AUDIT_VERIFY_OPTIONS.minDiffCoverage,
  })

  return {
    target: { endpoint: options.endpoint.label, model },
    ...(thinkingDiscovery ? { thinkingDiscovery } : {}),
    referenceId: options.reference.referenceId,
    referenceModel: options.reference.referenceModel,
    probeIds: probes.map((probe) => probe.id),
    statisticalPower: power,
    evaluation,
    batches: records,
    startedAt,
    completedAt: new Date().toISOString(),
  }
}

/**
 * Thrown when the endpoint answered no batch at all (wrong key, URL or model id, or the
 * endpoint is down). That is a setup error, not an UNDETERMINED verdict.
 */
export class AuditNoAnswersError extends Error {
  readonly batches: AuditBatchRecord[]

  constructor(batches: AuditBatchRecord[]) {
    const reasons = new Map<string, number>()
    for (const batch of batches) {
      const reason = batch.failureReason ?? 'unknown failure'
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
    const [reason] = [...reasons.entries()].sort((left, right) => right[1] - left[1])[0] ?? ['unknown failure']
    super(`the endpoint answered none of the ${batches.length} requests, so no verdict: ${reason}${hintFor(reason)}`)
    this.name = 'AuditNoAnswersError'
    this.batches = batches
  }
}

function hintFor(reason: string): string {
  if (/^HTTP 40[13]\b/.test(reason)) return ' (check the API key)'
  if (/^HTTP 404\b/.test(reason)) return ' (check the base URL and model id)'
  if (/^HTTP 400\b/.test(reason)) return ' (check the model id and protocol)'
  if (!reason.startsWith('HTTP ')) return ' (check the base URL; the endpoint may be down)'
  return ''
}

/**
 * Picks a fresh random probe subset and order for this audit. Without a fixed size it
 * grows in steps of ten until the subset's own reference baseline gives the required
 * statistical power, falling back to every probe. A calibrated reference is an epoch question
 * set whose limit was measured on its own batches, so without a fixed size it is asked whole and
 * in its stored order, in those batches.
 */
export function selectProbes(
  reference: KbfReferenceV1,
  options: { draw: (max: number) => number; minimumPower: number; probeCount?: number },
): { probes: KbfProbe[]; power: number } {
  const shuffled = shuffle(reference.probes, options.draw)
  const powerOf = (probes: readonly KbfProbe[]): number => {
    const selfTest = kbfAuditBaseline(reference, probes.map((probe) => probe.id))
    return computeBinomialPower({
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      probeCount: probes.length,
      minimumMismatchDelta: reference.minimumMismatchDelta,
      alpha: reference.statisticalPowerEvidence.alpha,
      cpConfidence: reference.statisticalPowerEvidence.clopperPearsonConfidence,
    }).power
  }
  if (options.probeCount !== undefined) {
    const count = options.probeCount
    if (!Number.isInteger(count) || count < KBF_PROBES_PER_REQUEST || count % KBF_PROBES_PER_REQUEST !== 0
      || count > shuffled.length) {
      throw new Error(`probe count must be a multiple of ${KBF_PROBES_PER_REQUEST} up to ${shuffled.length}`)
    }
    const probes = shuffled.slice(0, count)
    return { probes, power: powerOf(probes) }
  }
  if (reference.calibration) return { probes: [...reference.probes], power: powerOf(reference.probes) }
  for (let count = KBF_PROBES_PER_REQUEST; count <= shuffled.length; count += KBF_PROBES_PER_REQUEST) {
    const probes = shuffled.slice(0, count)
    const power = powerOf(probes)
    if (power >= options.minimumPower) return { probes, power }
  }
  return { probes: shuffled, power: powerOf(shuffled) }
}

async function runBatch(
  options: AuditOptions,
  model: string,
  probes: readonly KbfProbe[],
  batchIndex: number,
  promptVariantId: string,
  settings: BatchSettings,
): Promise<AuditBatchRecord> {
  const maxAttempts = options.maxAttempts ?? 3
  const profile = options.reference.queryProfile
  const request: ModelBatchRequest = {
    model,
    system: getKbfPromptVariant(promptVariantId).systemPrompt,
    user: buildKbfPrompt(probes, 0, promptVariantId),
    // No top_p: the KBF reference code sends only model, messages, temperature
    // and max_tokens, and several upstreams reject top_p.
    temperature: profile.auditTemperature,
    maxTokens: settings.maxTokens,
    ...(settings.timeoutMs ? { timeoutMs: settings.timeoutMs } : {}),
  }
  // The endpoint's own discovered suppression, or the reference's without discovery.
  const thinking = settings.thinking
  if (thinking) {
    if (Object.keys(thinking.overrides).length > 0) request.extraBody = { ...thinking.overrides }
    if (thinking.assistantPrefill) request.assistantPrefill = thinking.assistantPrefill
  }
  let omittedThinking = false
  let lastFailure = 'not attempted'
  let omittedSampling = false
  let calls = 0
  let lowCoverageRetries = 0
  let best: { record: AuditBatchRecord; scored: number } | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await options.endpoint.call(request, options.signal)
    calls++
    if (!result.ok && thinking && !omittedThinking && isKbfThinkingSuppressionRejection(result.status, result.message)) {
      omittedThinking = true
      delete request.extraBody
      delete request.assistantPrefill
      attempt--
      continue
    }
    if (!result.ok && !omittedSampling && isKbfSamplingFieldRejection(result.status, result.message)) {
      omittedSampling = true
      delete request.temperature
      attempt--
      continue
    }
    if (result.ok) {
      // As the reference code does before parsing, `<think>…</think>` blocks are not answers.
      // A reply cut off at the token limit is not scored: the model was still writing, so
      // its numbers may come from reasoning rather than answers. It is asked again below.
      const truncated = isKbfTokenLimitFinishReason(result.finishReason)
      const answers = truncated
        ? probes.map(() => null)
        : parseKbfAnswers(stripKbfThinkBlocks(result.text), probes.length)
      const matches = computeMatchVector(answers, probes)
      const scored = matches.filter((match) => match !== null).length
      const record: AuditBatchRecord = {
        batchIndex,
        probeIds: probes.map((probe) => probe.id),
        promptVariantId,
        ...(omittedSampling ? { omittedSamplingFields: [...KBF_OPTIONAL_SAMPLING_FIELDS] } : {}),
        ...(omittedThinking ? { omittedThinkingSuppression: true as const } : {}),
        ...(truncated ? { truncated: true as const } : {}),
        attempts: calls,
        status: 'succeeded',
        failureReason: null,
        completion: result.text,
        answers,
        usage: result.usage ?? null,
        raw: {
          requestBase64: Buffer.from(result.raw.request).toString('base64'),
          responseBase64: Buffer.from(result.raw.response).toString('base64'),
          status: result.raw.status,
        },
      }
      if (!best || scored > best.scored) best = { record, scored }
      // Any missing or unreadable answer means the batch is asked again (up to twice),
      // keeping the attempt with the most answers. KBF re-asks only above half missing;
      // audits ask for every answer because a DIFF needs 80% of them.
      if (hasMissingKbfAnswers(matches) && lowCoverageRetries < KBF_LOW_COVERAGE_RETRIES) {
        lowCoverageRetries++
        attempt--
        continue
      }
      return { ...best.record, attempts: calls }
    }
    lastFailure = result.message
    if (best) return { ...best.record, attempts: calls }
    if (!result.retryable || attempt === maxAttempts) break
    await delay(result.retryAfterMs ?? 1000 * 2 ** (attempt - 1), options.signal)
  }
  if (best) return { ...best.record, attempts: calls }
  return {
    batchIndex,
    probeIds: probes.map((probe) => probe.id),
    promptVariantId,
    attempts: maxAttempts,
    status: 'failed',
    failureReason: lastFailure,
    completion: null,
    answers: probes.map(() => null),
    usage: null,
    raw: null,
  }
}

interface BatchSettings {
  thinking: { overrides: Record<string, unknown>; assistantPrefill?: string } | null
  maxTokens: number
  timeoutMs?: number
}

function batchSettings(reference: KbfReferenceV1, discovery: AuditThinkingDiscovery | null): BatchSettings {
  const budget = reference.queryProfile.maxTokensPerRequest
  if (!discovery || discovery.strategy === null) return { thinking: kbfTargetThinkingSuppression(reference), maxTokens: budget }
  const request = thinkingStrategyRequest(discovery.strategy)
  const thinking = Object.keys(request.overrides).length === 0 && !request.assistantPrefill
    ? null
    : { overrides: request.overrides, ...(request.assistantPrefill ? { assistantPrefill: request.assistantPrefill } : {}) }
  return {
    thinking,
    maxTokens: discovery.maxTokens,
    // An endpoint that thinks on every request gets as long per request as discovery gave it.
    ...(discovery.strategy === 'bare-expanded' ? { timeoutMs: THINKING_DISCOVERY_TIMEOUT_MS } : {}),
  }
}

/**
 * `discover_thinking_strategy` from the KBF reference code, run on the audited endpoint as the
 * reference code runs it on every endpoint it queries. When nothing works (the endpoint is down or
 * refuses every request), the batches send the reference's suppression and record what went wrong.
 */
async function discoverEndpointThinking(options: AuditOptions, model: string): Promise<AuditThinkingDiscovery> {
  const budget = options.reference.queryProfile.maxTokensPerRequest
  let omitTemperature = false
  // An endpoint that failed every try of two strategies in a row with no answer is down, not
  // refusing a field. One failed strategy is not enough: a brief outage would drop the discovery.
  let unreachable: { status: number | null; failure: string } | null = null
  let outages = 0
  const probe: ThinkingDiscoveryProbe = async ({ request, maxTokens }) => {
    if (unreachable) return { ok: false, ...unreachable, failure: `not sent, endpoint unreachable: ${unreachable.failure}` }
    let failure: { status: number | null; failure: string } = { status: null, failure: 'not attempted' }
    // As in the reference code: 429, 5xx and network errors are tried up to three times, and any
    // other 4xx means the endpoint refuses this strategy.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const call: ModelBatchRequest = {
        model,
        system: getKbfPromptVariant().systemPrompt,
        user: buildKbfPrompt(THINKING_DISCOVERY_PROBES),
        maxTokens,
        // An endpoint not suppressed yet is still thinking, so this is the slowest request sent.
        timeoutMs: THINKING_DISCOVERY_TIMEOUT_MS,
        ...(omitTemperature ? {} : { temperature: 0 }),
        ...(Object.keys(request.overrides).length > 0 ? { extraBody: { ...request.overrides } } : {}),
        ...(request.assistantPrefill ? { assistantPrefill: request.assistantPrefill } : {}),
      }
      const result = await options.endpoint.call(call, options.signal)
      if (result.ok) {
        outages = 0
        return {
          ok: true,
          content: result.text,
          reasoningTokens: reportedReasoningTokens(Buffer.from(result.raw.response).toString('utf8')),
          truncated: isKbfTokenLimitFinishReason(result.finishReason),
        }
      }
      // A 2xx without completion text is an answer with nothing parseable (the model ran out of
      // tokens thinking), as the reference code counts it, not a failure to retry.
      if (result.status !== undefined && result.status >= 200 && result.status < 300) {
        outages = 0
        return { ok: true, content: null, reasoningTokens: 0 }
      }
      failure = { status: result.status ?? null, failure: result.message.slice(0, 300) }
      if (!omitTemperature && isKbfSamplingFieldRejection(result.status, result.message)) {
        omitTemperature = true
        continue
      }
      if (!result.retryable) {
        outages = 0
        return { ok: false, ...failure }
      }
      if (attempt < 3) await delay(result.retryAfterMs ?? 5000 * 3 ** (attempt - 1), options.signal)
    }
    if (failure.status === null || failure.status >= 500 || failure.status === 429) {
      outages += 1
      if (outages >= 2) unreachable = failure
    }
    return { ok: false, ...failure }
  }
  try {
    const found = await discoverThinkingSuppression({
      model,
      label: options.endpoint.label,
      supportsPrefill: options.endpoint.supportsPrefill ?? true,
      probe,
    })
    return {
      method: 'kbf-reference-code-2026-09-30',
      strategy: found.strategy,
      maxTokens: Math.max(budget, found.maxTokens ?? 0),
      attempts: found.attempts,
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    return {
      method: 'kbf-reference-code-2026-09-30',
      strategy: null,
      maxTokens: budget,
      attempts: error instanceof ThinkingDiscoveryError ? error.attempts : [],
      failure: error instanceof Error ? error.message : String(error),
    }
  }
}

function shuffle<T>(items: readonly T[], draw: (max: number) => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = draw(i + 1)
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

/**
 * Batches holding one domain each, keeping the given order inside a domain (`kbfDomainBatches`, as
 * `antseed verifier run` batches). A reference's consensus and self-test error are measured on
 * single-domain batches, and answers shift when the questions around them do: mixing domains nearly
 * doubled genuine MiniMax M3's mismatches (about 17% to 27%) and read as a DIFF.
 */
function domainBatches(probes: readonly KbfProbe[], size: number): KbfProbe[][] {
  return kbfDomainBatches(probes, size).map((batch) => batch.probes)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}
