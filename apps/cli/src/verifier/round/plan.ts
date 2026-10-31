import {
  KBF_PROBES_PER_REQUEST,
  KBF_PROMPT_VARIANT_IDS,
  kbfTargetThinkingSuppression,
  type KbfProbe,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import { createDomainHomogeneousKbfBatches } from '../kbf-batching.js'
import { SeededStream, seededRanking, seededShuffle } from './seeded.js'
import {
  targetKey,
  type EnvelopeContentV1,
  type EnvelopeSliceV1,
  type EpochBankV1,
  type PlannedSliceV1,
  type RoundPlanV1,
  type RoundTargetV1,
} from './types.js'

export interface PlanInput {
  epoch: string
  seed: string
  probesPerService: number
  slicesPerService: number
  /** The epoch's verifier snapshot. */
  verifiers: readonly string[]
  targets: readonly RoundTargetV1[]
  bank: EpochBankV1
}

/** Canonical target order: agentId ascending, then serviceHash. Duplicates are dropped. */
export function sortTargets(targets: readonly RoundTargetV1[]): RoundTargetV1[] {
  const seen = new Set<string>()
  return [...targets]
    .map((target) => ({ ...target, peerId: target.peerId.toLowerCase().replace(/^0x/, ''), serviceHash: target.serviceHash.toLowerCase(), modelHash: target.modelHash.toLowerCase() }))
    .sort((left, right) => {
      const a = BigInt(left.agentId)
      const b = BigInt(right.agentId)
      if (a !== b) return a < b ? -1 : 1
      return BigInt(left.serviceHash) < BigInt(right.serviceHash) ? -1 : BigInt(left.serviceHash) > BigInt(right.serviceHash) ? 1 : 0
    })
    .filter((target) => {
      const key = targetKey(target)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/**
 * Derives the epoch's full sampling plan from public inputs. The publisher runs it to build
 * envelopes; after the bank key is revealed every verifier runs it again and only accepts
 * transcripts that ask exactly these questions.
 */
export function derivePlan(input: PlanInput): RoundPlanV1 {
  if (input.verifiers.length === 0) throw new Error('round plan needs at least one verifier')
  if (input.slicesPerService <= 0 || input.probesPerService < input.slicesPerService) {
    throw new Error('invalid probes/slices per service')
  }
  const targets = sortTargets(input.targets)
  const verifiers = input.verifiers.map((address) => address.toLowerCase())
  const targetProbes: Record<string, string[]> = {}
  const slices: PlannedSliceV1[] = []
  for (const target of targets) {
    const reference = input.bank.models[target.model]
    if (!reference) throw new Error(`bank has no reference for ${target.model}`)
    const key = targetKey(target)
    const canonical = [...reference.probes].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const selected = seededShuffle(canonical, input.seed, `probes|${key}`).slice(0, input.probesPerService)
    const batches = createDomainHomogeneousKbfBatches(selected, KBF_PROBES_PER_REQUEST, (values) => [...values])
    const variants = new SeededStream(input.seed, `variants|${key}`)
    const plannedBatches = batches.map((batch, batchIndex) => ({
      batchIndex,
      probeIds: batch.probes.map((probe) => probe.id),
      promptVariantId: KBF_PROMPT_VARIANT_IDS[variants.below(KBF_PROMPT_VARIANT_IDS.length)]!,
    }))
    targetProbes[key] = plannedBatches.flatMap((batch) => batch.probeIds)
    // A seller never collects its own slices.
    const eligible = verifiers.filter((address) => address.replace(/^0x/, '') !== target.peerId)
    const pool = eligible.length > 0 ? eligible : verifiers
    const sliceCount = Math.min(input.slicesPerService, plannedBatches.length)
    for (let sliceIndex = 0; sliceIndex < sliceCount; sliceIndex++) {
      const ranking = seededRanking(pool, input.seed, `slice|${key}|${sliceIndex}`)
      slices.push({
        targetKey: key,
        sliceIndex,
        batches: plannedBatches.filter((batch) => batch.batchIndex % sliceCount === sliceIndex),
        owner: ranking[0]!,
        backup: ranking[1] ?? ranking[0]!,
      })
    }
  }
  return { epoch: input.epoch, seed: input.seed, targets, targetProbes, slices }
}

/** The slices one collector must buy, with their questions but none of the bank's answers. */
export function envelopeFor(
  plan: RoundPlanV1,
  bank: EpochBankV1,
  collector: string,
  options: { backup: boolean; sliceFilter?: (slice: PlannedSliceV1) => boolean },
): EnvelopeContentV1 {
  const address = collector.toLowerCase()
  const byKey = new Map(plan.targets.map((target) => [targetKey(target), target]))
  const slices: EnvelopeSliceV1[] = []
  for (const slice of plan.slices) {
    if ((options.backup ? slice.backup : slice.owner) !== address) continue
    if (options.sliceFilter && !options.sliceFilter(slice)) continue
    const target = byKey.get(slice.targetKey)!
    const reference = bank.models[target.model]!
    const probesById = new Map(reference.probes.map((probe) => [probe.id, probe]))
    slices.push({
      target,
      sliceIndex: slice.sliceIndex,
      batches: slice.batches.map((batch) => ({
        ...batch,
        probes: batch.probeIds.map((id) => questionOnly(probesById.get(id)!)),
      })),
      request: requestSettings(reference),
    })
  }
  return { kind: 'antseed-kbf-envelope', version: 1, epoch: plan.epoch, collector: address, backup: options.backup, slices }
}

/** Request settings collectors use, from the model's reference. */
export function requestSettings(reference: KbfReferenceV1): EnvelopeSliceV1['request'] {
  const thinking = kbfTargetThinkingSuppression(reference)
  return {
    maxTokens: reference.queryProfile.maxTokensPerRequest,
    thinkingOverrides: thinking?.overrides ?? {},
    assistantPrefill: thinking?.assistantPrefill ?? null,
  }
}

/** A probe without its consensus answer or tolerance, so an envelope leaks no answers. */
export function questionOnly(probe: KbfProbe): KbfProbe {
  return {
    id: probe.id,
    name: probe.name,
    domain: probe.domain,
    template: probe.template,
    consensus: 0,
    range: [0, 0],
    tolerance: { mode: 'absolute', value: 0 },
  } as KbfProbe
}
