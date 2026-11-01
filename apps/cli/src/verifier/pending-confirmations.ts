import { getAddress } from 'ethers'
import {
  VERIFIER_VERDICT,
  modelHash,
  serviceHash,
  type ServiceAuditedEvent,
  type VerifierVerdict,
  type VerifierVerdictName,
} from '@antseed/node/payments'
import { auditorRotationForModel } from './audit-assignment.js'
import { normalized } from './utils.js'

/** The reads the confirmation helpers need from the verification contract. */
export interface EpochReportReader {
  queryServiceAudits(
    agentId: null, service: null, fromBlock?: number, toBlock?: number | 'latest',
  ): Promise<ServiceAuditedEvent[]>
  firstBlockAtOrAfter(timestamp: number, floor?: number): Promise<number>
}

/** Every auditor's latest report this epoch on one (agent, service, model). */
export interface EpochReport {
  agentId: bigint
  serviceHash: string
  modelHash: string
  /** Checksummed auditor address to its latest verdict this epoch. */
  byAuditor: Map<string, VerifierVerdict>
  /** Reports each verdict needed at its latest report (the contract raises SAME and UNDETERMINED while a DIFF is live). */
  required: Map<VerifierVerdict, number>
}

export interface VerdictTally {
  verdict: VerifierVerdictName
  reports: number
  required: number
}

const VERDICT_NAMES: Record<number, VerifierVerdictName> = {
  [VERIFIER_VERDICT.SAME]: 'SAME',
  [VERIFIER_VERDICT.DIFF]: 'DIFF',
  [VERIFIER_VERDICT.UNDETERMINED]: 'UNDETERMINED',
}

/** Reads this epoch's `ServiceAudited` events, from the epoch's first block on. */
export async function loadEpochReports(input: {
  reader: EpochReportReader
  epochStartedAt: number
  /** Lower bound for the block search, e.g. the contract's deployment block. */
  deploymentBlock?: number
}): Promise<Map<string, EpochReport>> {
  const fromBlock = await input.reader.firstBlockAtOrAfter(input.epochStartedAt, input.deploymentBlock ?? 0)
  return epochReports(await input.reader.queryServiceAudits(null, null, fromBlock, 'latest'))
}

/** Replays `ServiceAudited` events, in block order, into each auditor's latest report per service and model. */
export function epochReports(events: readonly ServiceAuditedEvent[]): Map<string, EpochReport> {
  const reports = new Map<string, EpochReport>()
  for (const event of events) {
    const key = reportKey(event.agentId, event.serviceHash, event.modelHash)
    let report = reports.get(key)
    if (!report) {
      report = {
        agentId: event.agentId,
        serviceHash: event.serviceHash,
        modelHash: event.modelHash,
        byAuditor: new Map(),
        required: new Map(),
      }
      reports.set(key, report)
    }
    report.byAuditor.set(getAddress(event.auditor), event.verdict)
    report.required.set(event.verdict, event.required)
  }
  return reports
}

/** Each verdict reported on the service this epoch: distinct auditors reporting it now, and reports it needs. */
export function verdictTallies(report: EpochReport): VerdictTally[] {
  const tallies: VerdictTally[] = []
  for (const [verdict, required] of report.required) {
    const name = VERDICT_NAMES[verdict]
    if (!name) continue
    const reports = [...report.byAuditor.values()].filter((entry) => entry === verdict).length
    tallies.push({ verdict: name, reports, required })
  }
  return tallies.sort((left, right) => left.verdict.localeCompare(right.verdict))
}

/**
 * A report on one seller's service that still waits for more auditors this epoch, and who is to
 * confirm it: the first auditor in the model's rotation (`auditorRotationForModel`) that has not
 * reported on it yet. From halfway through the epoch, any auditor that has not reported on it may.
 */
export interface PendingConfirmation {
  model: string
  modelHash: string
  agentId: bigint
  serviceHash: string
  /** Verdicts with at least one report and fewer than they need. */
  waiting: VerdictTally[]
  /** Auditors that reported on this service and model this epoch. */
  reporters: string[]
  /** The auditor the rotation gives this confirmation to; null when every approved auditor has reported. */
  confirmer: string | null
  /** True when `auditor` is to audit this seller now: it is the confirmer, or the epoch is past halfway and it has not reported. */
  mine: boolean
}

/**
 * Reports waiting for a confirmation this epoch, for the models this CLI audits. `auditors` are the
 * auditors approved at the epoch's start, and `auditedModels` every audited model, as for the
 * round-robin assignment.
 */
export function pendingConfirmations(input: {
  reports: ReadonlyMap<string, EpochReport>
  epoch: string | number | bigint
  epochStartedAt: number
  epochEndsAt: number
  /** Unix seconds. */
  now: number
  auditor: string
  auditors: readonly string[]
  auditedModels: readonly string[]
  /** Models whose reports are considered; default `auditedModels`. */
  models?: readonly string[]
}): PendingConfirmation[] {
  const me = getAddress(input.auditor)
  const modelsByHash = new Map((input.models ?? input.auditedModels).map((model) => [normalized(modelHash(model)), model]))
  const pastHalf = input.now >= input.epochStartedAt + (input.epochEndsAt - input.epochStartedAt) / 2
  const pending: PendingConfirmation[] = []
  for (const report of input.reports.values()) {
    const model = modelsByHash.get(normalized(report.modelHash))
    if (!model) continue
    const waiting = verdictTallies(report).filter((tally) => tally.reports > 0 && tally.reports < tally.required)
    if (waiting.length === 0) continue
    const reporters = [...report.byAuditor.keys()]
    const reported = new Set(reporters)
    const rotation = auditorRotationForModel(model, {
      auditors: input.auditors, epoch: input.epoch, availableModels: input.auditedModels,
    })
    const confirmer = rotation.find((auditor) => !reported.has(auditor)) ?? null
    const mine = !reported.has(me) && (confirmer === me || (pastHalf && confirmer !== null))
    pending.push({
      model,
      modelHash: report.modelHash,
      agentId: report.agentId,
      serviceHash: report.serviceHash,
      waiting,
      reporters,
      confirmer,
      mine,
    })
  }
  return pending.sort((left, right) => (
    left.model.localeCompare(right.model)
    || (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0)
    || left.serviceHash.localeCompare(right.serviceHash)
  ))
}

export interface ConfirmationTarget {
  agentId: bigint
  /** The service name the waiting reports are for. */
  service: string
  waiting: VerdictTally[]
}

/**
 * The confirmations a model's run must cover, by seller agent id: the service each waiting report
 * is for, among the model's configured service names. Only confirmations that are `mine`; a report
 * for a service name this CLI does not audit under the model cannot be confirmed by it.
 */
export function confirmationTargetsByModel(
  pending: readonly PendingConfirmation[],
  servicesFor: (model: string) => readonly string[],
): Map<string, Map<string, ConfirmationTarget>> {
  const byModel = new Map<string, Map<string, ConfirmationTarget>>()
  for (const entry of pending) {
    if (!entry.mine) continue
    const service = servicesFor(entry.model).find((name) => normalized(serviceHash(name)) === normalized(entry.serviceHash))
    if (!service) continue
    let agents = byModel.get(entry.model)
    if (!agents) {
      agents = new Map()
      byModel.set(entry.model, agents)
    }
    const key = entry.agentId.toString()
    if (!agents.has(key)) agents.set(key, { agentId: entry.agentId, service, waiting: entry.waiting })
  }
  return byModel
}

export function describeTallies(tallies: readonly VerdictTally[]): string {
  return tallies.map((tally) => `${tally.verdict} ${tally.reports}/${tally.required}`).join(', ')
}

/**
 * After a submission: for each of `auditor`'s results under `modelHash` this epoch, how many
 * auditors report its verdict and how many it needs.
 */
export function ownResultTallies(input: {
  reports: ReadonlyMap<string, EpochReport>
  auditor: string
  modelHash: string
}): Array<{ agentId: bigint; serviceHash: string; tally: VerdictTally }> {
  const me = getAddress(input.auditor)
  const results: Array<{ agentId: bigint; serviceHash: string; tally: VerdictTally }> = []
  for (const report of input.reports.values()) {
    if (normalized(report.modelHash) !== normalized(input.modelHash)) continue
    const own = report.byAuditor.get(me)
    const tally = own === undefined ? undefined : verdictTallies(report).find((entry) => entry.verdict === VERDICT_NAMES[own])
    if (tally) results.push({ agentId: report.agentId, serviceHash: report.serviceHash, tally })
  }
  return results.sort((left, right) => (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0))
}

function reportKey(agentId: bigint, service: string, model: string): string {
  return `${agentId}:${normalized(service)}:${normalized(model)}`
}
