import { getAddress } from 'ethers'
import { VERIFIER_VERDICT, modelHash, type ModelAuditedEvent, type ServiceAuditedEvent } from '@antseed/node/payments'
import { auditorRotationForModel, type RoundRobinAssignmentInput } from './audit-assignment.js'
import { normalized } from './utils.js'

/**
 * Liveness: a model whose assigned auditor has not audited it by halfway through the epoch moves to
 * the next auditor in that model's rotation who is active this epoch, and from three quarters on to
 * the one after that; a revoked auditor's model moves at once. A model audit only counts when at
 * least `MINIMUM_REAL_RESULTS_PERCENT` of its sellers got a SAME or DIFF, so an audit that learned
 * nothing doesn't end the model. "Active" means the auditor has such an audit this epoch, so a model
 * is not handed to an auditor who is offline too. Off-chain only: the KBF contract accepts and
 * credits any approved auditor's audit of any model, so the stand-in earns the credit the absent
 * auditor would have earned.
 *
 * Deterministic from public inputs (approved auditors, epoch, model list, this epoch's
 * `ModelAudited` events, chain time), so every auditor computes the same stand-ins without talking
 * to each other.
 */
export const HANDOVER_FIRST_FRACTION = 0.5
export const HANDOVER_SECOND_FRACTION = 0.75
/** Share of an auditor's sellers under a model that need a SAME or DIFF for its audit to count. */
export const MINIMUM_REAL_RESULTS_PERCENT = 20

/** One `ModelAudited` event this epoch: the model's hash (`modelHash(name)`) and the auditor. */
export interface ModelAuditRecord {
  modelHash: string
  auditor: string
}

export interface HandoverInput extends RoundRobinAssignmentInput {
  /** This epoch's model audits that count, from `loadEpochModelAudits`. */
  audits: ReadonlyArray<ModelAuditRecord>
  /** Auditors revoked this epoch (`revokedSinceEpochStart`): never stand-ins, and their models move at once. */
  revoked?: ReadonlySet<string>
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
  /** 1 until three quarters through the epoch, 2 from then on. */
  stage: 1 | 2
  /** The assigned auditor was revoked this epoch, so the model did not wait for halfway. */
  revoked: boolean
}

/** The stage the epoch is in at `now`: 0 before halfway, 1 from halfway, 2 from three quarters. */
export function handoverStage(epochStartedAt: number, epochEndsAt: number, now: number): 0 | 1 | 2 {
  const length = epochEndsAt - epochStartedAt
  if (length <= 0) return 0
  const progress = (now - epochStartedAt) / length
  if (progress < HANDOVER_FIRST_FRACTION) return 0
  return progress >= HANDOVER_SECOND_FRACTION ? 2 : 1
}

/** Every model that is handed over at `now`, in model order. Before halfway, only a revoked auditor's. */
export function auditHandovers(input: HandoverInput): AuditHandover[] {
  const stage = handoverStage(input.epochStartedAt, input.epochEndsAt, input.now)
  const revoked = input.revoked ?? new Set<string>()
  if (stage === 0 && revoked.size === 0) return []
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
    const assignedRevoked = revoked.has(assignedAuditor)
    if (stage === 0 && !assignedRevoked) continue
    // Done once anyone audited it this epoch: its auditor, a stand-in, or an auditor approved after the
    // epoch started (the contract only takes approved auditors' audits, so every event counts).
    if (audited.has(normalized(modelHash(model)))) continue
    const candidates = rotation.slice(1).filter((auditor) => active.has(auditor) && !revoked.has(auditor))
    if (candidates.length === 0) continue
    const handoverStep = stage === 2 ? 2 : 1
    const standIn = candidates[Math.min(handoverStep - 1, candidates.length - 1)]!
    handovers.push({ model, assignedAuditor, standIn, stage: handoverStep, revoked: assignedRevoked })
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
  queryServiceAudits(
    agentId: null, service: null, fromBlock?: number, toBlock?: number | 'latest',
  ): Promise<ServiceAuditedEvent[]>
  firstBlockAtOrAfter(timestamp: number, floor?: number): Promise<number>
}

/**
 * The model audits that count, per auditor and model: of the sellers the auditor reported on, at
 * least `MINIMUM_REAL_RESULTS_PERCENT` have a SAME or DIFF as its latest report. `serviceAudits` are
 * matched to `modelAudits` by transaction, so a report from another epoch is never counted.
 */
export function countingModelAudits(
  modelAudits: readonly ModelAuditedEvent[],
  serviceAudits: readonly ServiceAuditedEvent[],
): ModelAuditRecord[] {
  const transactions = new Set(modelAudits.map((event) => event.transactionHash))
  const ordered = serviceAudits
    .filter((event) => transactions.has(event.transactionHash))
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex)
  const latest = new Map<string, Map<string, ServiceAuditedEvent['verdict']>>()
  for (const event of ordered) {
    const key = auditKey(event)
    const sellers = latest.get(key) ?? new Map<string, ServiceAuditedEvent['verdict']>()
    sellers.set(`${event.agentId}:${normalized(event.serviceHash)}`, event.verdict)
    latest.set(key, sellers)
  }
  const counts = (key: string): boolean => {
    const verdicts = [...(latest.get(key)?.values() ?? [])]
    const real = verdicts.filter((verdict) => verdict === VERIFIER_VERDICT.SAME || verdict === VERIFIER_VERDICT.DIFF).length
    return real > 0 && real * 100 >= verdicts.length * MINIMUM_REAL_RESULTS_PERCENT
  }
  return modelAudits
    .filter((event) => counts(auditKey(event)))
    .map((event) => ({ modelHash: event.modelHash, auditor: event.auditor }))
}

function auditKey(event: { auditor: string; modelHash: string }): string {
  return `${getAddress(event.auditor)}:${normalized(event.modelHash)}`
}

/** This epoch's model audits that count (`countingModelAudits`), from the epoch's first block on. */
export async function loadEpochModelAudits(input: {
  reader: EpochModelAuditReader
  epoch: string | number | bigint
  epochStartedAt: number
  /** Lower bound for the block search, e.g. the contract's deployment block. */
  deploymentBlock?: number
}): Promise<ModelAuditRecord[]> {
  const epoch = BigInt(input.epoch)
  const fromBlock = await input.reader.firstBlockAtOrAfter(input.epochStartedAt, input.deploymentBlock ?? 0)
  const [modelAudits, serviceAudits] = await Promise.all([
    input.reader.queryModelAudits({}, fromBlock, 'latest'),
    input.reader.queryServiceAudits(null, null, fromBlock, 'latest'),
  ])
  return countingModelAudits(modelAudits.filter((event) => event.epoch === epoch), serviceAudits)
}

export function describeHandover(entry: AuditHandover): string {
  if (entry.revoked) return `${entry.model}: standing in for ${entry.assignedAuditor}, which was revoked this epoch`
  const since = entry.stage === 1 ? 'halfway through the epoch' : 'three quarters through the epoch'
  return `${entry.model}: standing in for ${entry.assignedAuditor}, which has no audit of it that counts by ${since}`
}
