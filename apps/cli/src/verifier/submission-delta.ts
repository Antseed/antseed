import type { AuditorSetEvent, ServiceAuditedEvent, VerifierVerdict } from '@antseed/node/payments'
import { mapConcurrently } from './audit-concurrency.js'
import { ownLatestReports, reportKey, type OwnReport } from './pending-confirmations.js'
import { normalized } from './utils.js'

/** One seller result `verifier submit` could send for a model. */
/**
 * Per candidate: true when this auditor already reported it (left out as on chain), 'superseded' when it is an older
 * audit than this auditor's own standing report with another verdict (left out, and said so), false to send.
 */
export type AlreadyOnChain = boolean | 'superseded'

export interface SubmissionCandidate {
  agentId: bigint
  serviceHash: string
  verdict: VerifierVerdict
  /** Unix seconds the audit behind this result was made (its latest evidence file). */
  auditedAt: number
  /** Its earliest request on this auditor's clock (`earliestAuditorTime`), the clock the planner compares with. */
  firstRequestAt?: number | null
  /** Set by `verifier run` on a result that answers a DIFF waiting for this auditor's confirmation. */
  confirmsDiff?: boolean
}

/** The on-chain reads `resultsAlreadyOnChain` makes; only for results this auditor already reported. */
export interface SubmissionDeltaReader {
  reportRound(agentId: bigint, serviceHash: string): Promise<number>
  serviceStatusByHash(agentId: bigint, serviceHash: string): Promise<{ modelHash: string; verdict: VerifierVerdict; epoch: bigint }>
  /** Unix seconds of a block. */
  blockTimestamp(blockNumber: number): Promise<number>
  /** Auditor revocations after the given log position (each one starts a new report round everywhere). */
  revocationsAfter(blockNumber: number, logIndex: number): Promise<number>
}

const READ_CONCURRENCY = 8

/**
 * Which of a model's results this auditor already has on-chain, so `verifier submit` leaves them out
 * of the submission (and of its evidence). One flag per candidate, in order.
 *
 * A result is sent when this auditor's latest report this epoch on the service and model is missing
 * (a first report, including a confirmation of another auditor's report) or has another verdict (a
 * real change). When it already reported the same verdict, the result is left out, except when
 * re-sending it is the only way to make that report count again. The contract (`_report`) decides:
 * 1. Same report round: a repeated report adds no support (same auditor, same verdict), so re-sending
 *    only emits another event. It could record again when one report is enough and the recorded
 *    status has since moved to another model, but re-sending a stale result to flip it back is a
 *    ping-pong between auditors, not new information, so it is left out too.
 * 2. The service's recorded status already is this verdict for this model this epoch: nothing to
 *    record and nothing to support. This covers an auditor's own DIFF after another auditor confirmed
 *    it: recording the DIFF starts a new round, and the re-sent DIFF would show up as "DIFF 1/2" in it.
 * 3. The round moved on and the status is something else. A new round starts when the verdict moves
 *    into or out of DIFF, or an auditor is revoked.
 *    - Only revocations moved it: the report was dropped with every other waiting report, not
 *      outvoted, so it is sent again to count in the new round (and be confirmed there).
 *    - A DIFF change moved it: the contract deliberately stops counting support given before the
 *      change, so it is sent only when the audit behind it is newer than the report (a fresh look,
 *      e.g. confirming a report made in the new round). Re-sending the old audit would carry the old
 *      support over by hand.
 * 4. Another verdict than this auditor's own standing report: sent only when its audit is newer than that report, so an
 *    older audit never replaces a newer verdict of the same auditor (also when an older run is submitted by hand).
 */
export async function resultsAlreadyOnChain(input: {
  candidates: readonly SubmissionCandidate[]
  modelHash: string
  epoch: bigint
  /** This auditor's latest reports this epoch (`ownLatestReports`). */
  own: ReadonlyMap<string, OwnReport>
  reader: SubmissionDeltaReader
  /** The time of the audit behind this auditor's own report (seconds), when its ledger knows it. */
  reportedAuditTime?: (own: OwnReport, candidate: SubmissionCandidate) => Promise<number | null>
}): Promise<AlreadyOnChain[]> {
  return mapConcurrently(input.candidates, READ_CONCURRENCY, async (candidate) => {
    const own = input.own.get(reportKey(candidate.agentId, candidate.serviceHash, input.modelHash))
    if (!own) return false
    // A vote that replaces this auditor's own standing report with another verdict must come from a newer audit than
    // the one behind that report (its own time where the ledger knows it, else the report's block time): an older audit
    // (an earlier run submitted by hand, say) never overwrites a newer verdict of the same auditor.
    if (own.verdict !== candidate.verdict) {
      // On the planner's clock: the earliest request of each audit, on this auditor's clock, against the audit behind
      // the report as this auditor's ledger records it. Where the ledger does not know that audit (a report sent from
      // another data dir), the report's block time stands in: a correction whose requests began before that block is
      // then held, which gives up sending a correction made before the earlier report was mined.
      const reported = await input.reportedAuditTime?.(own, candidate)
      const mine = candidate.firstRequestAt ?? candidate.auditedAt
      if (reported != null) return mine > reported ? false : 'superseded'
      return mine > await input.reader.blockTimestamp(own.blockNumber) ? false : 'superseded'
    }
    const [round, status] = await Promise.all([
      input.reader.reportRound(candidate.agentId, candidate.serviceHash),
      input.reader.serviceStatusByHash(candidate.agentId, candidate.serviceHash),
    ])
    if (own.round >= round) return true
    if (normalized(status.modelHash) === normalized(input.modelHash)
      && status.verdict === candidate.verdict && status.epoch === input.epoch) return true
    if (await input.reader.revocationsAfter(own.blockNumber, own.logIndex) >= round - own.round) return false
    return candidate.auditedAt <= await input.reader.blockTimestamp(own.blockNumber)
  })
}

/**
 * Builds the filter `prepareModelAudits` takes from this epoch's `ServiceAudited` events
 * (`loadEpochAuditEvents`), reading the rest from the contract only when a result needs it.
 */
export function alreadyOnChainFilter(input: {
  events: readonly ServiceAuditedEvent[]
  auditor: string
  epoch: bigint
  reader: Pick<SubmissionDeltaReader, 'reportRound' | 'serviceStatusByHash' | 'blockTimestamp'>
  /** Every `AuditorSet` change since the contract's deployment, in block order; read once, when needed. */
  auditorSetEvents(): Promise<readonly AuditorSetEvent[]>
  reportedAuditTime?: (own: OwnReport, candidate: SubmissionCandidate) => Promise<number | null>
}): (modelHash: string, candidates: readonly SubmissionCandidate[]) => Promise<AlreadyOnChain[]> {
  const own = ownLatestReports(input.events, input.auditor)
  let revocations: Promise<Array<{ blockNumber: number; logIndex: number }>> | null = null
  const timestamps = new Map<number, Promise<number>>()
  const reader: SubmissionDeltaReader = {
    reportRound: (agentId, service) => input.reader.reportRound(agentId, service),
    serviceStatusByHash: (agentId, service) => input.reader.serviceStatusByHash(agentId, service),
    blockTimestamp: (blockNumber) => {
      let timestamp = timestamps.get(blockNumber)
      if (!timestamp) {
        timestamp = input.reader.blockTimestamp(blockNumber)
        timestamps.set(blockNumber, timestamp)
      }
      return timestamp
    },
    revocationsAfter: async (blockNumber, logIndex) => {
      revocations ??= input.auditorSetEvents().then(revocationPositions)
      return (await revocations).filter((entry) => (
        entry.blockNumber > blockNumber || (entry.blockNumber === blockNumber && entry.logIndex > logIndex)
      )).length
    },
  }
  return (modelHash, candidates) => resultsAlreadyOnChain({
    candidates, modelHash, epoch: input.epoch, own, reader, ...(input.reportedAuditTime ? { reportedAuditTime: input.reportedAuditTime } : {}),
  })
}

/** Where the contract counted an auditor revocation: an approved auditor set to unapproved. */
export function revocationPositions(events: readonly AuditorSetEvent[]): Array<{ blockNumber: number; logIndex: number }> {
  const approved = new Set<string>()
  const positions: Array<{ blockNumber: number; logIndex: number }> = []
  for (const event of events) {
    const auditor = normalized(event.auditor)
    if (event.approved) {
      approved.add(auditor)
    } else if (approved.delete(auditor)) {
      positions.push({ blockNumber: event.blockNumber, logIndex: event.logIndex })
    }
  }
  return positions
}
