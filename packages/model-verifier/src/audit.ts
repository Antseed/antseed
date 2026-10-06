import { randomInt } from 'node:crypto'
import {
  KBF_PROBES_PER_REQUEST,
  KBF_PROMPT_VARIANT_IDS,
  buildKbfPrompt,
  computeBinomialPower,
  computeMatchVector,
  getKbfPromptVariant,
  parseKbfAnswers,
  subsetReferenceSelfTest,
  verifyKbf,
  type FingerprintEvaluation,
  type KbfProbe,
  type KbfReferenceV1,
  type MatchEntry,
} from '@antseed/fingerprints'
import type { ModelEndpoint } from './endpoint.js'

export interface AuditOptions {
  endpoint: ModelEndpoint
  reference: KbfReferenceV1
  /** Model id to send to the endpoint; defaults to the reference model. */
  model?: string
  /** Fixed probe count (multiple of 10); otherwise the smallest powered random subset. */
  probeCount?: number
  minimumPower?: number
  minCoverage?: number
  concurrency?: number
  maxAttempts?: number
  signal?: AbortSignal
  /** Uniform integer in [0, max); injectable for deterministic tests. */
  randomInt?: (max: number) => number
  onBatch?: (progress: { completed: number; total: number }) => void
}

export interface AuditBatchRecord {
  batchIndex: number
  probeIds: string[]
  promptVariantId: string
  attempts: number
  status: 'succeeded' | 'failed'
  failureReason: string | null
  completion: string | null
  answers: Array<number | null>
  usage: { inputTokens: number; outputTokens: number } | null
  raw: { requestBase64: string; responseBase64: string; status: number } | null
}

export interface AuditResult {
  target: { endpoint: string; model: string }
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
  const { probes, power } = selectProbes(options.reference, {
    draw,
    minimumPower: options.minimumPower ?? 0.9,
    ...(options.probeCount !== undefined ? { probeCount: options.probeCount } : {}),
  })

  const batches = chunk(probes, KBF_PROBES_PER_REQUEST)
  const records: AuditBatchRecord[] = new Array(batches.length)
  let next = 0
  let completed = 0
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batchIndex = next++
      const variantId = KBF_PROMPT_VARIANT_IDS[draw(KBF_PROMPT_VARIANT_IDS.length)]!
      records[batchIndex] = await runBatch(options, model, batches[batchIndex]!, batchIndex, variantId)
      completed++
      options.onBatch?.({ completed, total: batches.length })
    }
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, batches.length))
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  const answers = records.flatMap((record) => record.answers)
  const transportFailed = records.flatMap((record) => record.answers.map(() => record.status === 'failed'))
  const subset: KbfReferenceV1 = { ...options.reference, probes }
  // A batch that never returned is a transport failure (null), not a wrong answer.
  const matchVector = computeMatchVector(answers, probes)
    .map((entry, index): MatchEntry => (transportFailed[index] ? null : entry))
  const evaluation = verifyKbf(subset, { answers, matchVector }, { minCoverage: options.minCoverage ?? 0.8 })

  return {
    target: { endpoint: options.endpoint.label, model },
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
 * Picks a fresh random probe subset and order for this audit. Without a fixed size it
 * grows in steps of ten until the subset's own reference self-test gives the required
 * statistical power, falling back to every probe.
 */
export function selectProbes(
  reference: KbfReferenceV1,
  options: { draw: (max: number) => number; minimumPower: number; probeCount?: number },
): { probes: KbfProbe[]; power: number } {
  const shuffled = shuffle(reference.probes, options.draw)
  const powerOf = (probes: readonly KbfProbe[]): number => {
    const selfTest = subsetReferenceSelfTest(reference, probes.map((probe) => probe.id))
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
): Promise<AuditBatchRecord> {
  const maxAttempts = options.maxAttempts ?? 3
  const profile = options.reference.queryProfile
  const request = {
    model,
    system: getKbfPromptVariant(promptVariantId).systemPrompt,
    user: buildKbfPrompt(probes, 0, promptVariantId),
    temperature: profile.auditTemperature,
    topP: profile.generationSettings.topP,
    maxTokens: profile.maxTokensPerRequest,
  }
  let lastFailure = 'not attempted'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await options.endpoint.call(request, options.signal)
    if (result.ok) {
      return {
        batchIndex,
        probeIds: probes.map((probe) => probe.id),
        promptVariantId,
        attempts: attempt,
        status: 'succeeded',
        failureReason: null,
        completion: result.text,
        answers: parseKbfAnswers(result.text, probes.length),
        usage: result.usage ?? null,
        raw: {
          requestBase64: Buffer.from(result.raw.request).toString('base64'),
          responseBase64: Buffer.from(result.raw.response).toString('base64'),
          status: result.raw.status,
        },
      }
    }
    lastFailure = result.message
    if (!result.retryable || attempt === maxAttempts) break
    await delay(result.retryAfterMs ?? 1000 * 2 ** (attempt - 1), options.signal)
  }
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

function shuffle<T>(items: readonly T[], draw: (max: number) => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = draw(i + 1)
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
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
