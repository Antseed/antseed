import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { BANK_EXHAUSTED } from './probe-bank.js'
import { addAuditCostSummaries, emptyAuditCostSummary, type AuditCostSummaryV1 } from './proxy-evidence.js'
import type {
  ModelVerificationFailure,
  ModelVerificationSkip,
  ModelVerificationTargetResult,
} from './model-run.js'
import { asError } from './utils.js'

/** Fresh-probe enrollments a run may make for one model's rechecks. */
export const RECHECK_ENROLLMENT_ROUNDS = 3

export interface DiffRecheckStats {
  rechecked: number
  confirmed: number
  notConfirmed: number
  /** First DIFFs whose recheck could not run; kept to recheck in a later run of the same epoch. */
  pending: number
  cost: AuditCostSummaryV1
}

export interface DiffRecheckOutcome {
  results: ModelVerificationTargetResult[]
  failures: ModelVerificationFailure[]
  stats: DiffRecheckStats
}

/**
 * A first DIFF is rechecked on probes the seller has never seen. A seller is flagged DIFF only when
 * both checks say DIFF; a recheck SAME or UNDETERMINED makes it UNDETERMINED. When the second check
 * cannot run (no fresh questions, the reference endpoint fails, the recheck is skipped), the first
 * DIFF is kept with `recheckPending`: nothing is submitted for it, and the next run in the same
 * epoch rechecks it. A first DIFF carried over from an earlier run is rechecked the same way.
 */
export async function runDiffRechecks(input: {
  results: readonly ModelVerificationTargetResult[]
  reserve(first: ModelVerificationTargetResult): Promise<{ reference: KbfReferenceV1; auditId: string }>
  /** Adds fresh probes to the bank once; null when enrollment is not allowed for this run. */
  enroll: (() => Promise<void>) | null
  verify(
    first: ModelVerificationTargetResult,
    reference: KbfReferenceV1,
    auditId: string,
  ): Promise<ModelVerificationTargetResult | ModelVerificationSkip>
  concurrency(tasks: Array<() => Promise<void>>): Promise<void>
  log(message: string): void
}): Promise<DiffRecheckOutcome> {
  const stats: DiffRecheckStats = {
    rechecked: 0, confirmed: 0, notConfirmed: 0, pending: 0, cost: emptyAuditCostSummary(),
  }
  const diffs = input.results.filter((result) => result.status === 'DIFF' && !result.recheck)
  if (diffs.length === 0) return { results: [...input.results], failures: [], stats }

  const reservations = new Map<ModelVerificationTargetResult, { reference: KbfReferenceV1; auditId: string }>()
  const skipReasons = new Map<ModelVerificationTargetResult, string>()
  const reserveAll = async (targets: readonly ModelVerificationTargetResult[]): Promise<ModelVerificationTargetResult[]> => {
    const exhausted: ModelVerificationTargetResult[] = []
    for (const first of targets) {
      try {
        reservations.set(first, await input.reserve(first))
        skipReasons.delete(first)
      } catch (error) {
        const message = asError(error).message
        skipReasons.set(first, message)
        if (message.startsWith(BANK_EXHAUSTED)) exhausted.push(first)
      }
    }
    return exhausted
  }
  let exhausted = await reserveAll(diffs)
  if (exhausted.length > 0) {
    if (input.enroll) {
      // A fresh enrollment is powered on its own, but a seller's unseen probes can still fall just
      // short of the power a recheck needs; enroll again until they are enough or the limit is hit.
      for (let round = 1; round <= RECHECK_ENROLLMENT_ROUNDS && exhausted.length > 0; round += 1) {
        input.log(
          `${exhausted.length} DIFF recheck(s) need fresh questions; enrolling (round ${round}/${RECHECK_ENROLLMENT_ROUNDS})`,
        )
        try {
          await input.enroll()
        } catch (error) {
          const message = `enrollment failed: ${asError(error).message}`
          for (const first of exhausted) skipReasons.set(first, message)
          break
        }
        exhausted = await reserveAll(exhausted)
      }
    } else {
      for (const first of exhausted) {
        skipReasons.set(first, 'no fresh questions left and enrollment is off (use --enroll-if-needed)')
      }
    }
  }

  const finals = new Map<ModelVerificationTargetResult, ModelVerificationTargetResult>()
  const keepPending = (first: ModelVerificationTargetResult, label: string, reason: string): void => {
    stats.pending += 1
    input.log(`recheck could not run ${label}: ${reason} → DIFF kept, not submitted; the next run this epoch rechecks it`)
    finals.set(first, {
      ...first,
      recheckPending: { reason, since: first.recheckPending?.since ?? new Date().toISOString() },
    })
  }
  await input.concurrency(diffs.map((first) => async () => {
    const label = `${first.peerId.slice(0, 12)}… (${first.service})`
    const reservation = reservations.get(first)
    if (!reservation) {
      keepPending(first, label, skipReasons.get(first) ?? 'no recheck questions')
      return
    }
    input.log(`DIFF ${label}: rechecking with ${reservation.reference.probes.length} fresh questions…`)
    let recheck: ModelVerificationTargetResult | ModelVerificationSkip
    try {
      recheck = await input.verify(first, reservation.reference, reservation.auditId)
    } catch (error) {
      keepPending(first, label, `recheck failed: ${asError(error).message}`)
      return
    }
    if (recheck.status === 'SKIPPED') {
      keepPending(first, label, `recheck skipped: ${recheck.reason}`)
      return
    }
    stats.rechecked += 1
    stats.cost = addAuditCostSummaries(stats.cost, recheck.cost)
    const final = combineDiffRecheck(first, recheck, reservation.reference.referenceId)
    if (final.status === 'DIFF') {
      stats.confirmed += 1
      input.log(`  ${label} recheck ${recheck.status} → confirmed DIFF`)
    } else {
      stats.notConfirmed += 1
      input.log(`  ${label} recheck ${recheck.status} → not confirmed, submitting UNDETERMINED`)
    }
    finals.set(first, final)
  }))

  const results = input.results.map((result) => finals.get(result) ?? result)
  return { results, failures: [], stats }
}

export function combineDiffRecheck(
  first: ModelVerificationTargetResult,
  recheck: ModelVerificationTargetResult,
  referenceId: string,
): ModelVerificationTargetResult {
  if (first.status !== 'DIFF') throw new Error('only a DIFF is rechecked')
  const { recheckPending: _pending, ...firstCheck } = first
  return {
    ...firstCheck,
    status: confirmedDiffStatus(recheck.status),
    cumulativeCost: addAuditCostSummaries(first.cumulativeCost ?? first.cost, recheck.cumulativeCost ?? recheck.cost),
    recheck: {
      auditId: recheck.auditId,
      status: recheck.status,
      referenceId,
      probeCount: recheck.probeCount,
      parsedProbeCount: recheck.parsedProbeCount,
      correctProbeCount: recheck.correctProbeCount,
      cost: recheck.cost,
      evidencePath: recheck.evidencePath,
      evidenceHash: recheck.evidenceHash,
    },
  }
}

/** The final verdict after a first DIFF: DIFF only when the recheck is DIFF too. */
export function confirmedDiffStatus(recheckStatus: string): 'DIFF' | 'UNDETERMINED' {
  return recheckStatus === 'DIFF' ? 'DIFF' : 'UNDETERMINED'
}
