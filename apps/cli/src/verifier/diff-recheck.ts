import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { BANK_EXHAUSTED } from './probe-bank.js'
import { failureOutcomeReason } from './outcome-reason.js'
import { addAuditCostSummaries, emptyAuditCostSummary, type AuditCostSummaryV1 } from './proxy-evidence.js'
import type {
  ModelVerificationFailure,
  ModelVerificationSkip,
  ModelVerificationTargetResult,
} from './model-run.js'
import { asError } from './utils.js'

export interface DiffRecheckStats {
  rechecked: number
  confirmed: number
  notConfirmed: number
  skipped: number
  cost: AuditCostSummaryV1
}

export interface DiffRecheckOutcome {
  results: ModelVerificationTargetResult[]
  failures: ModelVerificationFailure[]
  stats: DiffRecheckStats
}

/**
 * A first DIFF is rechecked on probes the seller has never seen. Only a recheck SAME overturns it
 * (DIFF then SAME becomes UNDETERMINED); a recheck DIFF or UNDETERMINED keeps the DIFF. When the
 * second check cannot run, the seller is reported as a failure so nothing is submitted for it.
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
    rechecked: 0, confirmed: 0, notConfirmed: 0, skipped: 0, cost: emptyAuditCostSummary(),
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
  const exhausted = await reserveAll(diffs)
  if (exhausted.length > 0) {
    if (input.enroll) {
      input.log(`${exhausted.length} DIFF recheck(s) need fresh questions; enrolling once`)
      try {
        await input.enroll()
        await reserveAll(exhausted)
      } catch (error) {
        const message = `enrollment failed: ${asError(error).message}`
        for (const first of exhausted) skipReasons.set(first, message)
      }
    } else {
      for (const first of exhausted) {
        skipReasons.set(first, 'no fresh questions left and enrollment is off (use --enroll-if-needed)')
      }
    }
  }

  const finals = new Map<ModelVerificationTargetResult, ModelVerificationTargetResult | ModelVerificationFailure>()
  await input.concurrency(diffs.map((first) => async () => {
    const label = `${first.peerId.slice(0, 12)}… (${first.service})`
    const reservation = reservations.get(first)
    if (!reservation) {
      stats.skipped += 1
      const reason = `DIFF not confirmed: recheck skipped, ${skipReasons.get(first) ?? 'no recheck questions'}`
      input.log(`recheck skipped ${label}: ${skipReasons.get(first)} → nothing submitted`)
      finals.set(first, recheckFailure(first, reason))
      return
    }
    input.log(`DIFF ${label}: rechecking with ${reservation.reference.probes.length} fresh questions…`)
    let recheck: ModelVerificationTargetResult | ModelVerificationSkip
    try {
      recheck = await input.verify(first, reservation.reference, reservation.auditId)
    } catch (error) {
      stats.skipped += 1
      input.log(`recheck failed ${label}: ${asError(error).message} → nothing submitted`)
      finals.set(first, recheckFailure(first, `DIFF not confirmed: recheck failed, ${asError(error).message}`))
      return
    }
    if (recheck.status === 'SKIPPED') {
      stats.skipped += 1
      input.log(`recheck skipped ${label}: ${recheck.reason} → nothing submitted`)
      finals.set(first, recheckFailure(first, `DIFF not confirmed: recheck skipped, ${recheck.reason}`))
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
      input.log(`  ${label} recheck SAME → not confirmed, submitting UNDETERMINED`)
    }
    finals.set(first, final)
  }))

  const results: ModelVerificationTargetResult[] = []
  const failures: ModelVerificationFailure[] = []
  for (const result of input.results) {
    const final = finals.get(result)
    if (!final) results.push(result)
    else if (final.status === 'FAILED') failures.push(final)
    else results.push(final)
  }
  return { results, failures, stats }
}

export function combineDiffRecheck(
  first: ModelVerificationTargetResult,
  recheck: ModelVerificationTargetResult,
  referenceId: string,
): ModelVerificationTargetResult {
  if (first.status !== 'DIFF') throw new Error('only a DIFF is rechecked')
  return {
    ...first,
    status: recheck.status === 'SAME' ? 'UNDETERMINED' : 'DIFF',
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

function recheckFailure(first: ModelVerificationTargetResult, reason: string): ModelVerificationFailure {
  return {
    peerId: first.peerId,
    displayName: first.displayName,
    agentId: first.agentId,
    service: first.service,
    status: 'FAILED',
    reason,
    outcomeReason: failureOutcomeReason(reason),
  }
}
