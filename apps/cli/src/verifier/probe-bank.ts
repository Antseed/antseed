import { randomInt } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  canonicalHashBytes32,
  computeBinomialPower,
  computeReferenceId,
  queryProfileHash,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceSelfTestV1,
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
const CURRENT_ANTSEED_REFERENCE_BUILDER_VERSION = '4'

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

export interface ProbeBankPowerStatus {
  totalProbeCount: number
  eligibleProbeCount: number
  selectedProbeCount: number | null
  statisticalPower: number | null
}

const epochReferenceCreations = new Map<string, Promise<KbfReferenceV1>>()

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
    const reference = await loadOrCreateEpochProbeReference({
      banksDir: input.banksDir,
      model: input.model,
      epoch: input.epoch,
      runId: input.runId,
      allowProbeReuse: input.allowProbeReuse === true,
      config: input.config,
      now,
      shuffle: input.shuffle,
      bank,
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
  const epochReference = await readJsonIfExists<EpochProbeReferenceV1>(
    epochProbeReferencePath(input.banksDir, input.model, assignment.epoch),
  )
  if (epochReference) {
    const reference = validateEpochProbeReference({
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

export function epochProbeReferencePath(banksDir: string, model: string, epoch: string): string {
  return join(banksDir, safeServiceSlug(model), 'epochs', `${safeServiceSlug(epoch)}.json`)
}

async function loadOrCreateEpochProbeReference(input: {
  banksDir: string
  model: string
  epoch: string
  runId: string
  allowProbeReuse: boolean
  config?: VerifierCLIConfig
  now: number
  shuffle?: <T>(values: readonly T[]) => T[]
  bank: ProbeBankV1
}): Promise<KbfReferenceV1> {
  const path = epochProbeReferencePath(input.banksDir, input.model, input.epoch)
  const pending = epochReferenceCreations.get(path)
  if (pending) return pending
  const created = createEpochProbeReference(path, input)
  epochReferenceCreations.set(path, created)
  try {
    return await created
  } finally {
    if (epochReferenceCreations.get(path) === created) epochReferenceCreations.delete(path)
  }
}

async function createEpochProbeReference(
  path: string,
  input: {
    banksDir: string
    model: string
    epoch: string
    runId: string
    allowProbeReuse: boolean
    config?: VerifierCLIConfig
    now: number
    shuffle?: <T>(values: readonly T[]) => T[]
    bank: ProbeBankV1
  },
): Promise<KbfReferenceV1> {
  const lock = await acquirePidFileLock(`${path}.lock`)
  try {
    const existing = await readJsonIfExists<EpochProbeReferenceV1>(path)
    if (existing) {
      return validateEpochProbeReference({
        value: existing,
        bank: input.bank,
        model: input.model,
        epoch: input.epoch,
        config: input.config,
      })
    }
    const used = input.allowProbeReuse
      ? new Set<string>()
      : await usedEpochProbeIds(dirname(path), input.model)
    const activeContrasts = new Set(input.bank.contrastModels.map(normalized))
    const excludedDomains = excludedVerifierDomains(input.config, input.model)
    const available = input.bank.probes.filter((entry) => !used.has(entry.probe.id)
      && !excludedDomains.has(entry.probe.domain)
      && entry.distinguishingContrastModels.some((model) => activeContrasts.has(normalized(model))))
    const shuffled = (input.shuffle ?? cryptoShuffle)(available)
    const reference = selectPoweredReference(input.bank, shuffled, input.config, input.now)
    if (!reference) {
      throw new Error(`${BANK_EXHAUSTED}: ${available.length} unused probes remain for ${input.model} epoch ${input.epoch}`)
    }
    const createdAt = new Date(input.now).toISOString()
    const value: EpochProbeReferenceV1 = {
      version: 1,
      kind: 'antseed-kbf-epoch-probe-reference',
      model: input.model,
      epoch: input.epoch,
      compatibilityHash: input.bank.compatibilityHash,
      reference,
      createdAt,
      createdByRunId: input.runId,
    }
    await writeJsonAtomic(path, value)
    return structuredClone(reference)
  } finally {
    await lock.release()
  }
}

async function usedEpochProbeIds(directory: string, model: string): Promise<Set<string>> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  const used = new Set<string>()
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const value = await readJsonIfExists<EpochProbeReferenceV1>(join(directory, name))
    if (!value || value.version !== 1 || value.kind !== 'antseed-kbf-epoch-probe-reference'
      || normalized(value.model) !== normalized(model) || !Array.isArray(value.reference?.probes)) {
      throw new Error(`invalid epoch probe reference at ${join(directory, name)}`)
    }
    for (const probe of value.reference.probes) used.add(probe.id)
  }
  return used
}

function validateEpochProbeReference(input: {
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
  const sizing = resolveReferenceSizingPolicy(input.config)
  const reference = validateKbfReferenceV1(value.reference, {
    minimumStatisticalPower: sizing.minimumStatisticalPower,
  })
  if (!isReferenceProbeCountAllowed(reference.probes.length, sizing)) {
    throw new Error(`epoch probe reference for ${input.model} epoch ${input.epoch} is incompatible with configured sizing`)
  }
  if (probeBankCompatibilityHash(input.model, reference) !== bank.compatibilityHash) {
    throw new Error(`epoch probe reference for ${input.model} epoch ${input.epoch} is incompatible with the bank`)
  }
  const excludedDomains = excludedVerifierDomains(input.config, input.model)
  if (reference.probes.some((probe) => excludedDomains.has(probe.domain))) {
    throw new Error(`epoch probe reference for ${input.model} epoch ${input.epoch} contains an excluded domain`)
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
  const hash = canonicalHashBytes32({ peerId: normalized(sellerPeerId) }).slice(2)
  return join(banksDir, safeServiceSlug(model), 'sellers', `${hash}.json`)
}

export async function listClaimableReferenceCosts(
  banksDir: string,
  model: string,
  evidenceHash?: string,
): Promise<ReferenceCostEntryV1[]> {
  const bank = await readRequiredBank(bankPath(banksDir, model), model)
  return bank.referenceCosts
    .filter((entry) => entry.status === 'unclaimed'
      || (entry.status === 'reserved' && entry.reservedEvidenceHash === evidenceHash))
    .map((entry) => structuredClone(entry))
}

export async function reserveReferenceCosts(input: {
  banksDir: string
  model: string
  evidenceHash: string
  costIds: string[]
}): Promise<ReferenceCostEntryV1[]> {
  const path = bankPath(input.banksDir, input.model)
  const lock = await acquirePidFileLock(join(dirname(path), '.bank.lock'))
  try {
    const bank = await readRequiredBank(path, input.model)
    const requested = new Set(input.costIds)
    const reserved: ReferenceCostEntryV1[] = []
    for (const entry of bank.referenceCosts) {
      if (!requested.has(entry.costId)) continue
      if (entry.status === 'claimed') throw new Error(`reference cost ${entry.costId} is already claimed`)
      if (entry.status === 'reserved' && entry.reservedEvidenceHash !== input.evidenceHash) {
        throw new Error(`reference cost ${entry.costId} is reserved by another bundle`)
      }
      entry.status = 'reserved'
      entry.reservedEvidenceHash = input.evidenceHash
      reserved.push(structuredClone(entry))
      requested.delete(entry.costId)
    }
    if (requested.size > 0) throw new Error(`unknown reference cost IDs: ${[...requested].join(', ')}`)
    bank.updatedAt = new Date().toISOString()
    await writeJsonAtomic(path, bank)
    return reserved
  } finally {
    await lock.release()
  }
}

export async function markReferenceCostsClaimed(input: {
  banksDir: string
  model: string
  evidenceHash: string
  transactionHash: string
}): Promise<void> {
  const path = bankPath(input.banksDir, input.model)
  const lock = await acquirePidFileLock(join(dirname(path), '.bank.lock'))
  try {
    const bank = await readRequiredBank(path, input.model)
    for (const entry of bank.referenceCosts) {
      if (entry.status !== 'reserved' || entry.reservedEvidenceHash !== input.evidenceHash) continue
      entry.status = 'claimed'
      entry.claimedTransactionHash = input.transactionHash
    }
    bank.updatedAt = new Date().toISOString()
    await writeJsonAtomic(path, bank)
  } finally {
    await lock.release()
  }
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
    queryProfileHash: queryProfileHash(reference.queryProfile),
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
  for (let count = sizing.minimumProbeCount;
    count <= sizing.maximumProbeCount && count <= eligible.length;
    count += sizing.probeStep) {
    const selected = eligible.slice(0, count)
    const selfTest = aggregateSelfTest(selected.map((entry) => entry.selfTest))
    const power = computeBinomialPower({
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      minimumMismatchDelta: bank.referenceTemplate.minimumMismatchDelta,
      alpha: bank.statisticalAssumptions.alpha,
      cpConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
    })
    if (selfTest.coverage < 0.8 || selfTest.errorRate > 0.35
      || power.power < sizing.minimumStatisticalPower) continue
    const selectedIds = new Set(selected.map((entry) => entry.probe.id))
    const reference: KbfReferenceV1 = {
      version: 1,
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
        p0UpperBound: power.p0,
        alternativeMismatchRate: power.p1,
        criticalMismatchCount: power.criticalMismatchCount,
        power: power.power,
      },
      contrasts: bank.contrastModels.map((model) => ({
        model,
        distinguishingProbeIds: selected
          .filter((entry) => entry.distinguishingContrastModels.includes(model) && selectedIds.has(entry.probe.id))
          .map((entry) => entry.probe.id),
      })),
    }
    reference.referenceId = computeReferenceId(reference)
    return validateKbfReferenceV1(reference, { minimumStatisticalPower: sizing.minimumStatisticalPower })
  }
  return null
}

function aggregateSelfTest(outcomes: ReferenceProbeSelfTestV1[]): KbfReferenceSelfTestV1 {
  const parsed = outcomes.filter((outcome) => outcome.match !== null).length
  const hamming = outcomes.filter((outcome) => outcome.match !== 1).length
  return {
    hamming,
    total: outcomes.length,
    coverage: outcomes.length === 0 ? 0 : parsed / outcomes.length,
    errorRate: outcomes.length === 0 ? 0 : hamming / outcomes.length,
    outcomes,
  }
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
