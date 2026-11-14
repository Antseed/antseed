import { randomInt } from 'node:crypto'
import { access, copyFile, mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import {
  KBF_CALIBRATION_PASSES,
  KBF_MAX_PROBE_COUNT,
  KBF_PROBES_PER_REQUEST,
  KBF_REFERENCE_VERSION,
  aggregateKbfSelfTestOutcomes,
  canonicalHashBytes32,
  clopperPearsonUpper,
  computeBinomialPower,
  computeContrastDetection,
  computeReferenceId,
  referenceCompatibilityProfileHash,
  rescoreKbfReference,
  rescoreKbfSelfTestOutcome,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceCalibrationV1,
  type KbfReferenceV1,
  type ReferenceProbeSelfTestV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import { acquirePidFileLock, readJsonIfExists, writeJsonAtomic } from './atomic-files.js'
import { REFERENCE_BUILDER_VERSION } from './reference-version.js'
import type {
  ReferenceBuildCostV1,
  ReferenceExchangesFileV1,
  ReferenceUpstreamProvenanceV1,
} from './model-reference.js'
import { excludedVerifierDomains } from './model-config.js'
import {
  isReferenceProbeCountAllowed,
  REFERENCE_MAXIMUM_SELF_TEST_ERROR_RATE,
  resolveReferenceSizingPolicy,
} from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'
import { normalized } from './utils.js'

interface BankProbeV1 {
  probe: KbfProbe
  selfTest: ReferenceProbeSelfTestV1
  distinguishingContrastModels: string[]
  /**
   * Contrast models that returned a parseable answer for this probe. Absent on
   * banks built before it was recorded; every contrast then counts as answered.
   */
  answeredContrastModels?: string[]
}

export interface ProbeBankV1 {
  version: 1
  kind: 'antseed-kbf-probe-bank'
  model: string
  compatibilityHash: string
  queryProfile: KbfReferenceV1['queryProfile']
  referenceTemplate: Pick<KbfReferenceV1,
    'referenceModel' | 'serviceAliases' | 'source' | 'generator' | 'provenance'
    | 'minimumMismatchDelta'>
  statisticalAssumptions: {
    alpha: number
    clopperPearsonConfidence: number
  }
  contrastModels: string[]
  probes: BankProbeV1[]
  sourceReferenceIds: string[]
  referenceCosts: ReferenceCostEntryV1[]
  /** Raw upstream exchanges of each build that added probes; absent on older banks. */
  referenceExchanges?: BankReferenceExchangesV1[]
  createdAt: string
  updatedAt: string
}

export interface BankReferenceExchangesV1 {
  referenceId: string
  /** Relative to the model's bank directory. */
  path: string
  sha256: string
  upstream: ReferenceUpstreamProvenanceV1
  exchangeCount: number
  requestCount: number
}

export interface ReferenceCostEntryV1 {
  costId: string
  referenceId: string
  cost: ReferenceBuildCostV1
  status: 'unclaimed' | 'reserved' | 'claimed'
  reservedEvidenceHash: string | null
  claimedTransactionHash: string | null
}

export interface SellerProbeLedgerV1 {
  version: 1
  kind: 'antseed-kbf-seller-probe-ledger'
  model: string
  sellerPeerId: string
  assignments: Array<{
    auditId: string
    runId: string
    epoch: string
    service: string
    referenceId: string
    probeIds: string[]
    /** How the subset and order were drawn. Absent on legacy shared-epoch assignments. */
    selection?: SellerProbeSelectionMethod
    /** Set on the extra set reserved to decide a close-call first audit (`kbf-extension-v1` / `-v2`). */
    purpose?: 'extension'
    /** Which extra set of a close call this is (1 or 2); absent means 1. */
    extensionIndex?: number
    reservedAt: string
    voidedAt?: string
    voidReason?: string
  }>
}

export interface EpochProbeReferenceV1 {
  version: 1
  kind: 'antseed-kbf-epoch-probe-reference'
  model: string
  epoch: string
  compatibilityHash: string
  reference: KbfReferenceV1
  createdAt: string
  createdByRunId: string
}

/**
 * Legacy: each seller got its own probe subset and order, drawn from a CSPRNG shuffle of the bank
 * probes it had not been assigned in an earlier epoch. Read-only now (runs from earlier epochs).
 */
export const SELLER_PROBE_SELECTION_METHOD = 'per-seller-csprng-shuffle-v1'
/**
 * One question set per auditor, model and epoch (`epochs/<epoch>/set.json`): every seller of the
 * model gets the same questions in the same order, and every close call the same extra sets. The set
 * is built fresh for the epoch, never contains a question asked before (matched by its text, not
 * only its id), and is not used again after its epoch.
 */
export const EPOCH_QUESTION_SET_METHOD = 'epoch-shared-set-v1'
export type SellerProbeSelectionMethod = typeof SELLER_PROBE_SELECTION_METHOD | typeof EPOCH_QUESTION_SET_METHOD
/** No question set for the model and epoch yet (or it has no extra set for a close call). */
export const NO_EPOCH_QUESTION_SET = 'NO_EPOCH_QUESTION_SET'

export interface EpochQuestionSetV1 {
  version: 1
  kind: 'antseed-kbf-epoch-question-set'
  method: typeof EPOCH_QUESTION_SET_METHOD
  model: string
  epoch: string
  compatibilityHash: string
  /** Fresh questions built for this epoch that were eligible for the set. */
  candidateProbeCount: number
  /** Fresh questions left out because a question with the same text was asked before. */
  previouslyAskedProbeCount: number
  /** The audit set every seller gets, power-sized like any reference. */
  reference: KbfReferenceV1
  /** The extra sets for close calls, in order, each as large as `reference`. */
  extensions: KbfReferenceV1[]
  /** Absent until the set is calibrated; no seller is asked before it says `passed`. */
  calibration?: EpochSetCalibrationV1
  createdAt: string
  createdByRunId: string
  /** Set on a set a submit published (`set.published-<n>.json`): no seller is asked it again. */
  retired?: EpochQuestionSetRetirementV1
}

/** When, and in which submit, a question set or pool was published and retired. */
export interface EpochQuestionSetRetirementV1 {
  at: string
  runId: string
  /**
   * The bank's reference exchange files at the retire (`<referenceId> <sha256>`): everything they hold
   * was banked by then, so it was in this pool or set or an earlier one. Absent on records from before.
   */
  bankExchanges?: string[]
}

/** Below this share of answers on any set, a calibration stops the model's audit for the epoch. */
export const CALIBRATION_MINIMUM_COVERAGE = 0.8

/**
 * Whether the reference still answers this epoch's set as it did at enrollment, judged on the audit
 * set and the extra sets together. The trials themselves are in each reference's `calibration`.
 */
export interface EpochSetCalibrationV1 {
  version: 1
  status: 'passed' | 'failed'
  /** Why a failed calibration stopped the model; its audits wait for the next epoch's set. */
  failureReason?: string
  passes: number
  hamming: number
  total: number
  errorRate: number
  /** Lowest coverage of any one set. */
  minimumCoverage: number
  /**
   * 99% Clopper-Pearson limit of the same probes' enrollment self-test. A rate above it stops nothing:
   * `verifier run` warns that the reference may have changed (see `calibrationFailure`).
   */
  enrollmentErrorLimit: number
  requestCount: number
  costUsdMicros: string
  completedAt: string
  /** The trials of a failed calibration, which no reference carries. */
  failedCalibrations?: KbfReferenceCalibrationV1[]
}

/** Probes the builds for one epoch's set added to the bank; only these can be in the set. */
interface EpochQuestionPoolV1 {
  version: 1
  kind: 'antseed-kbf-epoch-question-pool'
  model: string
  epoch: string
  probeIds: string[]
  /** Set on a pool a submit published (`pool.published-<n>.json`). */
  retired?: EpochQuestionSetRetirementV1
}

export interface SellerEpochProbeReferenceV1 {
  version: 1
  kind: 'antseed-kbf-seller-epoch-probe-reference'
  model: string
  epoch: string
  sellerPeerId: string
  compatibilityHash: string
  selection: {
    method: SellerProbeSelectionMethod
    eligibleProbeCount: number
    excludedPreviouslyAssignedProbeCount: number
    allowProbeReuse: boolean
  }
  /** Set on a close-call extension set, which is not power-sized on its own. */
  purpose?: 'extension'
  /** Which extra set of a close call this is (1 or 2); absent means 1. */
  extensionIndex?: number
  reference: KbfReferenceV1
  createdAt: string
  createdByRunId: string
}

export interface ProbeBankPowerStatus {
  totalProbeCount: number
  eligibleProbeCount: number
  selectedProbeCount: number | null
  statisticalPower: number | null
}

export async function appendModelReferenceToBank(input: {
  banksDir: string
  model: string
  reference: KbfReferenceV1
  cost: ReferenceBuildCostV1
  answeredContrastModelsByProbeId?: ReadonlyMap<string, readonly string[]>
  /** Raw upstream exchanges of this build; copied into the bank so they survive the next build. */
  exchanges?: ReferenceExchangesFileV1
}): Promise<{
  path: string
  addedProbeCount: number
  /** Ids of the probes this append added, in reference order. */
  addedProbeIds: string[]
  canonicalConflictProbeCount: number
  totalProbeCount: number
}> {
  const path = bankPath(input.banksDir, input.model)
  const lock = await acquirePidFileLock(join(dirname(path), '.bank.lock'))
  try {
    const validatedReference = validateKbfReferenceV1(input.reference, {
      trustImported: true,
      minimumStatisticalPower: Number.EPSILON,
    })
    const existing = await readBankFile(path)
    const incoming = bankFromReference(
      input.model,
      validatedReference,
      input.cost,
      input.answeredContrastModelsByProbeId,
    )
    const exchanges = input.exchanges
      ? await storeBankExchanges(dirname(path), validatedReference.referenceId, input.exchanges)
      : undefined
    if (!existing) {
      if (exchanges) incoming.referenceExchanges = [exchanges]
      await writeJsonAtomic(path, incoming)
      return {
        path,
        addedProbeCount: incoming.probes.length,
        addedProbeIds: incoming.probes.map((entry) => entry.probe.id),
        canonicalConflictProbeCount: 0,
        totalProbeCount: incoming.probes.length,
      }
    }
    const bank = existing
    if (!Array.isArray(bank.referenceCosts)) bank.referenceCosts = []
    // Service names (aliases) only say what sellers call the model, not how answers are measured,
    // so a reference built after the alias list changed still joins the bank under its aliases.
    if (existing && existing.compatibilityHash !== probeBankCompatibilityHash(input.model, {
      ...validatedReference, serviceAliases: existing.referenceTemplate.serviceAliases,
    })) {
      throw new Error(`probe bank for ${input.model} is incompatible with the new reference`)
    }
    const byId = new Map(bank.probes.map((entry) => [entry.probe.id, entry]))
    const addedProbeIds: string[] = []
    let canonicalConflictProbeCount = 0
    for (const entry of incoming.probes) {
      const previous = byId.get(entry.probe.id)
      if (!previous) {
        bank.probes.push(entry)
        byId.set(entry.probe.id, entry)
        addedProbeIds.push(entry.probe.id)
        continue
      }
      if (canonicalHashBytes32(canonicalBankProbe(previous.probe))
        !== canonicalHashBytes32(canonicalBankProbe(entry.probe))) {
        canonicalConflictProbeCount += 1
        continue
      }
      previous.distinguishingContrastModels = [...new Set([
        ...previous.distinguishingContrastModels,
        ...entry.distinguishingContrastModels,
      ])].sort()
      if (previous.answeredContrastModels && entry.answeredContrastModels) {
        previous.answeredContrastModels = [...new Set([
          ...previous.answeredContrastModels,
          ...entry.answeredContrastModels,
        ])].sort()
      } else {
        delete previous.answeredContrastModels
      }
    }
    bank.contrastModels = [...incoming.contrastModels].sort()
    if (!bank.sourceReferenceIds.includes(validatedReference.referenceId)) {
      bank.sourceReferenceIds.push(validatedReference.referenceId)
    }
    if (!bank.referenceCosts.some((entry) => entry.referenceId === validatedReference.referenceId)) {
      bank.referenceCosts.push(...incoming.referenceCosts)
    }
    if (exchanges && !bank.referenceExchanges?.some((entry) => entry.referenceId === exchanges.referenceId)) {
      bank.referenceExchanges = [...(bank.referenceExchanges ?? []), exchanges]
    }
    bank.updatedAt = new Date().toISOString()
    await writeJsonAtomic(path, bank)
    return { path, addedProbeCount: addedProbeIds.length, addedProbeIds, canonicalConflictProbeCount, totalProbeCount: bank.probes.length }
  } finally {
    await lock.release()
  }
}

async function storeBankExchanges(
  bankDirectory: string,
  referenceId: string,
  exchanges: ReferenceExchangesFileV1,
): Promise<BankReferenceExchangesV1> {
  const target = join(bankDirectory, 'reference-evidence', `${referenceId.replace(/^0x/, '').slice(0, 16)}.exchanges.json`)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(exchanges.path, target)
  return {
    referenceId,
    path: relative(bankDirectory, target).split(sep).join('/'),
    sha256: exchanges.sha256,
    upstream: exchanges.upstream,
    exchangeCount: exchanges.exchangeCount,
    requestCount: exchanges.requestCount,
  }
}

/**
 * The bank's recorded reference exchange files that are not on disk. Every audit submission
 * publishes them, so a missing one would fail the submission after the whole run.
 */
export async function missingBankReferenceExchanges(banksDir: string, model: string): Promise<string[]> {
  const missing: string[] = []
  for (const entry of await loadBankReferenceExchanges(banksDir, model)) {
    try {
      await access(entry.absolutePath)
    } catch {
      missing.push(entry.path)
    }
  }
  return missing
}

/** Raw reference exchanges stored with a model's bank, with absolute paths. */
export async function loadBankReferenceExchanges(
  banksDir: string,
  model: string,
): Promise<Array<BankReferenceExchangesV1 & { absolutePath: string }>> {
  const path = bankPath(banksDir, model)
  const bank = await readBankFile(path)
  return (bank?.referenceExchanges ?? []).map((entry) => ({ ...entry, absolutePath: join(dirname(path), entry.path) }))
}

function canonicalBankProbe(probe: KbfProbe): Record<string, unknown> {
  return Object.fromEntries(Object.entries(probe).filter(([key]) => ![
    'contrast',
    'generationRound',
    'generationTheme',
  ].includes(key)))
}

/**
 * Reserves this epoch's question set (`epochs/<epoch>/set.json`) for one seller audit: every seller
 * of the model gets the same questions. The seller's ledger records the reservation, so a resumed
 * run finds it and a failed audit can be voided; it no longer decides which questions a seller gets.
 */
export async function reserveModelAuditReference(input: {
  banksDir: string
  model: string
  sellerPeerId: string
  service: string
  runId: string
  epoch: string
  config?: VerifierCLIConfig
  now?: () => number
}): Promise<{ reference: KbfReferenceV1; auditId: string; ledgerPath: string }> {
  const ledgerPath = sellerLedgerPath(input.banksDir, input.model, input.sellerPeerId)
  const lock = await acquirePidFileLock(`${ledgerPath}.lock`)
  try {
    const set = await requireEpochQuestionSet(input)
    const ledger = await readSellerLedger(ledgerPath, input.model, input.sellerPeerId)
    const reference = set.reference
    const reservedAt = new Date(input.now?.() ?? Date.now()).toISOString()
    const auditId = canonicalHashBytes32({
      domain: 'antseed-verifier-audit-reservation-v1',
      runId: input.runId,
      epoch: input.epoch,
      model: normalized(input.model),
      sellerPeerId: normalized(input.sellerPeerId),
      service: normalized(input.service),
      referenceId: reference.referenceId,
      reservedAt,
    })
    ledger.assignments.push({
      auditId,
      runId: input.runId,
      epoch: input.epoch,
      service: input.service,
      referenceId: reference.referenceId,
      probeIds: reference.probes.map((probe) => probe.id),
      selection: EPOCH_QUESTION_SET_METHOD,
      reservedAt,
    })
    await mkdir(dirname(ledgerPath), { recursive: true })
    await writeJsonAtomic(ledgerPath, ledger)
    return { reference: structuredClone(reference), auditId, ledgerPath }
  } finally {
    await lock.release()
  }
}

/**
 * Reserves the epoch set's extra questions for a close-call first audit (`kbf-extension-v1` /
 * `-v2`): extra set `extensionIndex` of `epochs/<epoch>/set.json`, the same for every seller in the
 * grey zone. Its size must be the first set's (`probeCount`); a set without that extra set throws
 * `NO_EPOCH_QUESTION_SET`, and the close call stays undecided.
 */
export async function reserveExtensionReference(input: {
  banksDir: string
  model: string
  sellerPeerId: string
  service: string
  runId: string
  epoch: string
  /** The reference of the close call's first audit: only its own set's extra sets are handed out. */
  firstReferenceId: string
  probeCount: number
  /** Which extra set of the close call to reserve (1 or 2). Default 1. */
  extensionIndex?: number
  config?: VerifierCLIConfig
  now?: () => number
}): Promise<{ reference: KbfReferenceV1; auditId: string }> {
  if (!Number.isInteger(input.probeCount) || input.probeCount <= 0) {
    throw new Error(`extension probe count must be a positive integer, got ${input.probeCount}`)
  }
  const extensionIndex = input.extensionIndex ?? 1
  if (extensionIndex !== 1 && extensionIndex !== 2) {
    throw new Error(`extension index must be 1 or 2, got ${extensionIndex}`)
  }
  const ledgerPath = sellerLedgerPath(input.banksDir, input.model, input.sellerPeerId)
  const lock = await acquirePidFileLock(`${ledgerPath}.lock`)
  try {
    const current = await loadEpochQuestionSet(input)
    if (current?.reference.referenceId !== input.firstReferenceId) {
      // Its first audit was made on a set that is no longer current: a submit published it (its extra
      // questions are public), or it is another set's. Extra questions of the current set would not pool.
      const retired = await findEpochQuestionSetByReferenceId({ ...input, referenceId: input.firstReferenceId })
      throw new Error(`${NO_EPOCH_QUESTION_SET}: ${retired
        ? `the ${input.model} question set for epoch ${input.epoch} that this close call's first audit used was published, so its extra questions are public`
        : `this close call's first audit was not made on the current ${input.model} question set for epoch ${input.epoch}`}; the close call stays undecided`)
    }
    const set = await requireEpochQuestionSet(input)
    const reference = set.extensions[extensionIndex - 1]
    if (!reference || reference.probes.length !== input.probeCount) {
      throw new Error(
        `${NO_EPOCH_QUESTION_SET}: the ${input.model} question set for epoch ${input.epoch} has no extra set ${extensionIndex} `
        + `of ${input.probeCount} questions`,
      )
    }
    const ledger = await readSellerLedger(ledgerPath, input.model, input.sellerPeerId)
    const existing = ledger.assignments.find((entry) => (
      entry.purpose === 'extension' && (entry.extensionIndex ?? 1) === extensionIndex
      && entry.epoch === input.epoch && !entry.voidedAt && entry.referenceId === reference.referenceId
    ))
    if (existing) return { reference: structuredClone(reference), auditId: existing.auditId }
    const reservedAt = new Date(input.now?.() ?? Date.now()).toISOString()
    const auditId = canonicalHashBytes32({
      domain: 'antseed-verifier-extension-reservation-v1',
      runId: input.runId,
      epoch: input.epoch,
      model: normalized(input.model),
      sellerPeerId: normalized(input.sellerPeerId),
      service: normalized(input.service),
      referenceId: reference.referenceId,
      reservedAt,
    })
    ledger.assignments.push({
      auditId,
      runId: input.runId,
      epoch: input.epoch,
      service: input.service,
      referenceId: reference.referenceId,
      probeIds: reference.probes.map((probe) => probe.id),
      selection: EPOCH_QUESTION_SET_METHOD,
      purpose: 'extension',
      ...(extensionIndex === 1 ? {} : { extensionIndex }),
      reservedAt,
    })
    await mkdir(dirname(ledgerPath), { recursive: true })
    await writeJsonAtomic(ledgerPath, ledger)
    return { reference: structuredClone(reference), auditId }
  } finally {
    await lock.release()
  }
}

async function readSellerLedger(ledgerPath: string, model: string, sellerPeerId: string): Promise<SellerProbeLedgerV1> {
  const ledger = await readJsonIfExists<SellerProbeLedgerV1>(ledgerPath) ?? {
    version: 1,
    kind: 'antseed-kbf-seller-probe-ledger',
    model,
    sellerPeerId,
    assignments: [],
  }
  if (normalized(ledger.model) !== normalized(model) || normalized(ledger.sellerPeerId) !== normalized(sellerPeerId)) {
    throw new Error(`invalid seller probe ledger at ${ledgerPath}`)
  }
  return ledger
}

async function requireEpochQuestionSet(input: {
  banksDir: string
  model: string
  epoch: string
  config?: VerifierCLIConfig
}): Promise<EpochQuestionSetV1> {
  const set = await loadEpochQuestionSet(input)
  if (!set) {
    throw new Error(`${NO_EPOCH_QUESTION_SET}: no ${input.model} question set for epoch ${input.epoch} has been built`)
  }
  if (set.calibration?.status !== 'passed') {
    throw new Error(`${NO_EPOCH_QUESTION_SET}: the ${input.model} question set for epoch ${input.epoch} ${epochSetCalibrationProblem(set)}`)
  }
  return set
}

/** Why sellers can't be asked this set yet, for messages; null when they can. */
export function epochSetCalibrationProblem(set: EpochQuestionSetV1): string | null {
  if (set.calibration?.status === 'passed') return null
  return set.calibration ? `failed calibration: ${set.calibration.failureReason}` : 'has not been calibrated'
}

/**
 * The sanity gate of a calibration; null when it passed. Only coverage stops a model. A calibration rate
 * above the enrollment limit doesn't: the limit comes from these trials, so a drifted reference can't turn
 * into false DIFFs, and the KBF reference code has no such stop. `verifier run` warns about it instead.
 */
function calibrationFailure(
  calibrations: readonly KbfReferenceCalibrationV1[],
  summary: Pick<EpochSetCalibrationV1, 'minimumCoverage'>,
): string | null {
  if (calibrations.length === 0) return 'no set was calibrated'
  if (summary.minimumCoverage < CALIBRATION_MINIMUM_COVERAGE) {
    return `the reference answered ${percent(summary.minimumCoverage)} of a set's questions, under the ${percent(CALIBRATION_MINIMUM_COVERAGE)} needed`
  }
  return null
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/**
 * Stores a finished calibration in `epochs/<epoch>/set.json`, once, with its raw exchanges in the
 * bank (which every audit submission publishes). When it passes, each reference gets its trials and
 * so its limit (and a new id); when it fails the gates, the references stay as they were, the failure
 * is recorded, and sellers of the model aren't asked this set. Either way it is not asked again.
 */
export async function recordEpochSetCalibration(input: {
  banksDir: string
  model: string
  epoch: string
  /** One per set, in set order: the audit set, then the extra sets. */
  calibrations: readonly KbfReferenceCalibrationV1[]
  passes: number
  exchanges: ReferenceExchangesFileV1
  cost: ReferenceBuildCostV1
  config?: VerifierCLIConfig
  now?: () => number
}): Promise<EpochQuestionSetV1> {
  const path = epochQuestionSetPath(input.banksDir, input.model, input.epoch)
  const lock = await acquirePidFileLock(`${path}.lock`)
  try {
    const set = await loadEpochQuestionSet(input)
    if (!set) throw new Error(`no ${input.model} question set for epoch ${input.epoch} to calibrate`)
    if (set.calibration) return set
    const references = [set.reference, ...set.extensions]
    if (references.length !== input.calibrations.length) {
      throw new Error(`${references.length} sets but ${input.calibrations.length} calibrations`)
    }
    const trials = aggregateKbfSelfTestOutcomes(input.calibrations.flatMap((calibration) => calibration.outcomes))
    const enrollment = aggregateKbfSelfTestOutcomes(references.flatMap((reference) => reference.selfTest.outcomes))
    const summary = {
      version: 1 as const,
      passes: input.passes,
      hamming: trials.hamming,
      total: trials.total,
      errorRate: trials.errorRate,
      minimumCoverage: Math.min(...input.calibrations.map((calibration) => calibration.coverage)),
      enrollmentErrorLimit: clopperPearsonUpper(
        enrollment.hamming, enrollment.total, set.reference.statisticalPowerEvidence.clopperPearsonConfidence,
      ),
      requestCount: input.cost.requestCount,
      costUsdMicros: input.cost.totalUsdMicros,
      completedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    }
    const failureReason = calibrationFailure(input.calibrations, summary)
    const calibrated = failureReason ? references : references.map((reference, index) => {
      const calibration = input.calibrations[index]!
      if (calibration.outcomes.some((outcome, position) => outcome.probeId !== reference.probes[position]?.id)) {
        throw new Error(`calibration ${index} is of other questions than its set`)
      }
      const withCalibration: KbfReferenceV1 = { ...reference, calibration }
      withCalibration.referenceId = computeReferenceId(withCalibration)
      return validateKbfReferenceV1(withCalibration, { minimumStatisticalPower: Number.EPSILON })
    })
    const result: EpochQuestionSetV1 = {
      ...set,
      reference: calibrated[0]!,
      extensions: calibrated.slice(1),
      calibration: failureReason
        ? { ...summary, status: 'failed', failureReason, failedCalibrations: [...input.calibrations] }
        : { ...summary, status: 'passed' },
    }
    await addBankReferenceExchanges(input.banksDir, input.model, calibrated[0]!.referenceId, input.exchanges)
    await writeJsonAtomic(path, result)
    return result
  } finally {
    await lock.release()
  }
}

async function addBankReferenceExchanges(
  banksDir: string,
  model: string,
  referenceId: string,
  exchanges: ReferenceExchangesFileV1,
): Promise<void> {
  const path = bankPath(banksDir, model)
  const lock = await acquirePidFileLock(join(dirname(path), '.bank.lock'))
  try {
    const bank = await readJsonIfExists<ProbeBankV1>(path)
    if (!bank) throw new Error(`no probe bank exists for ${model}`)
    if (bank.referenceExchanges?.some((entry) => entry.referenceId === referenceId)) return
    const stored = await storeBankExchanges(dirname(path), referenceId, exchanges)
    bank.referenceExchanges = [...(bank.referenceExchanges ?? []), stored]
    bank.updatedAt = new Date().toISOString()
    await writeJsonAtomic(path, bank)
  } finally {
    await lock.release()
  }
}

/** Legacy per-seller extension set (`epochs/<epoch>/extensions/…`). Read-only. */
export function extensionReferencePath(
  banksDir: string,
  model: string,
  epoch: string,
  sellerPeerId: string,
  extensionIndex = 1,
): string {
  return join(
    banksDir,
    safeServiceSlug(model),
    'epochs',
    safeServiceSlug(epoch),
    'extensions',
    `${sellerPeerHash(sellerPeerId)}${extensionIndex === 1 ? '' : `.${extensionIndex}`}.json`,
  )
}

export async function loadModelAuditReservation(input: {
  banksDir: string
  model: string
  sellerPeerId: string
  auditId: string
  config?: VerifierCLIConfig
}): Promise<{
  reference: KbfReferenceV1
  assignment: SellerProbeLedgerV1['assignments'][number]
  /** The reservation's question set was published by a submit: an audit on it is never resumed. */
  retired: boolean
}> {
  const bank = await readRequiredBank(bankPath(input.banksDir, input.model), input.model)
  const ledgerPath = sellerLedgerPath(input.banksDir, input.model, input.sellerPeerId)
  const ledger = await readJsonIfExists<SellerProbeLedgerV1>(ledgerPath)
  if (!ledger
    || normalized(ledger.model) !== normalized(input.model)
    || normalized(ledger.sellerPeerId) !== normalized(input.sellerPeerId)) {
    throw new Error(`invalid seller probe ledger at ${ledgerPath}`)
  }
  const assignment = ledger.assignments.find((entry) => entry.auditId === input.auditId && !entry.voidedAt)
  if (!assignment) {
    const voided = ledger.assignments.find((entry) => entry.auditId === input.auditId)
    throw new Error(voided
      ? `audit reservation ${input.auditId} was voided (${voided.voidReason ?? 'no reason recorded'})`
      : `active audit reservation ${input.auditId} not found in ${ledgerPath}`)
  }
  const sellerEpochReference = await readJsonIfExists<SellerEpochProbeReferenceV1>(
    assignment.purpose === 'extension'
      ? extensionReferencePath(input.banksDir, input.model, assignment.epoch, input.sellerPeerId, assignment.extensionIndex ?? 1)
      : sellerEpochProbeReferencePath(input.banksDir, input.model, assignment.epoch, input.sellerPeerId),
  )
  if (sellerEpochReference) {
    const reference = validateSellerEpochProbeReference({
      value: sellerEpochReference,
      bank,
      model: input.model,
      sellerPeerId: input.sellerPeerId,
      epoch: assignment.epoch,
      config: input.config,
      requirePower: assignment.purpose !== 'extension',
    })
    if (!matchesReservedReferenceId(assignment.referenceId, sellerEpochReference.reference, reference)
      || !sameValues(reference.probes.map((probe) => probe.id), assignment.probeIds)) {
      throw new Error(`audit reservation ${input.auditId} does not match its seller epoch probe reference`)
    }
    return { reference, assignment: structuredClone(assignment), retired: false }
  }
  // This epoch's shared question set (`epoch-shared-set-v1`), current or retired by a submit.
  const set = await findEpochQuestionSetByReferenceId({
    banksDir: input.banksDir, model: input.model, epoch: assignment.epoch, referenceId: assignment.referenceId, config: input.config,
  })
  const setReference = set && [set.reference, ...set.extensions].find((reference) => reference.referenceId === assignment.referenceId)
  if (setReference) {
    if (!sameValues(setReference.probes.map((probe) => probe.id), assignment.probeIds)) {
      throw new Error(`audit reservation ${input.auditId} does not match its epoch question set`)
    }
    return { reference: structuredClone(setReference), assignment: structuredClone(assignment), retired: set.retired !== undefined }
  }
  // Legacy reservations drew one shared reference per model and epoch.
  const epochReference = await readJsonIfExists<EpochProbeReferenceV1>(
    epochProbeReferencePath(input.banksDir, input.model, assignment.epoch),
  )
  if (epochReference) {
    const reference = validateLegacyEpochProbeReference({
      value: epochReference,
      bank,
      model: input.model,
      epoch: assignment.epoch,
      config: input.config,
    })
    if (!matchesReservedReferenceId(assignment.referenceId, epochReference.reference, reference)
      || !sameValues(reference.probes.map((probe) => probe.id), assignment.probeIds)) {
      throw new Error(`audit reservation ${input.auditId} does not match its epoch probe reference`)
    }
    return { reference, assignment: structuredClone(assignment), retired: false }
  }
  const byId = new Map(bank.probes.map((entry) => [entry.probe.id, entry]))
  const selected = assignment.probeIds.map((probeId) => {
    const entry = byId.get(probeId)
    if (!entry) throw new Error(`probe ${probeId} from audit ${input.auditId} is missing from the bank`)
    return entry
  })
  const reference = selectPoweredReference(
    bank,
    selected,
    input.config,
    Date.parse(assignment.reservedAt),
  )
  if (!reference || reference.referenceId !== assignment.referenceId
    || reference.probes.length !== assignment.probeIds.length) {
    throw new Error(`audit reservation ${input.auditId} is incompatible with the current probe bank`)
  }
  return { reference, assignment: structuredClone(assignment), retired: false }
}

/**
 * A reservation names the reference ID it was drawn with. A reference stored before
 * unscoreable answers were left out gets a new ID once re-scored; it is still the same
 * reservation (same probes), so either ID matches.
 */
function matchesReservedReferenceId(reservedId: string, stored: KbfReferenceV1, rescored: KbfReferenceV1): boolean {
  return reservedId === rescored.referenceId || reservedId === stored?.referenceId
}

export async function voidModelAuditReference(input: {
  banksDir: string
  model: string
  sellerPeerId: string
  auditId: string
  reason: string
  now?: () => number
}): Promise<{ ledgerPath: string; voidedAt: string }> {
  const ledgerPath = sellerLedgerPath(input.banksDir, input.model, input.sellerPeerId)
  const lock = await acquirePidFileLock(`${ledgerPath}.lock`)
  try {
    const ledger = await readJsonIfExists<SellerProbeLedgerV1>(ledgerPath)
    if (!ledger
      || normalized(ledger.model) !== normalized(input.model)
      || normalized(ledger.sellerPeerId) !== normalized(input.sellerPeerId)) {
      throw new Error(`invalid seller probe ledger at ${ledgerPath}`)
    }
    const assignment = ledger.assignments.find((entry) => entry.auditId === input.auditId)
    if (!assignment) throw new Error(`audit reservation ${input.auditId} not found in ${ledgerPath}`)
    if (assignment.voidedAt) return { ledgerPath, voidedAt: assignment.voidedAt }
    assignment.voidedAt = new Date(input.now?.() ?? Date.now()).toISOString()
    assignment.voidReason = input.reason
    await writeJsonAtomic(ledgerPath, ledger)
    return { ledgerPath, voidedAt: assignment.voidedAt }
  } finally {
    await lock.release()
  }
}

export function bankPath(banksDir: string, model: string): string {
  return join(banksDir, safeServiceSlug(model), 'bank.json')
}

/** Legacy shared reference for every seller of a model in one epoch. Read-only. */
export function epochProbeReferencePath(banksDir: string, model: string, epoch: string): string {
  return join(banksDir, safeServiceSlug(model), 'epochs', `${safeServiceSlug(epoch)}.json`)
}

export function sellerEpochProbeReferencePath(
  banksDir: string,
  model: string,
  epoch: string,
  sellerPeerId: string,
): string {
  return join(
    banksDir,
    safeServiceSlug(model),
    'epochs',
    safeServiceSlug(epoch),
    'sellers',
    `${sellerPeerHash(sellerPeerId)}.json`,
  )
}

function validateSellerEpochProbeReference(input: {
  value: SellerEpochProbeReferenceV1
  bank: ProbeBankV1
  model: string
  sellerPeerId: string
  epoch: string
  config?: VerifierCLIConfig
  /** False for a close-call extension set, which is only judged pooled with the first set. */
  requirePower?: boolean
}): KbfReferenceV1 {
  const { value } = input
  if (value.version !== 1 || value.kind !== 'antseed-kbf-seller-epoch-probe-reference'
    || normalized(value.model) !== normalized(input.model)
    || normalized(value.sellerPeerId) !== normalized(input.sellerPeerId)
    || value.epoch !== input.epoch
    || value.selection?.method !== SELLER_PROBE_SELECTION_METHOD
    || value.compatibilityHash !== input.bank.compatibilityHash) {
    throw new Error(`invalid seller epoch probe reference for ${input.model} epoch ${input.epoch}`)
  }
  return validateBankProbeReference({
    reference: value.reference,
    bank: input.bank,
    model: input.model,
    label: `seller epoch probe reference for ${input.model} epoch ${input.epoch}`,
    config: input.config,
    requirePower: input.requirePower,
  })
}

function validateLegacyEpochProbeReference(input: {
  value: EpochProbeReferenceV1
  bank: ProbeBankV1
  model: string
  epoch: string
  config?: VerifierCLIConfig
}): KbfReferenceV1 {
  const { value, bank } = input
  if (value.version !== 1 || value.kind !== 'antseed-kbf-epoch-probe-reference'
    || normalized(value.model) !== normalized(input.model) || value.epoch !== input.epoch
    || value.compatibilityHash !== bank.compatibilityHash) {
    throw new Error(`invalid epoch probe reference for ${input.model} epoch ${input.epoch}`)
  }
  return validateBankProbeReference({
    reference: value.reference,
    bank,
    model: input.model,
    label: `epoch probe reference for ${input.model} epoch ${input.epoch}`,
    config: input.config,
  })
}

function validateBankProbeReference(input: {
  reference: KbfReferenceV1
  bank: ProbeBankV1
  model: string
  label: string
  config?: VerifierCLIConfig
  requirePower?: boolean
}): KbfReferenceV1 {
  const { bank, label } = input
  const sizing = resolveReferenceSizingPolicy(input.config)
  const requirePower = input.requirePower !== false
  // References drawn before unscoreable answers were left out are re-scored like the bank.
  const reference = validateKbfReferenceV1(rescoreKbfReference(validateKbfReferenceV1(input.reference, {
    minimumStatisticalPower: Number.EPSILON,
  })), {
    minimumStatisticalPower: requirePower ? sizing.minimumStatisticalPower : Number.EPSILON,
  })
  if (requirePower && !isReferenceProbeCountAllowed(reference.probes.length, sizing)) {
    throw new Error(`${label} is incompatible with configured sizing`)
  }
  if (probeBankCompatibilityHash(input.model, reference) !== bank.compatibilityHash) {
    throw new Error(`${label} is incompatible with the bank`)
  }
  const excludedDomains = excludedVerifierDomains(input.config, input.model)
  if (reference.probes.some((probe) => excludedDomains.has(probe.domain))) {
    throw new Error(`${label} contains an excluded domain`)
  }
  const bankById = new Map(bank.probes.map((entry) => [entry.probe.id, entry]))
  const outcomeById = new Map(reference.selfTest.outcomes.map((outcome) => [outcome.probeId, outcome]))
  for (const probe of reference.probes) {
    const bankEntry = bankById.get(probe.id)
    const outcome = outcomeById.get(probe.id)
    if (!bankEntry || !outcome
      || canonicalHashBytes32(canonicalBankProbe(bankEntry.probe)) !== canonicalHashBytes32(canonicalBankProbe(probe))
      || canonicalHashBytes32(bankEntry.selfTest) !== canonicalHashBytes32(outcome)) {
      throw new Error(`epoch probe ${probe.id} is inconsistent with the ${input.model} bank`)
    }
  }
  return structuredClone(reference)
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export async function inspectModelProbeBankPower(input: {
  banksDir: string
  model: string
  config?: VerifierCLIConfig
  now?: () => number
}): Promise<ProbeBankPowerStatus> {
  const path = bankPath(input.banksDir, input.model)
  const bank = await readBankFile(path)
  if (!bank) {
    return { totalProbeCount: 0, eligibleProbeCount: 0, selectedProbeCount: null, statisticalPower: null }
  }
  if (bank.kind !== 'antseed-kbf-probe-bank'
    || normalized(bank.model) !== normalized(input.model)
    || !Array.isArray(bank.probes)
    || !Array.isArray(bank.contrastModels)) {
    throw new Error(`invalid probe bank at ${path}`)
  }
  assertCurrentBankEnrollment(bank, input.model)
  const activeContrasts = new Set(bank.contrastModels.map(normalized))
  const excludedDomains = excludedVerifierDomains(input.config, input.model)
  const eligible = bank.probes.filter((entry) => !excludedDomains.has(entry.probe.domain)
    && entry.distinguishingContrastModels
    .some((model) => activeContrasts.has(normalized(model))))
  if (!Array.isArray(bank.referenceCosts)) {
    return {
      totalProbeCount: bank.probes.length,
      eligibleProbeCount: eligible.length,
      selectedProbeCount: null,
      statisticalPower: null,
    }
  }
  const reference = selectPoweredReference(bank, eligible, input.config, input.now?.() ?? Date.now())
  return {
    totalProbeCount: bank.probes.length,
    eligibleProbeCount: eligible.length,
    selectedProbeCount: reference?.selectedProbeCount ?? null,
    statisticalPower: reference?.statisticalPower ?? null,
  }
}

export function sellerLedgerPath(banksDir: string, model: string, sellerPeerId: string): string {
  return join(banksDir, safeServiceSlug(model), 'sellers', `${sellerPeerHash(sellerPeerId)}.json`)
}

function sellerPeerHash(sellerPeerId: string): string {
  return canonicalHashBytes32({ peerId: normalized(sellerPeerId) }).slice(2)
}

/**
 * Finds the full probe reference with `referenceId` among the per-seller (and legacy shared)
 * epoch references of every model bank. Callers must validate the returned value.
 */
export async function findEpochProbeReference(banksDir: string, referenceId: string): Promise<unknown | null> {
  const walk = async (directory: string): Promise<unknown | null> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        const found = await walk(path)
        if (found) return found
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const value = await readJsonIfExists<EpochProbeReferenceV1 | SellerEpochProbeReferenceV1 | EpochQuestionSetV1>(path)
      if (value?.kind === 'antseed-kbf-epoch-question-set') {
        for (const reference of [value.reference, ...(value.extensions ?? [])]) {
          if (reference?.referenceId === referenceId) return structuredClone(reference)
        }
        continue
      }
      if ((value?.kind === 'antseed-kbf-seller-epoch-probe-reference' || value?.kind === 'antseed-kbf-epoch-probe-reference')
        && value.reference) {
        if (value.reference.referenceId === referenceId) return structuredClone(value.reference)
        const rescored = rescoredOrNull(value.reference)
        if (rescored?.referenceId === referenceId) return rescored
      }
    }
    return null
  }
  let models: string[]
  try {
    models = await readdir(banksDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  for (const model of models.sort()) {
    const found = await walk(join(banksDir, model, 'epochs'))
    if (found) return found
  }
  return null
}

function rescoredOrNull(reference: KbfReferenceV1): KbfReferenceV1 | null {
  try {
    return rescoreKbfReference(structuredClone(reference))
  } catch {
    return null
  }
}

function bankFromReference(
  model: string,
  reference: KbfReferenceV1,
  cost: ReferenceBuildCostV1,
  answeredContrastModelsByProbeId?: ReadonlyMap<string, readonly string[]>,
): ProbeBankV1 {
  const assumptions = {
    alpha: reference.statisticalPowerEvidence.alpha,
    clopperPearsonConfidence: reference.statisticalPowerEvidence.clopperPearsonConfidence,
  }
  const compatibilityHash = probeBankCompatibilityHash(model, reference)
  const contrastByProbe = new Map<string, string[]>()
  for (const contrast of reference.contrasts) {
    for (const probeId of contrast.distinguishingProbeIds) {
      const models = contrastByProbe.get(probeId) ?? []
      models.push(contrast.model)
      contrastByProbe.set(probeId, models)
    }
  }
  const outcomes = new Map(reference.selfTest.outcomes.map((outcome) => [outcome.probeId, outcome]))
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: 'antseed-kbf-probe-bank',
    model,
    compatibilityHash,
    queryProfile: reference.queryProfile,
    referenceTemplate: {
      referenceModel: reference.referenceModel,
      serviceAliases: reference.serviceAliases,
      source: reference.source,
      generator: reference.generator,
      ...(reference.provenance ? { provenance: reference.provenance } : {}),
      minimumMismatchDelta: reference.minimumMismatchDelta,
    },
    statisticalAssumptions: assumptions,
    contrastModels: reference.contrasts.map((contrast) => contrast.model),
    probes: reference.probes.map((probe) => ({
      probe,
      selfTest: outcomes.get(probe.id)!,
      distinguishingContrastModels: (contrastByProbe.get(probe.id) ?? []).sort(),
      ...(answeredContrastModelsByProbeId ? {
        answeredContrastModels: [...new Set([
          ...(answeredContrastModelsByProbeId.get(probe.id) ?? []),
          ...(contrastByProbe.get(probe.id) ?? []),
        ])].sort(),
      } : {}),
    })),
    sourceReferenceIds: [reference.referenceId],
    referenceCosts: [{
      costId: canonicalHashBytes32({
        domain: 'antseed-reference-cost-v1',
        referenceId: reference.referenceId,
        cost,
      }),
      referenceId: reference.referenceId,
      cost,
      status: 'unclaimed',
      reservedEvidenceHash: null,
      claimedTransactionHash: null,
    }],
    createdAt: now,
    updatedAt: now,
  }
}

export function probeBankCompatibilityHash(model: string, reference: KbfReferenceV1): string {
  return canonicalHashBytes32({
    model: normalized(model),
    referenceModel: normalized(reference.referenceModel),
    serviceAliases: reference.serviceAliases.map(normalized).sort(),
    queryProfileHash: referenceCompatibilityProfileHash(reference),
    // The upstream description is not part of compatibility: banks built before it was
    // recorded keep accepting new builds, and sourceId already separates upstreams.
    provenance: withoutUpstream(reference.provenance),
    generator: {
      name: reference.generator.name,
      version: reference.generator.version,
      enrollmentBatchingVersion: reference.generator.params.enrollmentBatchingVersion ?? null,
      enrollmentStabilityVersion: reference.generator.params.enrollmentStabilityVersion ?? null,
      // Only present for filtered banks, so banks built before the filter keep their hash.
      ...(typeof reference.generator.params.layoutFilterPasses === 'number' && reference.generator.params.layoutFilterPasses > 0
        ? { layoutFilterPasses: reference.generator.params.layoutFilterPasses } : {}),
    },
    minimumMismatchDelta: reference.minimumMismatchDelta,
    assumptions: {
      alpha: reference.statisticalPowerEvidence.alpha,
      clopperPearsonConfidence: reference.statisticalPowerEvidence.clopperPearsonConfidence,
    },
  })
}

function withoutUpstream(provenance: KbfReferenceV1['provenance']): unknown {
  if (!provenance) return null
  const { upstream: _upstream, ...rest } = provenance as Record<string, unknown>
  return rest
}

/** Contrast models and probe ids of a model's bank, without rebuilding it as one reference. */
export async function loadBankProbeIndex(
  banksDir: string,
  model: string,
): Promise<{ contrastModels: string[]; probeIds: string[] } | undefined> {
  const bank = await readBankFile(bankPath(banksDir, model))
  if (!bank) return undefined
  if (bank.kind !== 'antseed-kbf-probe-bank' || normalized(bank.model) !== normalized(model)) {
    throw new Error(`invalid probe bank for ${model}`)
  }
  assertCurrentBankEnrollment(bank, model)
  return { contrastModels: [...bank.contrastModels], probeIds: bank.probes.map((entry) => entry.probe.id) }
}

export async function loadBankEnrollmentReference(banksDir: string, model: string): Promise<KbfReferenceV1 | undefined> {
  const bank = await readBankFile(bankPath(banksDir, model))
  if (!bank) return undefined
  if (bank.kind !== 'antseed-kbf-probe-bank' || normalized(bank.model) !== normalized(model)) {
    throw new Error(`invalid probe bank for ${model}`)
  }
  assertCurrentBankEnrollment(bank, model)
  // Only the request settings are used, but a reference must hold a whole number of batches and at
  // most KBF_MAX_PROBE_COUNT probes, which a bank of any size need not.
  const seedCount = Math.min(
    KBF_MAX_PROBE_COUNT,
    bank.probes.length - (bank.probes.length % KBF_PROBES_PER_REQUEST),
  )
  const reference = referenceFromBankEntries(bank, bank.probes.slice(0, seedCount), Date.parse(bank.updatedAt))
  validateKbfReferenceV1(reference, { minimumStatisticalPower: Number.EPSILON })
  if (probeBankCompatibilityHash(model, reference) !== bank.compatibilityHash) {
    throw new Error(`probe bank for ${model} has inconsistent enrollment metadata`)
  }
  return reference
}

function referenceFromBankEntries(bank: ProbeBankV1, selected: BankProbeV1[], now: number): KbfReferenceV1 {
  const selfTest = aggregateKbfSelfTestOutcomes(selected.map((entry) => entry.selfTest))
  const power = computeBinomialPower({
    selfHamming: selfTest.hamming,
    selfTotal: selfTest.total,
    probeCount: selected.length,
    minimumMismatchDelta: bank.referenceTemplate.minimumMismatchDelta,
    alpha: bank.statisticalAssumptions.alpha,
    cpConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
  })
  const reference: KbfReferenceV1 = {
    version: KBF_REFERENCE_VERSION,
    kind: 'kbf',
    referenceId: '',
    ...bank.referenceTemplate,
    createdAt: new Date(now).toISOString(),
    queryProfile: bank.queryProfile,
    selfTest,
    probes: selected.map((entry) => entry.probe),
    selectedProbeCount: selected.length,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: bank.statisticalAssumptions.alpha,
      clopperPearsonConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      probeCount: selected.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: bank.contrastModels.map((model) => ({
      model,
      distinguishingProbeIds: selected.filter((entry) => entry.distinguishingContrastModels.includes(model))
        .map((entry) => entry.probe.id),
    })),
  }
  reference.referenceId = computeReferenceId(reference)
  return reference
}

function selectPoweredReference(
  bank: ProbeBankV1,
  available: readonly BankProbeV1[],
  config: VerifierCLIConfig | undefined,
  now: number,
  options: { onlyDetectableContrasts?: boolean; sizeForCalibration?: boolean } = {},
): KbfReferenceV1 | null {
  const sizing = resolveReferenceSizingPolicy(config)
  const excludedDomains = excludedVerifierDomains(config, bank.model)
  const eligible = available.filter((entry) => !excludedDomains.has(entry.probe.domain))
  let testableContrasts = new Set(bank.probes.flatMap((entry) => entry.distinguishingContrastModels))
  if (options.onlyDetectableContrasts) {
    const detectable = detectableContrasts(bank, eligible)
    testableContrasts = new Set([...testableContrasts].filter((model) => detectable.has(model)))
  }
  for (let count = sizing.minimumProbeCount;
    count <= sizing.maximumProbeCount && count <= eligible.length;
    count += sizing.probeStep) {
    const selected = eligible.slice(0, count)
    const selfTest = aggregateKbfSelfTestOutcomes(selected.map((entry) => entry.selfTest))
    const power = computeBinomialPower({
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      probeCount: count,
      minimumMismatchDelta: bank.referenceTemplate.minimumMismatchDelta,
      alpha: bank.statisticalAssumptions.alpha,
      cpConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
    })
    if (selfTest.coverage < 0.8 || selfTest.errorRate > REFERENCE_MAXIMUM_SELF_TEST_ERROR_RATE
      || power.power < sizing.minimumStatisticalPower) continue
    // An epoch set's limit comes from its calibration, fewer trials than the enrollment self-test and so
    // a wider limit: it has to reach the power on those trials too.
    if (options.sizeForCalibration) {
      const calibrationTrials = count * KBF_CALIBRATION_PASSES
      const calibrated = computeBinomialPower({
        selfHamming: Math.round(selfTest.errorRate * calibrationTrials),
        selfTotal: calibrationTrials,
        probeCount: count,
        minimumMismatchDelta: bank.referenceTemplate.minimumMismatchDelta,
        alpha: bank.statisticalAssumptions.alpha,
        cpConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
      })
      if (calibrated.power < sizing.minimumStatisticalPower) continue
    }
    const selectedIds = new Set(selected.map((entry) => entry.probe.id))
    const contrasts = bank.contrastModels.map((model) => ({
      model,
      distinguishingProbeIds: selected
        .filter((entry) => entry.distinguishingContrastModels.includes(model) && selectedIds.has(entry.probe.id))
        .map((entry) => entry.probe.id),
    }))
    const contrastDetection = computeContrastDetection({
      probeIds: selected.map((entry) => entry.probe.id),
      contrasts,
      answeredProbeIds: answeredContrastProbeIds(bank.contrastModels, selected),
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      alpha: bank.statisticalAssumptions.alpha,
      cpConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
    })
    // Grow the subset until every testable contrast model would be flagged
    // DIFF. A contrast that distinguishes no bank probe at all never answered
    // during enrollment (for example, it was unavailable) and cannot be tested.
    if (contrastDetection.some((entry) => testableContrasts.has(entry.model) && !entry.detected)) continue
    const reference = { ...referenceFromBankEntries(bank, selected, now), contrasts, contrastDetection }
    reference.referenceId = computeReferenceId(reference)
    return validateKbfReferenceV1(reference, { minimumStatisticalPower: sizing.minimumStatisticalPower })
  }
  return null
}

/** Contrast models detected when every eligible probe is used, the most any subset can detect. */
function detectableContrasts(bank: ProbeBankV1, eligible: readonly BankProbeV1[]): Set<string> {
  const selfTest = aggregateKbfSelfTestOutcomes(eligible.map((entry) => entry.selfTest))
  if (eligible.length === 0 || selfTest.total === 0) return new Set()
  const ids = new Set(eligible.map((entry) => entry.probe.id))
  const detection = computeContrastDetection({
    probeIds: [...ids],
    contrasts: bank.contrastModels.map((model) => ({
      model,
      distinguishingProbeIds: eligible
        .filter((entry) => entry.distinguishingContrastModels.includes(model))
        .map((entry) => entry.probe.id),
    })),
    answeredProbeIds: answeredContrastProbeIds(bank.contrastModels, eligible),
    selfHamming: selfTest.hamming,
    selfTotal: selfTest.total,
    alpha: bank.statisticalAssumptions.alpha,
    cpConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
  })
  return new Set(detection.filter((entry) => entry.detected).map((entry) => entry.model))
}

function answeredContrastProbeIds(
  contrastModels: readonly string[],
  selected: readonly BankProbeV1[],
): Map<string, Set<string>> | undefined {
  if (!selected.every((entry) => Array.isArray(entry.answeredContrastModels))) return undefined
  const answered = new Map(contrastModels.map((model) => [model, new Set<string>()]))
  for (const entry of selected) {
    for (const model of entry.answeredContrastModels!) answered.get(model)?.add(entry.probe.id)
  }
  return answered
}

function cryptoShuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1)
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!]
  }
  return shuffled
}

/**
 * Reads a bank and re-scores its self-test runs with the current rule (unscoreable answers
 * are null, not 0), so banks enrolled before that rule need no rebuild. Deterministic, so
 * every reader derives the same references from the same file.
 */
async function readBankFile(path: string): Promise<ProbeBankV1 | null> {
  const bank = await readJsonIfExists<ProbeBankV1>(path)
  if (!bank || !Array.isArray(bank.probes)) return bank
  for (const entry of bank.probes) {
    if (entry?.probe && entry.selfTest) entry.selfTest = rescoreKbfSelfTestOutcome(entry.selfTest, entry.probe)
  }
  return bank
}

async function readRequiredBank(path: string, model: string): Promise<ProbeBankV1> {
  const bank = await readBankFile(path)
  if (!bank) throw new Error(`no probe bank exists for ${model}; run antseed verifier reference build ${model}`)
  if (!Array.isArray(bank.referenceCosts)) {
    throw new Error(`probe bank for ${model} has no reference cost metadata; rebuild it`)
  }
  assertCurrentBankEnrollment(bank, model)
  return bank
}

function assertCurrentBankEnrollment(bank: ProbeBankV1, model: string): void {
  if (bank.referenceTemplate.generator.name === 'antseed-simple-reference-builder'
    && bank.referenceTemplate.generator.version !== REFERENCE_BUILDER_VERSION) {
    throw new Error(
      `probe bank for ${model} uses reference enrollment ${bank.referenceTemplate.generator.version}; `
      + `archive it and rebuild with enrollment ${REFERENCE_BUILDER_VERSION}`,
    )
  }
}

/** This auditor's question set for a model and epoch. */
export function epochQuestionSetPath(banksDir: string, model: string, epoch: string): string {
  return join(banksDir, safeServiceSlug(model), 'epochs', safeServiceSlug(epoch), 'set.json')
}

function epochQuestionPoolPath(banksDir: string, model: string, epoch: string): string {
  return join(banksDir, safeServiceSlug(model), 'epochs', safeServiceSlug(epoch), 'pool.json')
}

const RETIRED_SET_FILE = /^set\.published-(\d+)\.json$/

/** The question sets of a model and epoch that a submit published, oldest first. */
async function retiredEpochQuestionSetPaths(banksDir: string, model: string, epoch: string): Promise<string[]> {
  const directory = dirname(epochQuestionSetPath(banksDir, model, epoch))
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.flatMap((name) => {
    const match = RETIRED_SET_FILE.exec(name)
    return match ? [{ name, index: Number(match[1]) }] : []
  }).sort((left, right) => left.index - right.index).map((entry) => join(directory, entry.name))
}

/**
 * Whether `referenceId` is the audit set or an extra set of one of the model's retired question sets for
 * the epoch, read from the retired files alone. A retired set that no longer validates against the bank
 * (after a bank rebuild, say) still counts: its questions are public either way.
 */
export async function isRetiredEpochQuestionSetReference(input: {
  banksDir: string
  model: string
  epoch: string
  referenceId: string
}): Promise<boolean> {
  for (const path of await retiredEpochQuestionSetPaths(input.banksDir, input.model, input.epoch)) {
    let value: Partial<EpochQuestionSetV1> | null
    try {
      value = await readJsonIfExists<Partial<EpochQuestionSetV1>>(path)
    } catch {
      continue
    }
    const references = [value?.reference, ...(Array.isArray(value?.extensions) ? value.extensions : [])]
    if (references.some((reference) => reference?.referenceId === input.referenceId)) return true
  }
  return false
}

/** Why a retry's reservation on a published question set was voided (`voidModelAuditReference`). */
export const RETIRED_SET_VOID_REASON = 'its question set was published by a submit; the seller is audited again on a new set'

/** How many of the model's question sets for the epoch a submit has published. */
export async function retiredEpochQuestionSetCount(input: { banksDir: string; model: string; epoch: string }): Promise<number> {
  return (await retiredEpochQuestionSetPaths(input.banksDir, input.model, input.epoch)).length
}

/**
 * The model's question set for the epoch that holds `referenceId` as its audit set or an extra set:
 * the current one or one a submit retired, validated against the bank. Null when none holds it.
 */
export async function findEpochQuestionSetByReferenceId(input: {
  banksDir: string
  model: string
  epoch: string
  referenceId: string
  config?: VerifierCLIConfig
}): Promise<EpochQuestionSetV1 | null> {
  const paths = [
    epochQuestionSetPath(input.banksDir, input.model, input.epoch),
    ...await retiredEpochQuestionSetPaths(input.banksDir, input.model, input.epoch),
  ]
  for (const path of paths) {
    const value = await readJsonIfExists<EpochQuestionSetV1>(path)
    if (!value || ![value.reference, ...(value.extensions ?? [])].some((entry) => entry?.referenceId === input.referenceId)) continue
    const bank = await readRequiredBank(bankPath(input.banksDir, input.model), input.model)
    return validateEpochQuestionSet(value, bank, input)
  }
  return null
}

/**
 * Retires the model's question set and question pool for the epoch, right before a submit uploads
 * evidence of the model (`published`: the references and the bank exchange files the upload carries).
 * A bank exchange file holds a build's or calibration's questions and the genuine model's answers, so
 * once uploaded, every question banked for the epoch up to then (in the set, or still only in the pool)
 * is public. `set.json` moves to `set.published-<n>.json` and `pool.json` to `pool.published-<n>.json`,
 * each marked `retired` with the bank's exchange files at that moment, and the set's calibration
 * checkpoints move with it. No seller is asked them again: the next audit of the model this epoch
 * builds a new set from new questions, and a later selection counts the retired questions as asked before.
 *
 * Nothing is retired when the upload holds nothing banked since the last retire of the model and
 * epoch: none of the current set's references, and only exchange files that retire had seen. The set
 * and pool now in use were all banked after that retire, so the upload does not contain them (a
 * failed upload sent again later, for example). Without an earlier retire, or with one whose record
 * can't be read, the current set and pool are retired. Nothing to retire, nothing done.
 */
export async function retireEpochQuestionSet(input: {
  banksDir: string
  model: string
  epoch: string
  runId: string
  published: {
    referenceIds: readonly string[]
    exchanges: ReadonlyArray<{ referenceId: string; sha256: string }>
  }
  now?: () => number
}): Promise<{ retired: boolean }> {
  const setPath = epochQuestionSetPath(input.banksDir, input.model, input.epoch)
  const poolPath = epochQuestionPoolPath(input.banksDir, input.model, input.epoch)
  // A calibration, selection or pool update in progress holds one of these; then nothing is published.
  const locks: Array<Awaited<ReturnType<typeof acquirePidFileLock>>> = []
  try {
    for (const path of [`${setPath}.calibration.lock`, `${setPath}.lock`, `${poolPath}.lock`]) locks.push(await acquirePidFileLock(path))
    const set = await readJsonIfExists<EpochQuestionSetV1>(setPath)
    const pool = await readJsonIfExists<EpochQuestionPoolV1>(poolPath)
    if (!set && !pool) return { retired: false }
    const directory = dirname(setPath)
    const names = await readdir(directory)
    const setIds = new Set(set ? [set.reference, ...(set.extensions ?? [])].map((reference) => reference?.referenceId) : [])
    const seen = await exchangesSeenByEarlierRetires(directory, names)
    if (seen && !input.published.referenceIds.some((id) => setIds.has(id))
      && input.published.exchanges.every((entry) => seen.has(bankExchangeKey(entry)))) {
      return { retired: false }
    }
    const taken = new Set(names)
    let index = 1
    while (taken.has(`set.published-${index}.json`) || taken.has(`pool.published-${index}.json`)) index += 1
    const retired: EpochQuestionSetRetirementV1 = {
      at: new Date(input.now?.() ?? Date.now()).toISOString(),
      runId: input.runId,
      bankExchanges: (await loadBankReferenceExchanges(input.banksDir, input.model)).map(bankExchangeKey),
    }
    // The pool first: a set left behind by a crash is retired by the next submit, before it publishes.
    if (pool) {
      await writeJsonAtomic(join(directory, `pool.published-${index}.json`), { ...pool, retired })
      await unlink(poolPath)
    }
    if (set) {
      const retiredPath = join(directory, `set.published-${index}.json`)
      await writeJsonAtomic(retiredPath, { ...set, retired })
      await unlink(setPath)
      for (const suffix of ['.calibration.json', '.calibration.exchanges.json']) {
        await rename(`${setPath}${suffix}`, `${retiredPath}${suffix}`).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    }
    return { retired: true }
  } finally {
    for (const lock of locks.reverse()) await lock.release()
  }
}

function bankExchangeKey(entry: { referenceId: string; sha256: string }): string {
  return `${entry.referenceId} ${entry.sha256}`
}

const RETIRED_FILE = /^(?:set|pool)\.published-\d+\.json$/

/**
 * The bank exchange files earlier retires of this model and epoch had seen, or null when there was
 * none, or when one of their records is missing or unreadable (then the caller retires, to be safe).
 */
async function exchangesSeenByEarlierRetires(directory: string, names: readonly string[]): Promise<Set<string> | null> {
  const files = names.filter((name) => RETIRED_FILE.test(name))
  if (files.length === 0) return null
  const seen = new Set<string>()
  for (const name of files) {
    let record: unknown
    try {
      record = (await readJsonIfExists<{ retired?: EpochQuestionSetRetirementV1 }>(join(directory, name)))?.retired?.bankExchanges
    } catch {
      return null
    }
    if (!Array.isArray(record) || !record.every((entry) => typeof entry === 'string')) return null
    for (const entry of record) seen.add(entry)
  }
  return seen
}

/**
 * What makes two questions the same question: domain, name and template, normalized. A rebuild
 * that writes an old question again gets a new id, so ids alone can't tell it was asked before.
 */
export function questionTextKey(probe: Pick<KbfProbe, 'domain' | 'name' | 'template'>): string {
  const text = (value: unknown) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  return canonicalHashBytes32({ domain: text(probe.domain), name: text(probe.name), template: text(probe.template) })
}

/** Records probes a build for this epoch's set added to the bank (they are the set's only candidates). */
export async function recordEpochQuestionPool(input: {
  banksDir: string
  model: string
  epoch: string
  probeIds: readonly string[]
}): Promise<string[]> {
  const path = epochQuestionPoolPath(input.banksDir, input.model, input.epoch)
  const lock = await acquirePidFileLock(`${path}.lock`)
  try {
    const pool = await readJsonIfExists<EpochQuestionPoolV1>(path) ?? {
      version: 1, kind: 'antseed-kbf-epoch-question-pool', model: input.model, epoch: input.epoch, probeIds: [],
    }
    const known = new Set(pool.probeIds)
    for (const id of input.probeIds) if (!known.has(id)) { pool.probeIds.push(id); known.add(id) }
    await mkdir(dirname(path), { recursive: true })
    await writeJsonAtomic(path, pool)
    return [...pool.probeIds]
  } finally {
    await lock.release()
  }
}

export type EpochQuestionSetSelection =
  | { status: 'ready'; set: EpochQuestionSetV1 }
  | { status: 'short'; reason: string; candidateProbeCount: number }

/**
 * Makes this epoch's question set from the questions built for it (`recordEpochQuestionPool`), once:
 * an existing set is returned as it is. A question whose text matches any other question of the bank
 * (every earlier epoch's, and every question of the banks from before shared sets) is left out. The
 * candidates are shuffled once; the audit set is the smallest powered prefix (as for any reference:
 * statistical power, and every testable contrast detected), and each of the `extensionCount` extra
 * sets takes the next questions, as many as the audit set. `short` when the candidates don't reach
 * that; nothing is written then.
 */
export async function selectEpochQuestionSet(input: {
  banksDir: string
  model: string
  epoch: string
  runId: string
  extensionCount: number
  config?: VerifierCLIConfig
  now?: () => number
  shuffle?: <T>(values: readonly T[]) => T[]
}): Promise<EpochQuestionSetSelection> {
  const path = epochQuestionSetPath(input.banksDir, input.model, input.epoch)
  const lock = await acquirePidFileLock(`${path}.lock`)
  try {
    const existing = await loadEpochQuestionSet(input)
    if (existing) return { status: 'ready', set: existing }
    const bank = await readRequiredBank(bankPath(input.banksDir, input.model), input.model)
    const pool = await readJsonIfExists<EpochQuestionPoolV1>(epochQuestionPoolPath(input.banksDir, input.model, input.epoch))
    const poolIds = new Set(pool?.probeIds ?? [])
    const askedBefore = new Set(bank.probes.filter((entry) => !poolIds.has(entry.probe.id)).map((entry) => questionTextKey(entry.probe)))
    const activeContrasts = new Set(bank.contrastModels.map(normalized))
    const excludedDomains = excludedVerifierDomains(input.config, input.model)
    const seen = new Set<string>()
    let previouslyAskedProbeCount = 0
    const candidates = bank.probes.filter((entry) => {
      if (!poolIds.has(entry.probe.id) || excludedDomains.has(entry.probe.domain)
        || !entry.distinguishingContrastModels.some((model) => activeContrasts.has(normalized(model)))) return false
      const key = questionTextKey(entry.probe)
      if (askedBefore.has(key)) {
        previouslyAskedProbeCount += 1
        return false
      }
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const now = input.now?.() ?? Date.now()
    const shuffled = (input.shuffle ?? cryptoShuffle)(candidates)
    // Contrasts are testable when one of these candidates tells them apart, not one of the old questions.
    const reference = selectPoweredReference({ ...bank, probes: candidates }, shuffled, input.config, now, { sizeForCalibration: true })
    if (!reference) {
      return { status: 'short', reason: `${candidates.length} new questions are not enough for a powered audit set`, candidateProbeCount: candidates.length }
    }
    const inSet = new Set(reference.probes.map((probe) => probe.id))
    const rest = shuffled.filter((entry) => !inSet.has(entry.probe.id))
    const size = reference.probes.length
    if (rest.length < size * input.extensionCount) {
      return {
        status: 'short',
        reason: `${candidates.length} new questions: ${size} for the audit set leave ${rest.length} for ${input.extensionCount} extra set(s) of ${size}`,
        candidateProbeCount: candidates.length,
      }
    }
    const extensions = Array.from({ length: input.extensionCount }, (_, index) => validateKbfReferenceV1(
      referenceFromBankEntries(bank, rest.slice(index * size, (index + 1) * size), now),
      { minimumStatisticalPower: Number.EPSILON },
    ))
    const set: EpochQuestionSetV1 = {
      version: 1,
      kind: 'antseed-kbf-epoch-question-set',
      method: EPOCH_QUESTION_SET_METHOD,
      model: input.model,
      epoch: input.epoch,
      compatibilityHash: bank.compatibilityHash,
      candidateProbeCount: candidates.length,
      previouslyAskedProbeCount,
      reference,
      extensions,
      createdAt: new Date(now).toISOString(),
      createdByRunId: input.runId,
    }
    await mkdir(dirname(path), { recursive: true })
    await writeJsonAtomic(path, set)
    return { status: 'ready', set: validateEpochQuestionSet(set, bank, input) }
  } finally {
    await lock.release()
  }
}

/** This epoch's question set, validated against the bank, or null when none has been made. */
export async function loadEpochQuestionSet(input: {
  banksDir: string
  model: string
  epoch: string
  config?: VerifierCLIConfig
}): Promise<EpochQuestionSetV1 | null> {
  const value = await readJsonIfExists<EpochQuestionSetV1>(epochQuestionSetPath(input.banksDir, input.model, input.epoch))
  if (!value) return null
  const bank = await readRequiredBank(bankPath(input.banksDir, input.model), input.model)
  return validateEpochQuestionSet(value, bank, input)
}

function validateEpochQuestionSet(
  value: EpochQuestionSetV1,
  bank: ProbeBankV1,
  input: { model: string; epoch: string; config?: VerifierCLIConfig },
): EpochQuestionSetV1 {
  if (value.version !== 1 || value.kind !== 'antseed-kbf-epoch-question-set' || value.method !== EPOCH_QUESTION_SET_METHOD
    || normalized(value.model) !== normalized(input.model) || value.epoch !== input.epoch
    || value.compatibilityHash !== bank.compatibilityHash || !Array.isArray(value.extensions)) {
    throw new Error(`invalid ${input.model} question set for epoch ${input.epoch}`)
  }
  const label = `${input.model} question set for epoch ${input.epoch}`
  const reference = validateBankProbeReference({ reference: value.reference, bank, model: input.model, label, config: input.config })
  const extensions = value.extensions.map((extension, index) => validateBankProbeReference({
    reference: extension, bank, model: input.model, label: `${label}, extra set ${index + 1}`, config: input.config, requirePower: false,
  }))
  const ids = [reference, ...extensions].flatMap((entry) => entry.probes.map((probe) => probe.id))
  if (new Set(ids).size !== ids.length || extensions.some((extension) => extension.probes.length !== reference.probes.length)) {
    throw new Error(`${label} repeats a question or has an extra set of another size`)
  }
  if (value.calibration?.status === 'passed'
    && [reference, ...extensions].some((entry) => entry.calibration?.passes !== value.calibration!.passes)) {
    throw new Error(`${label} is marked calibrated, but a set has no calibration of ${value.calibration.passes} pass(es)`)
  }
  return { ...structuredClone(value), reference, extensions }
}
