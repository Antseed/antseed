import { verifyKbf, type KbfReferenceV1, type VerifyKbfOptions } from '@antseed/fingerprints'
import { checkExchange } from './transcript.js'
import { ResultsTree, collectorLeaf, serviceLeaf } from './merkle.js'
import {
  targetKey,
  type CollectorCreditV1,
  type EpochBankV1,
  type PlannedSliceV1,
  type RoundPlanV1,
  type RoundResultsV1,
  type RoundVerdict,
  type SliceManifestV1,
  type TargetResultV1,
} from './types.js'

/**
 * Coverage required for a verdict. Both SAME and DIFF need 80% of the questions answered, so a
 * seller cannot earn SAME by leaving out the answers it would get wrong.
 */
export const ROUND_VERIFY_OPTIONS = { minCoverage: 0.8, minDiffCoverage: 0.8 } as const satisfies VerifyKbfOptions

/** A committed slice manifest whose bytes matched the on-chain root. */
export interface CommittedManifest {
  /** The address that committed it on-chain. */
  collector: string
  backup: boolean
  uri: string
  manifest: SliceManifestV1
}

interface UsedSlice {
  collector: string
  uri: string
  answers: Map<number, Array<number | null>>
}

/**
 * Scores the whole epoch from public data only: the revealed bank, the plan derived from the
 * seed, and the committed manifests. Deterministic: every honest verifier gets the same results
 * and the same root.
 */
export function scoreRound(input: {
  epoch: bigint
  plan: RoundPlanV1
  bank: EpochBankV1
  manifests: readonly CommittedManifest[]
}): RoundResultsV1 {
  const { plan, bank } = input
  const manifests = input.manifests.filter((entry) => entry.manifest.collector.toLowerCase() === entry.collector.toLowerCase()
    && entry.manifest.epoch === plan.epoch && entry.manifest.backup === entry.backup)
  const targets = new Map(plan.targets.map((target) => [targetKey(target), target]))
  const slicesByTarget = new Map<string, PlannedSliceV1[]>()
  for (const slice of plan.slices) {
    const list = slicesByTarget.get(slice.targetKey) ?? []
    list.push(slice)
    slicesByTarget.set(slice.targetKey, list)
  }

  const credits = new Map<string, number>()
  const results: TargetResultV1[] = []
  for (const [key, target] of targets) {
    const reference = bank.models[target.model]
    if (!reference) throw new Error(`bank has no reference for ${target.model}`)
    const probesById = new Map(reference.probes.map((probe) => [probe.id, probe]))
    const planned = slicesByTarget.get(key) ?? []
    const used: Array<UsedSlice | null> = planned.map((slice) => pickSlice(slice, manifests, target, probesById))
    const missing = used.filter((slice) => slice === null).length
    const probeIds = plan.targetProbes[key] ?? []
    const sources = planned.flatMap((slice, index) => {
      const source = used[index]
      return source ? slice.batches.map((batch) => ({ batchIndex: batch.batchIndex, collector: source.collector, uri: source.uri })) : []
    }).sort((left, right) => left.batchIndex - right.batchIndex)
      .map((source) => ({ batchIndex: source.batchIndex, collector: source.collector, manifestUri: source.uri }))
    for (const slice of used) {
      if (slice) credits.set(slice.collector, (credits.get(slice.collector) ?? 0) + 1)
    }
    if (missing > 0) {
      results.push({
        targetKey: key, target, verdict: 'UNDETERMINED',
        reason: `${missing} of ${planned.length} slices missing or invalid`,
        answeredProbes: 0, totalProbes: probeIds.length, sources,
      })
      continue
    }
    const answersById = new Map<string, number | null>()
    planned.forEach((slice, index) => {
      for (const batch of slice.batches) {
        const answers = used[index]!.answers.get(batch.batchIndex)!
        batch.probeIds.forEach((id, position) => answersById.set(id, answers[position] ?? null))
      }
    })
    const subset: KbfReferenceV1 = { ...reference, probes: probeIds.map((id) => probesById.get(id)!) }
    const evaluation = verifyKbf(subset, { answers: probeIds.map((id) => answersById.get(id) ?? null) }, ROUND_VERIFY_OPTIONS)
    const verdict: RoundVerdict = evaluation.verdict === 'SAME' || evaluation.verdict === 'DIFF' ? evaluation.verdict : 'UNDETERMINED'
    results.push({
      targetKey: key, target, verdict, reason: evaluation.verdictReason ?? evaluation.verdict,
      answeredProbes: evaluation.parsedProbeCount, totalProbes: probeIds.length, sources,
    })
  }

  const creditList: CollectorCreditV1[] = [...credits.entries()]
    .map(([collector, slices]) => ({ collector, slices }))
    .sort((left, right) => (left.collector < right.collector ? -1 : 1))
  const totalSlices = creditList.reduce((sum, entry) => sum + entry.slices, 0)
  const leaves = [
    ...results.map((result) => serviceLeaf(input.epoch, {
      agentId: BigInt(result.target.agentId), serviceHash: result.target.serviceHash,
      modelHash: result.target.modelHash, verdict: result.verdict,
    })),
    ...creditList.map((entry) => collectorLeaf(input.epoch, entry.collector, entry.slices, totalSlices)),
  ]
  return {
    kind: 'antseed-kbf-results', version: 1, epoch: plan.epoch, seed: plan.seed,
    results, credits: creditList, totalSlices, root: new ResultsTree(leaves).root,
  }
}

/** True when the slice's owner delivered a complete, validly signed primary copy. */
export function deliveredSlice(
  slice: PlannedSliceV1,
  manifests: readonly CommittedManifest[],
  target: TargetResultV1['target'],
  bank: EpochBankV1,
): boolean {
  const reference = bank.models[target.model]
  if (!reference) return false
  const primary = manifests.filter((entry) => !entry.backup)
  return pickSlice(slice, primary, target, new Map(reference.probes.map((probe) => [probe.id, probe]))) !== null
}

/**
 * The slice's primary delivery if its owner committed a complete, valid one before the commit
 * deadline, otherwise the backup collector's backup delivery, otherwise nothing. Each planned
 * batch needs exactly one exchange.
 */
function pickSlice(
  slice: PlannedSliceV1,
  manifests: readonly CommittedManifest[],
  target: TargetResultV1['target'],
  probesById: Map<string, KbfReferenceV1['probes'][number]>,
): UsedSlice | null {
  const candidates = [
    ...manifests.filter((entry) => !entry.backup && entry.collector.toLowerCase() === slice.owner),
    ...manifests.filter((entry) => entry.backup && entry.collector.toLowerCase() === slice.backup),
  ]
  for (const candidate of candidates) {
    const delivered = candidate.manifest.slices.find((entry) => entry.targetKey === slice.targetKey && entry.sliceIndex === slice.sliceIndex)
    if (!delivered) continue
    const answers = new Map<number, Array<number | null>>()
    let valid = true
    for (const batch of slice.batches) {
      const exchanges = delivered.exchanges.filter((exchange) => exchange.batchIndex === batch.batchIndex)
      if (exchanges.length !== 1) { valid = false; break }
      const check = checkExchange(exchanges[0]!, target, batch, batch.probeIds.map((id) => probesById.get(id)!))
      if (!check.ok) { valid = false; break }
      answers.set(batch.batchIndex, check.answers)
    }
    if (valid) return { collector: candidate.collector.toLowerCase(), uri: candidate.uri, answers }
  }
  return null
}
