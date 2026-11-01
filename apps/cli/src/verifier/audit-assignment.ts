import { getAddress, keccak256, toUtf8Bytes } from 'ethers'

export type AuditAssignmentStrategy = 'all' | 'round-robin'

export interface AuditAssignmentInput {
  auditor: string
  epoch: string
  availableModels: readonly string[]
}

export interface AuditAssignment {
  auditor: string
  epoch: string
  strategy: AuditAssignmentStrategy
  models: string[]
}

/** Every audited model for one auditor ('all'): what `verifier run --all` audits. */
export function assignAuditModels(input: AuditAssignmentInput): AuditAssignment {
  const epoch = input.epoch.trim()
  if (!epoch) throw new Error('audit assignment requires an epoch')
  const seen = new Set<string>()
  const models: string[] = []
  for (const value of input.availableModels) {
    const model = value.trim()
    const key = model.toLowerCase()
    if (!model || seen.has(key)) continue
    seen.add(key)
    models.push(model)
  }
  models.sort((left, right) => left.localeCompare(right))
  return { auditor: getAddress(input.auditor.trim()), epoch, strategy: 'all', models }
}

export interface RoundRobinAssignmentInput {
  /** Every auditor in the rotation: the contract's approved auditors. Order, case and duplicates do not matter. */
  auditors: readonly string[]
  /** On-chain emissions epoch, as a non-negative integer. */
  epoch: string | number | bigint
  availableModels: readonly string[]
}

/**
 * Splits every audited model across the approved auditors each epoch, rotating round robin, so
 * every model is audited every epoch (a verdict only counts for `validityEpochs` epochs). Assignment
 * is off-chain only: the contract credits any approved auditor's audit of any model.
 *
 * Auditors are sorted by address and models by name. In epoch `e`, model `i` goes to auditor
 * `(i + e) mod A`. That gives:
 * - every model has exactly one auditor every epoch;
 * - auditors' model counts differ by at most one (`floor(M / A)` or `ceil(M / A)`);
 * - with two or more auditors, an auditor's models in one epoch and the next never overlap;
 * - over `A` consecutive epochs every auditor audits every model exactly once.
 * With more auditors than models (not expected), the auditors without a model change every epoch.
 *
 * Deterministic and independent of input order, so anyone can recompute and check an assignment.
 * Returns one entry per auditor, in address order, including any auditor with no model.
 */
export function assignAuditModelsRoundRobin(input: RoundRobinAssignmentInput): AuditAssignment[] {
  const epoch = parseEpoch(input.epoch)
  const auditors = uniqueAuditors(input.auditors)
  if (auditors.length === 0) throw new Error('round-robin assignment requires at least one approved auditor')
  const models = uniqueModels(input.availableModels)
  if (models.length === 0) throw new Error('round-robin assignment requires at least one audited model')
  const offset = Number(epoch % BigInt(auditors.length))
  const assigned = auditors.map(() => [] as string[])
  models.forEach((model, index) => assigned[(index + offset) % auditors.length]!.push(model))
  return auditors.map((auditor, index) => ({
    auditor,
    epoch: epoch.toString(),
    strategy: 'round-robin',
    models: assigned[index]!,
  }))
}

/** One auditor's round-robin models. Throws if the auditor is not in the rotation. */
export function roundRobinAssignmentFor(auditor: string, input: RoundRobinAssignmentInput): AuditAssignment {
  const address = getAddress(auditor.trim())
  const assignment = assignAuditModelsRoundRobin(input).find((entry) => entry.auditor === address)
  if (!assignment) throw new Error(`auditor ${address} is not an approved auditor, so it has no round-robin models`)
  return assignment
}

/**
 * The approved auditors in the order they take a model in `epoch`: the model's round-robin auditor
 * first, then the next auditor in the rotation, and so on. A report on the model that waits for a
 * confirmation is confirmed by the first auditor in this order that has not reported on it yet, so
 * confirmations rotate between auditors the same way the assignment does: with two auditors, each
 * one confirms the other's reports. Empty when the model is not in `availableModels`.
 */
export function auditorRotationForModel(model: string, input: RoundRobinAssignmentInput): string[] {
  const epoch = parseEpoch(input.epoch)
  const auditors = uniqueAuditors(input.auditors)
  const index = uniqueModels(input.availableModels).findIndex((entry) => entry.toLowerCase() === model.trim().toLowerCase())
  if (index < 0 || auditors.length === 0) return []
  const first = (index + Number(epoch % BigInt(auditors.length))) % auditors.length
  return auditors.map((_, offset) => auditors[(first + offset) % auditors.length]!)
}

/**
 * Fingerprint of the sorted model list. Auditors on different CLI versions may have different
 * built-in lists and so different assignments; comparing this hash shows whether they agree.
 */
export function auditModelListHash(models: readonly string[]): string {
  return keccak256(toUtf8Bytes(uniqueModels(models).map((model) => model.toLowerCase()).join('\n')))
}

function parseEpoch(value: string | number | bigint): bigint {
  const text = typeof value === 'string' ? value.trim() : String(value)
  if (!/^\d+$/.test(text)) throw new Error(`round-robin assignment requires a non-negative integer on-chain epoch, got "${String(value)}"`)
  return BigInt(text)
}

/** Trimmed, case-insensitively unique and sorted; for names differing only in case, the lowest spelling wins. */
function uniqueModels(values: readonly string[]): string[] {
  const unique = new Map<string, string>()
  for (const value of values) {
    const model = value.trim()
    if (!model) continue
    const key = model.toLowerCase()
    const kept = unique.get(key)
    if (kept === undefined || model < kept) unique.set(key, model)
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right))
}

function uniqueAuditors(values: readonly string[]): string[] {
  const unique = new Map<string, string>()
  for (const value of values) {
    const address = getAddress(value.trim())
    unique.set(address.toLowerCase(), address)
  }
  return [...unique.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, address]) => address)
}
