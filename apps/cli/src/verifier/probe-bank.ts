import { randomInt } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  KBF_REFERENCE_VERSION,
  aggregateKbfSelfTestOutcomes,
  canonicalHashBytes32,
  computeBinomialPower,
  computeContrastDetection,
  computeReferenceId,
  referenceCompatibilityProfileHash,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceV1,
  type ReferenceProbeSelfTestV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import { acquirePidFileLock, readJsonIfExists, writeJsonAtomic } from './atomic-files.js'
import type { ReferenceBuildCostV1 } from './model-reference.js'
import { excludedVerifierDomains } from './model-config.js'
import { isReferenceProbeCountAllowed, resolveReferenceSizingPolicy } from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'
import { normalized } from './utils.js'

export const BANK_EXHAUSTED = 'BANK_EXHAUSTED'
const CURRENT_ANTSEED_REFERENCE_BUILDER_VERSION = '6'

interface BankProbeV1 {
  probe: KbfProbe
  selfTest: ReferenceProbeSelfTestV1
  distinguishingContrastModels: string[]
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
  createdAt: string
  updatedAt: string
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
 * Each seller gets its own probe subset and order, drawn from a CSPRNG shuffle
 * of the bank probes this seller has not been assigned in an earlier epoch.
 * Colluding sellers audited on the same day therefore cannot share answers by
 * probe position or rely on receiving the same questions.
 */
export const SELLER_PROBE_SELECTION_METHOD = 'per-seller-csprng-shuffle-v1'
export type SellerProbeSelectionMethod = typeof SELLER_PROBE_SELECTION_METHOD

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
}): Promise<{
  path: string
  addedProbeCount: number
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
    const existing = await readJsonIfExists<ProbeBankV1>(path)
    const incoming = bankFromReference(input.model, validatedReference, input.cost)
    if (!existing) {
      await writeJsonAtomic(path, incoming)
      return {
        path,
        addedProbeCount: incoming.probes.length,
        canonicalConflictProbeCount: 0,
        totalProbeCount: incoming.probes.length,
      }
    }
    const bank = existing
    if (!Array.isArray(bank.referenceCosts)) bank.referenceCosts = []
    if (existing && existing.compatibilityHash !== incoming.compatibilityHash) {
      throw new Error(`probe bank for ${input.model} is incompatible with the new reference`)
    }
    const byId = new Map(bank.probes.map((entry) => [entry.probe.id, entry]))
    let addedProbeCount = 0
    let canonicalConflictProbeCount = 0
    for (const entry of incoming.probes) {
      const previous = byId.get(entry.probe.id)
      if (!previous) {
        bank.probes.push(entry)
        byId.set(entry.probe.id, entry)
        addedProbeCount += 1
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
    }
    bank.contrastModels = [...incoming.contrastModels].sort()
    if (!bank.sourceReferenceIds.includes(validatedReference.referenceId)) {
      bank.sourceReferenceIds.push(validatedReference.referenceId)
    }
    if (!bank.referenceCosts.some((entry) => entry.referenceId === validatedReference.referenceId)) {
      bank.referenceCosts.push(...incoming.referenceCosts)
    }
    bank.updatedAt = new Date().toISOString()
    await writeJsonAtomic(path, bank)
    return { path, addedProbeCount, canonicalConflictProbeCount, totalProbeCount: bank.probes.length }
  } finally {
    await lock.release()
  }
}

function canonicalBankProbe(probe: KbfProbe): Record<string, unknown> {
  return Object.fromEntries(Object.entries(probe).filter(([key]) => ![
    'contrast',
    'generationRound',
    'generationTheme',
  ].includes(key)))
}

export async function reserveModelAuditReference(input: {
  banksDir: string
  model: string
  sellerPeerId: string
  service: string
  runId: string
  epoch: string
  allowProbeReuse?: boolean
  config?: VerifierCLIConfig
  now?: () => number
  shuffle?: <T>(values: readonly T[]) => T[]
}): Promise<{ reference: KbfReferenceV1; auditId: string; ledgerPath: string }> {
  const path = bankPath(input.banksDir, input.model)
  const ledgerPath = sellerLedgerPath(input.banksDir, input.model, input.sellerPeerId)
  const lock = await acquirePidFileLock(`${ledgerPath}.lock`)
  try {
    const bank = await readRequiredBank(path, input.model)
    const ledger = await readJsonIfExists<SellerProbeLedgerV1>(ledgerPath) ?? {
      version: 1,
      kind: 'antseed-kbf-seller-probe-ledger',
      model: input.model,
      sellerPeerId: input.sellerPeerId,
      assignments: [],
    }
    if (normalized(ledger.model) !== normalized(input.model)
      || normalized(ledger.sellerPeerId) !== normalized(input.sellerPeerId)) {
      throw new Error(`invalid seller probe ledger at ${ledgerPath}`)
    }
    const now = input.now?.() ?? Date.now()
    const reference = await loadOrCreateSellerEpochProbeReference({
      banksDir: input.banksDir,
      model: input.model,
      sellerPeerId: input.sellerPeerId,
      epoch: input.epoch,
      runId: input.runId,
      allowProbeReuse: input.allowProbeReuse === true,
      config: input.config,
      now,
      shuffle: input.shuffle,
      bank,
      ledger,
    })
    const reservedAt = new Date(now).toISOString()
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
    const probeIds = reference.probes.map((probe) => probe.id)
    ledger.assignments.push({
      auditId,
      runId: input.runId,
      epoch: input.epoch,
      service: input.service,
      referenceId: reference.referenceId,
      probeIds,
      selection: SELLER_PROBE_SELECTION_METHOD,
      reservedAt,
    })
    await mkdir(dirname(ledgerPath), { recursive: true })
    await writeJsonAtomic(ledgerPath, ledger)
    return { reference, auditId, ledgerPath }
  } finally {
    await lock.release()
  }
}

export async function loadModelAuditReservation(input: {
  banksDir: string
  model: string
  sellerPeerId: string
  auditId: string
  config?: VerifierCLIConfig
}): Promise<{ reference: KbfReferenceV1; assignment: SellerProbeLedgerV1['assignments'][number] }> {
  const bank = await readRequiredBank(bankPath(input.banksDir, input.model), input.model)
  const ledgerPath = sellerLedgerPath(input.banksDir, input.model, input.sellerPeerId)
  const ledger = await readJsonIfExists<SellerProbeLedgerV1>(ledgerPath)
  if (!ledger
    || normalized(ledger.model) !== normalized(input.model)
    || normalized(ledger.sellerPeerId) !== normalized(input.sellerPeerId)) {
    throw new Error(`invalid seller probe ledger at ${ledgerPath}`)
  }
  const assignment = ledger.assignments.find((entry) => entry.auditId === input.auditId && !entry.voidedAt)
  if (!assignment) throw new Error(`active audit reservation ${input.auditId} not found in ${ledgerPath}`)
  const sellerEpochReference = await readJsonIfExists<SellerEpochProbeReferenceV1>(
    sellerEpochProbeReferencePath(input.banksDir, input.model, assignment.epoch, input.sellerPeerId),
  )
  if (sellerEpochReference) {
    const reference = validateSellerEpochProbeReference({
      value: sellerEpochReference,
      bank,
      model: input.model,
      sellerPeerId: input.sellerPeerId,
      epoch: assignment.epoch,
      config: input.config,
    })
    if (reference.referenceId !== assignment.referenceId
      || !sameValues(reference.probes.map((probe) => probe.id), assignment.probeIds)) {
      throw new Error(`audit reservation ${input.auditId} does not match its seller epoch probe reference`)
    }
    return { reference, assignment: structuredClone(assignment) }
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
    if (reference.referenceId !== assignment.referenceId
      || !sameValues(reference.probes.map((probe) => probe.id), assignment.probeIds)) {
      throw new Error(`audit reservation ${input.auditId} does not match its epoch probe reference`)
    }
    return { reference, assignment: structuredClone(assignment) }
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
  return { reference, assignment: structuredClone(assignment) }
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

async function loadOrCreateSellerEpochProbeReference(input: {
  banksDir: string
  model: string
  sellerPeerId: string
  epoch: string
  runId: string
  allowProbeReuse: boolean
  config?: VerifierCLIConfig
  now: number
  shuffle?: <T>(values: readonly T[]) => T[]
  bank: ProbeBankV1
  ledger: SellerProbeLedgerV1
}): Promise<KbfReferenceV1> {
  // The caller holds the seller ledger lock, which serializes this per seller.
  const path = sellerEpochProbeReferencePath(input.banksDir, input.model, input.epoch, input.sellerPeerId)
  const existing = await readJsonIfExists<SellerEpochProbeReferenceV1>(path)
  if (existing) {
    return validateSellerEpochProbeReference({
      value: existing,
      bank: input.bank,
      model: input.model,
      sellerPeerId: input.sellerPeerId,
      epoch: input.epoch,
      config: input.config,
    })
  }
  const used = input.allowProbeReuse
    ? new Set<string>()
    : sellerProbeIdsFromOtherEpochs(input.ledger, input.epoch)
  const activeContrasts = new Set(input.bank.contrastModels.map(normalized))
  const excludedDomains = excludedVerifierDomains(input.config, input.model)
  const candidates = input.bank.probes.filter((entry) => !excludedDomains.has(entry.probe.domain)
    && entry.distinguishingContrastModels.some((model) => activeContrasts.has(normalized(model))))
  const available = candidates.filter((entry) => !used.has(entry.probe.id))
  const shuffled = (input.shuffle ?? cryptoShuffle)(available)
  const reference = selectPoweredReference(input.bank, shuffled, input.config, input.now)
  if (!reference) {
    throw new Error(
      `${BANK_EXHAUSTED}: ${available.length} probes not yet assigned to seller ${input.sellerPeerId} `
      + `remain for ${input.model} epoch ${input.epoch}`,
    )
  }
  const value: SellerEpochProbeReferenceV1 = {
    version: 1,
    kind: 'antseed-kbf-seller-epoch-probe-reference',
    model: input.model,
    epoch: input.epoch,
    sellerPeerId: input.sellerPeerId,
    compatibilityHash: input.bank.compatibilityHash,
    selection: {
      method: SELLER_PROBE_SELECTION_METHOD,
      eligibleProbeCount: available.length,
      excludedPreviouslyAssignedProbeCount: candidates.length - available.length,
      allowProbeReuse: input.allowProbeReuse,
    },
    reference,
    createdAt: new Date(input.now).toISOString(),
    createdByRunId: input.runId,
  }
  await mkdir(dirname(path), { recursive: true })
  await writeJsonAtomic(path, value)
  return structuredClone(reference)
}

/**
 * Probes this seller was assigned in any other epoch, voided or not: a voided
 * audit may still have sent its probes to the seller before it was voided.
 */
function sellerProbeIdsFromOtherEpochs(ledger: SellerProbeLedgerV1, epoch: string): Set<string> {
  const used = new Set<string>()
  for (const assignment of ledger.assignments) {
    if (assignment.epoch === epoch) continue
    for (const probeId of assignment.probeIds) used.add(probeId)
  }
  return used
}

function validateSellerEpochProbeReference(input: {
  value: SellerEpochProbeReferenceV1
  bank: ProbeBankV1
  model: string
  sellerPeerId: string
  epoch: string
  config?: VerifierCLIConfig
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
}): KbfReferenceV1 {
  const { bank, label } = input
  const sizing = resolveReferenceSizingPolicy(input.config)
  const reference = validateKbfReferenceV1(input.reference, {
    minimumStatisticalPower: sizing.minimumStatisticalPower,
  })
  if (!isReferenceProbeCountAllowed(reference.probes.length, sizing)) {
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
  const bank = await readJsonIfExists<ProbeBankV1>(path)
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
      const value = await readJsonIfExists<EpochProbeReferenceV1 | SellerEpochProbeReferenceV1>(path)
      if ((value?.kind === 'antseed-kbf-seller-epoch-probe-reference' || value?.kind === 'antseed-kbf-epoch-probe-reference')
        && value.reference?.referenceId === referenceId) {
        return structuredClone(value.reference)
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

function bankFromReference(model: string, reference: KbfReferenceV1, cost: ReferenceBuildCostV1): ProbeBankV1 {
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

function probeBankCompatibilityHash(model: string, reference: KbfReferenceV1): string {
  return canonicalHashBytes32({
    model: normalized(model),
    referenceModel: normalized(reference.referenceModel),
    serviceAliases: reference.serviceAliases.map(normalized).sort(),
    queryProfileHash: referenceCompatibilityProfileHash(reference),
    provenance: reference.provenance ?? null,
    generator: {
      name: reference.generator.name,
      version: reference.generator.version,
      enrollmentBatchingVersion: reference.generator.params.enrollmentBatchingVersion ?? null,
      enrollmentStabilityVersion: reference.generator.params.enrollmentStabilityVersion ?? null,
    },
    minimumMismatchDelta: reference.minimumMismatchDelta,
    assumptions: {
      alpha: reference.statisticalPowerEvidence.alpha,
      clopperPearsonConfidence: reference.statisticalPowerEvidence.clopperPearsonConfidence,
    },
  })
}

function selectPoweredReference(
  bank: ProbeBankV1,
  available: readonly BankProbeV1[],
  config: VerifierCLIConfig | undefined,
  now: number,
): KbfReferenceV1 | null {
  const sizing = resolveReferenceSizingPolicy(config)
  const excludedDomains = excludedVerifierDomains(config, bank.model)
  const eligible = available.filter((entry) => !excludedDomains.has(entry.probe.domain))
  const testableContrasts = new Set(bank.probes.flatMap((entry) => entry.distinguishingContrastModels))
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
    if (selfTest.coverage < 0.8 || selfTest.errorRate > 0.35
      || power.power < sizing.minimumStatisticalPower) continue
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
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      alpha: bank.statisticalAssumptions.alpha,
      cpConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
    })
    // Grow the subset until every testable contrast model would be flagged
    // DIFF. A contrast that distinguishes no bank probe at all never answered
    // during enrollment (for example, it was unavailable) and cannot be tested.
    if (contrastDetection.some((entry) => testableContrasts.has(entry.model) && !entry.detected)) continue
    const reference: KbfReferenceV1 = {
      version: KBF_REFERENCE_VERSION,
      kind: 'kbf',
      referenceId: '',
      ...bank.referenceTemplate,
      createdAt: new Date(now).toISOString(),
      queryProfile: bank.queryProfile,
      selfTest,
      probes: selected.map((entry) => entry.probe),
      selectedProbeCount: count,
      statisticalPower: power.power,
      statisticalPowerEvidence: {
        test: 'one-sided-binomial',
        alpha: bank.statisticalAssumptions.alpha,
        clopperPearsonConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
        selfHamming: selfTest.hamming,
        selfTotal: selfTest.total,
        probeCount: count,
        p0UpperBound: power.p0,
        alternativeMismatchRate: power.p1,
        criticalMismatchCount: power.criticalMismatchCount,
        power: power.power,
      },
      contrasts,
      contrastDetection,
    }
    reference.referenceId = computeReferenceId(reference)
    return validateKbfReferenceV1(reference, { minimumStatisticalPower: sizing.minimumStatisticalPower })
  }
  return null
}

function cryptoShuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1)
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!]
  }
  return shuffled
}

async function readRequiredBank(path: string, model: string): Promise<ProbeBankV1> {
  const bank = await readJsonIfExists<ProbeBankV1>(path)
  if (!bank) throw new Error(`no probe bank exists for ${model}; run antseed verifier reference build ${model}`)
  if (!Array.isArray(bank.referenceCosts)) {
    throw new Error(`probe bank for ${model} has no reference cost metadata; rebuild it`)
  }
  assertCurrentBankEnrollment(bank, model)
  return bank
}

function assertCurrentBankEnrollment(bank: ProbeBankV1, model: string): void {
  if (bank.referenceTemplate.generator.name === 'antseed-simple-reference-builder'
    && bank.referenceTemplate.generator.version !== CURRENT_ANTSEED_REFERENCE_BUILDER_VERSION) {
    throw new Error(
      `probe bank for ${model} uses reference enrollment ${bank.referenceTemplate.generator.version}; `
      + `archive it and rebuild with enrollment ${CURRENT_ANTSEED_REFERENCE_BUILDER_VERSION}`,
    )
  }
}
