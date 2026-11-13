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
import { mapConcurrently } from './audit-concurrency.js'

/** The reads the confirmation helpers need from the KBF audits and results contracts. */
export interface EpochReportReader {
  queryServiceAudits(
    agentId: null, service: null, fromBlock?: number, toBlock?: number | 'latest',
  ): Promise<ServiceAuditedEvent[]>
  firstBlockAtOrAfter(timestamp: number, floor?: number): Promise<number>
}

/**
 * Every auditor's latest report this epoch on one (agent, service, model), in the service's current
 * report round. The contract starts a new round whenever the service's verdict moves into or out of
 * DIFF, and reports from earlier rounds stop counting.
 */
export interface EpochReport {
  agentId: bigint
  serviceHash: string
  modelHash: string
  round: number
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
export async function loadEpochAuditEvents(input: {
  reader: EpochReportReader
  epochStartedAt: number
  /** Lower bound for the block search, e.g. the contract's deployment block. */
  deploymentBlock?: number
}): Promise<ServiceAuditedEvent[]> {
  const fromBlock = await input.reader.firstBlockAtOrAfter(input.epochStartedAt, input.deploymentBlock ?? 0)
  return input.reader.queryServiceAudits(null, null, fromBlock, 'latest')
}

/** This epoch's reports, as `epochReports` replays them from `loadEpochAuditEvents`. */
export async function loadEpochReports(input: Parameters<typeof loadEpochAuditEvents>[0]): Promise<Map<string, EpochReport>> {
  return epochReports(await loadEpochAuditEvents(input))
}

/** One auditor's latest report on a service and model this epoch, in whatever round it was made. */
export interface OwnReport {
  verdict: VerifierVerdict
  round: number
  blockNumber: number
  logIndex: number
}

/** `auditor`'s latest report this epoch on each service and model, in any report round, keyed by `reportKey`. */
export function ownLatestReports(events: readonly ServiceAuditedEvent[], auditor: string): Map<string, OwnReport> {
  const me = getAddress(auditor)
  const reports = new Map<string, OwnReport>()
  for (const event of events) {
    if (getAddress(event.auditor) !== me) continue
    const key = reportKey(event.agentId, event.serviceHash, event.modelHash)
    const current = reports.get(key)
    if (current && (current.blockNumber > event.blockNumber
      || (current.blockNumber === event.blockNumber && current.logIndex > event.logIndex))) continue
    reports.set(key, { verdict: event.verdict, round: event.round, blockNumber: event.blockNumber, logIndex: event.logIndex })
  }
  return reports
}

export function reportKey(agentId: bigint, service: string, model: string): string {
  return `${serviceKey(agentId, service)}:${normalized(model)}`
}

/**
 * Replays `ServiceAudited` events, in block order, into each auditor's latest report per service and
 * model, keeping only each service's latest report round (what the contract still counts).
 */
export function epochReports(events: readonly ServiceAuditedEvent[]): Map<string, EpochReport> {
  const latestRound = new Map<string, number>()
  for (const event of events) {
    const service = serviceKey(event.agentId, event.serviceHash)
    latestRound.set(service, Math.max(latestRound.get(service) ?? 0, event.round))
  }
  const reports = new Map<string, EpochReport>()
  for (const event of events) {
    if (event.round !== latestRound.get(serviceKey(event.agentId, event.serviceHash))) continue
    const key = reportKey(event.agentId, event.serviceHash, event.modelHash)
    let report = reports.get(key)
    if (!report) {
      report = {
        agentId: event.agentId,
        serviceHash: event.serviceHash,
        modelHash: event.modelHash,
        round: event.round,
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
  /** The report round the waiting reports were made in. */
  round: number
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
  const rotations = new Map<string, string[]>()
  for (const report of input.reports.values()) {
    const model = modelsByHash.get(normalized(report.modelHash))
    if (!model) continue
    const waiting = verdictTallies(report).filter((tally) => tally.reports > 0 && tally.reports < tally.required)
    if (waiting.length === 0) continue
    const reporters = [...report.byAuditor.keys()]
    const reported = new Set(reporters)
    // The rotation depends only on the model and the epoch's inputs, so it is computed once per model.
    let rotation = rotations.get(model)
    if (rotation === undefined) {
      rotation = auditorRotationForModel(model, {
        auditors: input.auditors, epoch: input.epoch, availableModels: input.auditedModels,
      })
      rotations.set(model, rotation)
    }
    const confirmer = rotation.find((auditor) => !reported.has(auditor)) ?? null
    const mine = !reported.has(me) && (confirmer === me || (pastHalf && confirmer !== null))
    pending.push({
      model,
      modelHash: report.modelHash,
      agentId: report.agentId,
      serviceHash: report.serviceHash,
      round: report.round,
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

/** The on-chain reads `dropSettledConfirmations` needs. */
export interface SettledConfirmationReader {
  reportRound(agentId: bigint, serviceHash: string): Promise<number>
  serviceStatusByHash(agentId: bigint, serviceHash: string): Promise<{ verdict: VerifierVerdict; epoch: bigint }>
}

/**
 * Drops waiting reports there is nothing left to confirm for, read from the contract:
 * - the service's report round moved past them (a DIFF was given or cleared, or an auditor was
 *   revoked, after they were made), so the contract no longer counts them;
 * - every waiting verdict is already the service's verdict recorded this epoch, e.g. an auditor
 *   resubmitting its DIFF after another auditor confirmed it.
 * Only the entries this auditor would act on are read.
 */
export async function dropSettledConfirmations(
  pending: readonly PendingConfirmation[],
  reader: SettledConfirmationReader,
  epoch: bigint,
): Promise<PendingConfirmation[]> {
  const checked = await mapConcurrently(pending, SETTLED_READ_CONCURRENCY, async (entry) => {
    if (!entry.mine) return entry
    const [round, status] = await Promise.all([
      reader.reportRound(entry.agentId, entry.serviceHash),
      reader.serviceStatusByHash(entry.agentId, entry.serviceHash),
    ])
    if (round > entry.round) return null
    const recorded = VERDICT_NAMES[status.verdict]
    if (status.epoch === epoch && entry.waiting.every((tally) => tally.verdict === recorded)) return null
    return entry
  })
  return checked.filter((entry): entry is PendingConfirmation => entry !== null)
}

/** Sellers whose confirmation status is read at the same time (two reads each). */
const SETTLED_READ_CONCURRENCY = 8

export interface ConfirmationTarget {
  agentId: bigint
  /** The service name the waiting reports are for. */
  service: string
  waiting: VerdictTally[]
  /**
   * Unix seconds of this auditor's latest report on this service and model this epoch, from a report
   * round the contract no longer counts; null when it has not reported on it this epoch.
   */
  ownReportedAt: number | null
}

/**
 * Whether a result this auditor already has for the seller answers its waiting confirmation once
 * submitted: it is for the reported service and newer than this auditor's last report on it. An
 * older result was already submitted, in a round the contract no longer counts, and a result for
 * another service adds nothing to this service's tally; either way the seller is audited again.
 */
export function localResultAnswersConfirmation(
  target: ConfirmationTarget,
  local: { service: string; completedAt: number } | null,
): boolean {
  if (!local || normalized(local.service) !== normalized(target.service)) return false
  return target.ownReportedAt === null || local.completedAt > target.ownReportedAt
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
    if (!agents.has(key)) agents.set(key, { agentId: entry.agentId, service, waiting: entry.waiting, ownReportedAt: null })
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

function serviceKey(agentId: bigint, service: string): string {
  return `${agentId}:${normalized(service)}`
}
