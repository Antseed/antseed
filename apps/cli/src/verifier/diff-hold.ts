import { VERIFIER_VERDICT, type VerifierVerdict } from '@antseed/node/payments'
import { mapConcurrently } from './audit-concurrency.js'
import type { SubmissionCandidate } from './submission-delta.js'

/**
 * The DIFF hold: once a DIFF is recorded for a seller's service, the service is not audited in the
 * next `verifier.diffHoldEpochs` epochs (default 1), so no SAME or UNDETERMINED can clear the DIFF
 * before then. The contract lets a single later report replace a live DIFF (`diffReplacementReports`
 * is 1), so the CLI holds it: `verifier run` does not plan the seller (except to confirm another
 * auditor's repeat DIFF), and `verifier submit` leaves out any SAME or UNDETERMINED for the service
 * it still has. A repeat DIFF clears nothing, so it is sent. A DIFF recorded in epoch N therefore
 * counts through N+1, and the seller is audited again in N+2. A DIFF recorded in the current epoch is not held here;
 * the third-opinion rule (`third-opinion.ts`) already keeps other auditors off it this epoch.
 *
 * The hold reads the service's stored verdict, whatever model it was recorded under, so a seller
 * cannot clear it by advertising another model on the same service. An owner clear removes the
 * stored DIFF and with it the hold. Every auditor must use the same value: it is one of the rules
 * pinned by verifier compat (`verifierRuleOverrides`).
 */
export const DIFF_HOLD_EPOCHS = 1

/** The part of a service's on-chain status the hold reads (`VerifierClient.serviceStatusByHash`). */
export interface DiffHoldStatus {
  verdict: VerifierVerdict
  /** The epoch the stored verdict was recorded in; 0 when there is none. */
  epoch: bigint
}

export interface DiffHoldReader {
  serviceStatusByHash(agentId: bigint, serviceHash: string): Promise<DiffHoldStatus>
}

/** The first epoch a DIFF recorded in `diffEpoch` is audited again. */
export function diffHoldEndsAt(diffEpoch: bigint, holdEpochs: number): bigint {
  return diffEpoch + BigInt(holdEpochs) + 1n
}

/**
 * Why the service is held in `epoch`, or null when it may be audited: its stored verdict is a DIFF
 * recorded in one of the `holdEpochs` epochs before `epoch`.
 */
export function diffHoldReason(status: DiffHoldStatus, epoch: bigint, holdEpochs: number): string | null {
  if (holdEpochs <= 0 || status.verdict !== VERIFIER_VERDICT.DIFF) return null
  if (epoch <= status.epoch || epoch >= diffHoldEndsAt(status.epoch, holdEpochs)) return null
  return `its DIFF from epoch ${status.epoch} stands until epoch ${diffHoldEndsAt(status.epoch, holdEpochs)}, `
    + 'so the seller is not audited or cleared before then'
}

/**
 * Why a result for the service is not sent in `epoch`, or null when it is: a DIFF result never is
 * held, since it cannot clear the stored DIFF; any other result is held by `diffHoldReason`.
 */
export function diffHoldResultReason(status: DiffHoldStatus, epoch: bigint, holdEpochs: number, result: VerifierVerdict): string | null {
  return result === VERIFIER_VERDICT.DIFF ? null : diffHoldReason(status, epoch, holdEpochs)
}

const READ_CONCURRENCY = 8

export interface DiffHolds {
  /** Why (agent, service) is held this epoch, or null. Each pair is read once; a failed read is retried on the next call. */
  reasonFor(agentId: bigint, serviceHash: string): Promise<string | null>
  /** One reason or null per entry, at most 8 reads at a time; an entry without an agent id is never held. */
  reasonsFor(entries: ReadonlyArray<{ agentId: bigint | null; serviceHash: string }>): Promise<Array<string | null>>
  /** The filter `prepareModelAudits` takes: one reason or null per candidate. A DIFF result is never held (`diffHoldResultReason`). */
  filter(modelHash: string, candidates: readonly SubmissionCandidate[]): Promise<Array<string | null>>
}

/** Reads the hold of each (agent, service) from the contract, once per pair. With `holdEpochs` 0 nothing is read. */
export function diffHolds(input: { epoch: bigint; holdEpochs: number; reader: DiffHoldReader }): DiffHolds {
  const reasons = new Map<string, Promise<string | null>>()
  const reasonFor = (agentId: bigint, serviceHash: string): Promise<string | null> => {
    if (input.holdEpochs <= 0) return Promise.resolve(null)
    const key = `${agentId}:${serviceHash.toLowerCase()}`
    let reason = reasons.get(key)
    if (!reason) {
      reason = input.reader.serviceStatusByHash(agentId, serviceHash)
        .then((status) => diffHoldReason(status, input.epoch, input.holdEpochs))
      reasons.set(key, reason)
      reason.catch(() => reasons.delete(key))
    }
    return reason
  }
  const reasonsFor: DiffHolds['reasonsFor'] = (entries) => mapConcurrently(
    entries, READ_CONCURRENCY, (entry) => entry.agentId === null ? Promise.resolve(null) : reasonFor(entry.agentId, entry.serviceHash),
  )
  return {
    reasonFor,
    reasonsFor,
    // A DIFF result is never held, so its hold is not read (an entry without an agent id is never held).
    filter: (_modelHash, candidates) => reasonsFor(candidates.map((candidate) => (
      candidate.verdict === VERIFIER_VERDICT.DIFF ? { agentId: null, serviceHash: candidate.serviceHash } : candidate
    ))),
  }
}
