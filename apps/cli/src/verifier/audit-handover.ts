import { getAddress } from 'ethers'
import { modelHash, type ModelAuditedEvent } from '@antseed/node/payments'
import { auditorRotationForModel, type RoundRobinAssignmentInput } from './audit-assignment.js'
import { normalized } from './utils.js'

/**
 * Liveness: a model whose assigned auditor has not audited it by halfway through the epoch moves to
 * the next auditor in that model's rotation who is active this epoch, and from three quarters on to
 * the one after that. "Active" means the auditor submitted at least one model audit this epoch, so a
 * model is not handed to an auditor who is offline too. Off-chain only: the KBF contract accepts and
 * credits any approved auditor's audit of any model, so the stand-in earns the credit the absent
 * auditor would have earned.
 *
 * Deterministic from public inputs (approved auditors, epoch, model list, this epoch's
 * `ModelAudited` events, chain time), so every auditor computes the same stand-ins without talking
 * to each other.
 */
export const HANDOVER_FIRST_FRACTION = 0.5
export const HANDOVER_SECOND_FRACTION = 0.75

/** One `ModelAudited` event this epoch: the model's hash (`modelHash(name)`) and the auditor. */
export interface ModelAuditRecord {
  modelHash: string
  auditor: string
}

export interface HandoverInput extends RoundRobinAssignmentInput {
  /** This epoch's model audits, from `loadEpochModelAudits`. */
  audits: ReadonlyArray<ModelAuditRecord>
  epochStartedAt: number
  epochEndsAt: number
  /** Unix seconds, from `chainNow` so a fork's time moves it. */
  now: number
}

export interface AuditHandover {
  model: string
  /** The model's round-robin auditor, who has not audited it this epoch. */
  assignedAuditor: string
  standIn: string
  /** 1 from halfway through the epoch, 2 from three quarters. */
  stage: 1 | 2
}

/** The stage the epoch is in at `now`: 0 before halfway, 1 from halfway, 2 from three quarters. */
export function handoverStage(epochStartedAt: number, epochEndsAt: number, now: number): 0 | 1 | 2 {
  const length = epochEndsAt - epochStartedAt
  if (length <= 0) return 0
  const progress = (now - epochStartedAt) / length
  if (progress < HANDOVER_FIRST_FRACTION) return 0
  return progress >= HANDOVER_SECOND_FRACTION ? 2 : 1
}

/** Every model that is handed over at `now`, in model order. Empty before halfway through the epoch. */
export function auditHandovers(input: HandoverInput): AuditHandover[] {
  const stage = handoverStage(input.epochStartedAt, input.epochEndsAt, input.now)
  if (stage === 0) return []
  const audited = new Set(input.audits.map((entry) => normalized(entry.modelHash)))
  const active = new Set(input.audits.map((entry) => getAddress(entry.auditor)))
  const handovers: AuditHandover[] = []
  const seen = new Set<string>()
  for (const raw of input.availableModels) {
    const model = raw.trim()
    if (!model || seen.has(model.toLowerCase())) continue
    seen.add(model.toLowerCase())
    const rotation = auditorRotationForModel(model, input)
    const assignedAuditor = rotation[0]
    if (!assignedAuditor) continue
    // Done once anyone audited it this epoch: its auditor, a stand-in, or an auditor approved after the
    // epoch started (the contract only takes approved auditors' audits, so every event counts).
    if (audited.has(normalized(modelHash(model)))) continue
    const candidates = rotation.slice(1).filter((auditor) => active.has(auditor))
    if (candidates.length === 0) continue
    const standIn = candidates[Math.min(stage - 1, candidates.length - 1)]!
    handovers.push({ model, assignedAuditor, standIn, stage })
  }
  return handovers.sort((left, right) => left.model.localeCompare(right.model))
}

/** The models `auditor` stands in for at `now`. */
export function handoverModelsFor(auditor: string, input: HandoverInput): AuditHandover[] {
  const me = getAddress(auditor)
  return auditHandovers(input).filter((entry) => entry.standIn === me)
}

/** The reads `loadEpochModelAudits` needs from the KBF audits contract. */
export interface EpochModelAuditReader {
  queryModelAudits(
    filter: { model?: string | null; auditor?: string | null },
    fromBlock?: number,
    toBlock?: number | 'latest',
  ): Promise<ModelAuditedEvent[]>
  firstBlockAtOrAfter(timestamp: number, floor?: number): Promise<number>
}

/** This epoch's `ModelAudited` events, from the epoch's first block on, keeping only this epoch's. */
export async function loadEpochModelAudits(input: {
  reader: EpochModelAuditReader
  epoch: string | number | bigint
  epochStartedAt: number
  /** Lower bound for the block search, e.g. the contract's deployment block. */
  deploymentBlock?: number
}): Promise<ModelAuditRecord[]> {
  const epoch = BigInt(input.epoch)
  const fromBlock = await input.reader.firstBlockAtOrAfter(input.epochStartedAt, input.deploymentBlock ?? 0)
  const events = await input.reader.queryModelAudits({}, fromBlock, 'latest')
  return events.filter((event) => event.epoch === epoch).map((event) => ({ modelHash: event.modelHash, auditor: event.auditor }))
}

export function describeHandover(entry: AuditHandover): string {
  const since = entry.stage === 1 ? 'halfway through the epoch' : 'three quarters through the epoch'
  return `${entry.model}: standing in for ${entry.assignedAuditor}, which has not audited it by ${since}`
}
