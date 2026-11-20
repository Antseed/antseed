import type { AuditorSetEvent, ServiceAuditedEvent, VerifierVerdict } from '@antseed/node/payments'
import { mapConcurrently } from './audit-concurrency.js'
import { ownLatestReports, reportKey, type OwnReport } from './pending-confirmations.js'
import { normalized } from './utils.js'

/** One seller result `verifier submit` could send for a model. */
export interface SubmissionCandidate {
  agentId: bigint
  serviceHash: string
  verdict: VerifierVerdict
  /** Unix seconds the audit behind this result was made (its latest evidence file). */
  auditedAt: number
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
 */
export async function resultsAlreadyOnChain(input: {
  candidates: readonly SubmissionCandidate[]
  modelHash: string
  epoch: bigint
  /** This auditor's latest reports this epoch (`ownLatestReports`). */
  own: ReadonlyMap<string, OwnReport>
  reader: SubmissionDeltaReader
}): Promise<boolean[]> {
  return mapConcurrently(input.candidates, READ_CONCURRENCY, async (candidate) => {
    const own = input.own.get(reportKey(candidate.agentId, candidate.serviceHash, input.modelHash))
    if (!own || own.verdict !== candidate.verdict) return false
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
}): (modelHash: string, candidates: readonly SubmissionCandidate[]) => Promise<boolean[]> {
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
  return (modelHash, candidates) => resultsAlreadyOnChain({ candidates, modelHash, epoch: input.epoch, own, reader })
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
