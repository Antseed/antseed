import { verifyKbf, type KbfReferenceV1, type VerifyKbfOptions } from '@antseed/fingerprints'
import { checkExchange } from './transcript.js'
import { parseSliceManifest } from './manifest-check.js'
import { buildResultsTree } from './merkle.js'
import { requestSettings } from './plan.js'
import {
  targetKey,
  type CollectorCreditV1,
  type EnvelopeSliceV1,
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
  /** Parsed JSON as committed; validated by `validManifests` before any use. */
  manifest: SliceManifestV1
}

interface UsableReference {
  probesById: Map<string, KbfReferenceV1['probes'][number]>
  settings: EnvelopeSliceV1['request']
}

/** Valid manifests by phase and collector, in commit order, so slices look up only their own candidates. */
type ManifestIndex = Map<string, CommittedManifest[]>

function indexManifests(manifests: readonly CommittedManifest[]): ManifestIndex {
  const index: ManifestIndex = new Map()
  for (const manifest of manifests) {
    const key = manifestKey(manifest.backup, manifest.collector)
    const entries = index.get(key) ?? []
    entries.push(manifest)
    index.set(key, entries)
  }
  return index
}

function manifestKey(backup: boolean, collector: string): string {
  return `${backup}:${collector.toLowerCase()}`
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
  const manifests = indexManifests(validManifests(input.manifests, plan.epoch))
  const targets = new Map(plan.targets.map((target) => [targetKey(target), target]))
  const slicesByTarget = new Map<string, PlannedSliceV1[]>()
  for (const slice of plan.slices) {
    const list = slicesByTarget.get(slice.targetKey) ?? []
    list.push(slice)
    slicesByTarget.set(slice.targetKey, list)
  }

  const credits = new Map<string, number>()
  const results: TargetResultV1[] = []
  const usableByModel = new Map<string, UsableReference>()
  for (const [key, target] of targets) {
    const reference = bank.models[target.model]
    if (!reference) throw new Error(`bank has no reference for ${target.model}`)
    let usable = usableByModel.get(target.model)
    if (!usable) {
      usable = usableReference(reference)
      usableByModel.set(target.model, usable)
    }
    const { probesById } = usable
    const planned = slicesByTarget.get(key) ?? []
    const used: Array<UsedSlice | null> = planned.map((slice) => pickSlice(slice, manifests, target, usable))
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
  return {
    kind: 'antseed-kbf-results', version: 1, epoch: plan.epoch, seed: plan.seed,
    results, credits: creditList, totalSlices,
    root: buildResultsTree(input.epoch, { results, credits: creditList, totalSlices }).root,
  }
}

/**
 * Manifests that parse as slice manifests of this epoch and were committed by the collector
 * they name, in the phase they claim. Malformed parts are dropped, never thrown on, so one
 * collector's bad commit cannot stop the epoch from being scored.
 */
export function validManifests(manifests: readonly CommittedManifest[], epoch: string): CommittedManifest[] {
  return manifests.flatMap((entry) => {
    const manifest = parseSliceManifest(entry.manifest)
    if (!manifest || manifest.epoch !== epoch || manifest.backup !== entry.backup) return []
    if (manifest.collector.toLowerCase() !== entry.collector.toLowerCase()) return []
    return [{ ...entry, manifest }]
  })
}

function usableReference(reference: KbfReferenceV1): UsableReference {
  return {
    probesById: new Map(reference.probes.map((probe) => [probe.id, probe])),
    settings: requestSettings(reference),
  }
}

/**
 * Prepares the check "did the slice's owner deliver a complete, validly signed primary copy?"
 * for a backup collector, before the bank key is out. Delivery depends only on the signed
 * exchanges matching the planned requests, which the backup envelope's questions and request
 * settings are enough to rebuild, so the answer is the one scoring will reach later.
 */
export function createEnvelopeDeliveryChecker(
  manifests: readonly CommittedManifest[],
  epoch: string,
): (slice: EnvelopeSliceV1, owner: string) => boolean {
  const primary = indexManifests(validManifests(manifests.filter((entry) => !entry.backup), epoch))
  return (slice, owner) => {
    const planned: PlannedSliceV1 = {
      targetKey: targetKey(slice.target),
      sliceIndex: slice.sliceIndex,
      batches: slice.batches.map(({ batchIndex, probeIds, promptVariantId }) => ({ batchIndex, probeIds, promptVariantId })),
      owner: owner.toLowerCase(),
      backup: '',
    }
    const usable: UsableReference = {
      probesById: new Map(slice.batches.flatMap((batch) => batch.probes.map((probe) => [probe.id, probe] as const))),
      settings: slice.request,
    }
    return pickSlice(planned, primary, slice.target, usable) !== null
  }
}

/**
 * The slice's primary delivery if its owner committed a complete, valid one before the commit
 * deadline, otherwise the backup collector's backup delivery, otherwise nothing. Each planned
 * batch needs exactly one exchange.
 */
function pickSlice(
  slice: PlannedSliceV1,
  manifests: ManifestIndex,
  target: TargetResultV1['target'],
  reference: UsableReference,
): UsedSlice | null {
  const candidates = [
    ...(manifests.get(manifestKey(false, slice.owner)) ?? []),
    ...(slice.backup && slice.backup !== slice.owner ? manifests.get(manifestKey(true, slice.backup)) ?? [] : []),
  ]
  for (const candidate of candidates) {
    const delivered = candidate.manifest.slices.find((entry) => entry.targetKey === slice.targetKey && entry.sliceIndex === slice.sliceIndex)
    if (!delivered) continue
    const answers = new Map<number, Array<number | null>>()
    let valid = true
    for (const batch of slice.batches) {
      const exchanges = delivered.exchanges.filter((exchange) => exchange.batchIndex === batch.batchIndex)
      if (exchanges.length !== 1) { valid = false; break }
      const probes = batch.probeIds.map((id) => reference.probesById.get(id))
      if (probes.some((probe) => probe === undefined)) { valid = false; break }
      const check = checkExchange(exchanges[0]!, target, batch, probes as KbfReferenceV1['probes'], reference.settings)
      if (!check.ok) { valid = false; break }
      answers.set(batch.batchIndex, check.answers)
    }
    if (valid) return { collector: candidate.collector.toLowerCase(), uri: candidate.uri, answers }
  }
  return null
}
