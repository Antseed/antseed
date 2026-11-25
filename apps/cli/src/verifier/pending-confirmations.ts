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
  /** Block of each verdict's first report in this round: a confirmer's turn counts from there. */
  firstReportBlock: Map<VerifierVerdict, number>
  /** Checksummed auditor address to its latest SAME or DIFF this epoch, in any round. UNDETERMINED is no opinion. */
  opinions: Map<string, VerifierVerdict>
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

/**
 * How long one auditor has to answer a waiting report. A report is confirmed by one auditor at a
 * time: when its time is up, the next auditor in the rotation is asked instead.
 */
export const CONFIRMATION_WINDOW_SECONDS = 12 * 60 * 60

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

/** This epoch's disputed sellers, as `disputedSellers`; empty when the chain can't be read, since they only annotate the overview. */
export async function loadDisputedSellers(input: Parameters<typeof loadEpochAuditEvents>[0]): Promise<Set<string>> {
  try {
    return disputedSellers(await loadEpochReports(input))
  } catch {
    return new Set()
  }
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
  const opinions = new Map<string, Map<string, VerifierVerdict>>()
  for (const event of events) {
    const service = serviceKey(event.agentId, event.serviceHash)
    latestRound.set(service, Math.max(latestRound.get(service) ?? 0, event.round))
    if (event.verdict !== VERIFIER_VERDICT.SAME && event.verdict !== VERIFIER_VERDICT.DIFF) continue
    const key = reportKey(event.agentId, event.serviceHash, event.modelHash)
    const byAuditor = opinions.get(key) ?? new Map<string, VerifierVerdict>()
    byAuditor.set(getAddress(event.auditor), event.verdict)
    opinions.set(key, byAuditor)
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
        firstReportBlock: new Map(),
        opinions: opinions.get(key) ?? new Map(),
      }
      reports.set(key, report)
    }
    report.byAuditor.set(getAddress(event.auditor), event.verdict)
    report.required.set(event.verdict, event.required)
    if (!report.firstReportBlock.has(event.verdict)) report.firstReportBlock.set(event.verdict, event.blockNumber)
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

function waitingTallies(report: EpochReport): VerdictTally[] {
  return verdictTallies(report).filter((tally) => tally.reports > 0 && tally.reports < tally.required)
}

/** Whether two auditors gave opposite opinions on this service and model this epoch, in any round. */
function isDisputed(report: EpochReport): boolean {
  return new Set(report.opinions.values()).size > 1
}

/** Key of one seller and model in `disputedSellers`. */
export function disputeKey(agentId: bigint | string, model: string): string {
  return `${agentId}:${normalized(model)}`
}

/** The sellers and models (`disputeKey`, by model hash) two auditors gave opposite opinions on this epoch. */
export function disputedSellers(reports: ReadonlyMap<string, EpochReport>): Set<string> {
  const disputed = new Set<string>()
  for (const report of reports.values()) {
    if (isDisputed(report)) disputed.add(disputeKey(report.agentId, report.modelHash))
  }
  return disputed
}

/** The block the report's waiting started in: the earliest first report of a verdict that still waits. */
function waitingSinceBlock(report: EpochReport): number {
  const waiting = new Set(waitingTallies(report).map((tally) => tally.verdict))
  const blocks = [...report.firstReportBlock]
    .filter(([verdict]) => waiting.has(VERDICT_NAMES[verdict]!))
    .map(([, block]) => block)
  return Math.min(...blocks)
}

/** The blocks whose timestamps `pendingConfirmations` needs. */
export function waitingReportBlocks(reports: ReadonlyMap<string, EpochReport>): number[] {
  const blocks = new Set<number>()
  for (const report of reports.values()) {
    // Disputed reports too: an opinion of a revoked auditor does not count, so one may not be disputed after all.
    if (waitingTallies(report).length > 0) blocks.add(waitingSinceBlock(report))
  }
  return [...blocks]
}

/** Unix seconds of each block; a block the node cannot return is an error, so no two auditors work out different turns. */
export async function loadBlockTimestamps(
  reader: { getBlock(block: number): Promise<{ timestamp: number } | null> },
  blocks: readonly number[],
): Promise<Map<number, number>> {
  const timestamps = await mapConcurrently(blocks, SETTLED_READ_CONCURRENCY, async (block) => {
    const header = await reader.getBlock(block)
    if (!header) throw new Error(`block ${block} of an earlier report is unavailable`)
    return [block, header.timestamp] as const
  })
  return new Map(timestamps)
}

/**
 * A report on one seller's service that still waits for more auditors this epoch, and who is to
 * confirm it. A seller gets at most two opinions per model and epoch: one auditor confirms at a
 * time, the first in the model's rotation (`auditorRotationForModel`) that has not reported on it,
 * and each has `CONFIRMATION_WINDOW_SECONDS` before the next one is asked instead. Once two auditors
 * disagree nobody else is asked: the SAME stands.
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
  /** Two auditors gave opposite opinions this epoch, so nobody else is asked. */
  disputed: boolean
  /** The auditor whose turn it is; null when the report is disputed or every approved auditor has reported. */
  confirmer: string | null
  /** True when `auditor` is to audit this seller now. */
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
  /** Unix seconds of the blocks in `waitingReportBlocks(reports)`. Without one, the first confirmer's turn never ends. */
  blockTimestamps?: ReadonlyMap<number, number>
  /** Auditors revoked this epoch (`revokedSinceEpochStart`): they can no longer submit, so they are never asked. */
  revoked?: ReadonlySet<string>
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
  const pending: PendingConfirmation[] = []
  const rotations = new Map<string, string[]>()
  for (const report of input.reports.values()) {
    const model = modelsByHash.get(normalized(report.modelHash))
    if (!model) continue
    const waiting = waitingTallies(report)
    if (waiting.length === 0) continue
    const reporters = [...report.byAuditor.keys()]
    const reported = new Set([...reporters, ...report.opinions.keys()])
    // A revoked auditor's opinion does not count toward the two a seller gets: after a revocation the
    // waiting report gets one more confirmer, instead of every remaining auditor being asked in turn
    // for a result `submit` would then drop as a third opinion.
    const counted = [...report.opinions].filter(([auditor]) => !input.revoked?.has(auditor)).map(([, verdict]) => verdict)
    const disputed = new Set(counted).size > 1
    const twoOpinions = counted.length >= 2
    // The rotation depends only on the model and the epoch's inputs, so it is computed once per model.
    let rotation = rotations.get(model)
    if (rotation === undefined) {
      rotation = auditorRotationForModel(model, {
        auditors: input.auditors, epoch: input.epoch, availableModels: input.auditedModels,
      })
      rotations.set(model, rotation)
    }
    const confirmer = disputed || twoOpinions ? null : confirmerOnTurn(
      rotation.filter((auditor) => !reported.has(auditor) && !input.revoked?.has(auditor)),
      input.blockTimestamps?.get(waitingSinceBlock(report)),
      input.now,
    )
    pending.push({
      model,
      modelHash: report.modelHash,
      agentId: report.agentId,
      serviceHash: report.serviceHash,
      round: report.round,
      waiting,
      reporters,
      disputed,
      confirmer,
      mine: confirmer === me,
    })
  }
  return pending.sort((left, right) => (
    left.model.localeCompare(right.model)
    || (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0)
    || left.serviceHash.localeCompare(right.serviceHash)
  ))
}

/** Whose turn it is, counted from the first report in chain time; the turns start over after the last candidate. */
function confirmerOnTurn(candidates: readonly string[], reportedAt: number | undefined, now: number): string | null {
  if (candidates.length === 0) return null
  const elapsed = reportedAt === undefined ? 0 : Math.max(0, now - reportedAt)
  return candidates[Math.floor(elapsed / CONFIRMATION_WINDOW_SECONDS) % candidates.length]!
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
