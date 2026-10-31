import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { BANK_EXHAUSTED } from './probe-bank.js'
import { addAuditCostSummaries, emptyAuditCostSummary, type AuditCostSummaryV1 } from './proxy-evidence.js'
import { RECHECK_ENROLLMENT_ROUNDS } from './diff-recheck.js'
import { CLOSE_CALL_RULE_ID, needsExtension, pooledCloseCallVerdict } from './close-call.js'
import type {
  ModelVerificationSkip,
  ModelVerificationTargetResult,
} from './model-run.js'
import { asError } from './utils.js'

export interface ExtensionRoundStats {
  extended: number
  same: number
  diff: number
  undetermined: number
  /** Close calls whose extension could not run; kept to extend in a later run of the same epoch. */
  pending: number
  cost: AuditCostSummaryV1
}

export interface ExtensionRoundOutcome {
  results: ModelVerificationTargetResult[]
  stats: ExtensionRoundStats
}

/**
 * A close-call first audit (`kbf-extension-v1`: 0.005 <= p < 0.20 with enough answers) is asked one
 * extra set of never-seen probes of the same size, and decided on both sets pooled at 0.05. A pooled
 * DIFF then goes on to the DIFF recheck like any other DIFF. When the extension cannot run (no fresh
 * questions, reference endpoint down, seller skipped), the first audit is kept with
 * `extensionPending`: nothing is submitted for it, and the next run in the same epoch extends it.
 * A close call carried over from an earlier run is extended the same way.
 */
export async function runExtensionRounds(input: {
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
}): Promise<ExtensionRoundOutcome> {
  const stats: ExtensionRoundStats = {
    extended: 0, same: 0, diff: 0, undetermined: 0, pending: 0, cost: emptyAuditCostSummary(),
  }
  const closeCalls = input.results.filter((result) => !result.extension && !result.recheck && needsExtension(result))
  if (closeCalls.length === 0) return { results: [...input.results], stats }

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
  let exhausted = await reserveAll(closeCalls)
  if (exhausted.length > 0) {
    if (input.enroll) {
      for (let round = 1; round <= RECHECK_ENROLLMENT_ROUNDS && exhausted.length > 0; round += 1) {
        input.log(
          `${exhausted.length} close call(s) need fresh questions; enrolling (round ${round}/${RECHECK_ENROLLMENT_ROUNDS})`,
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
        skipReasons.set(first, 'no fresh questions left and enrollment is off (--no-enroll)')
      }
    }
  }

  const finals = new Map<ModelVerificationTargetResult, ModelVerificationTargetResult>()
  const keepPending = (first: ModelVerificationTargetResult, label: string, reason: string): void => {
    stats.pending += 1
    input.log(`extra questions could not run ${label}: ${reason} → close call kept, not submitted; the next run this epoch extends it`)
    finals.set(first, {
      ...first,
      extensionPending: { reason, since: first.extensionPending?.since ?? new Date().toISOString() },
    })
  }
  await input.concurrency(closeCalls.map((first) => async () => {
    const label = `${first.peerId.slice(0, 12)}… (${first.service})`
    const reservation = reservations.get(first)
    if (!reservation) {
      keepPending(first, label, skipReasons.get(first) ?? 'no extra questions')
      return
    }
    const p = first.stats?.pValueBinomial
    input.log(
      `close call ${label} (p=${p === null || p === undefined ? '?' : p.toFixed(4)}): `
      + `asking ${reservation.reference.probes.length} more fresh questions…`,
    )
    let extension: ModelVerificationTargetResult | ModelVerificationSkip
    try {
      extension = await input.verify(first, reservation.reference, reservation.auditId)
    } catch (error) {
      keepPending(first, label, `extension failed: ${asError(error).message}`)
      return
    }
    if (extension.status === 'SKIPPED') {
      keepPending(first, label, `extension skipped: ${extension.reason}`)
      return
    }
    stats.extended += 1
    stats.cost = addAuditCostSummaries(stats.cost, extension.cost)
    const final = combineExtension(first, extension, reservation.reference.referenceId)
    if (final.status === 'SAME') stats.same += 1
    else if (final.status === 'DIFF') stats.diff += 1
    else stats.undetermined += 1
    const pooledP = final.extension!.pooled.pValueBinomial
    input.log(
      `  ${label} pooled ${final.extension!.pooled.targetHamming}/${final.extension!.pooled.targetTotal} wrong, `
      + `p=${pooledP === null ? '?' : pooledP.toFixed(4)} → ${final.status}${final.status === 'DIFF' ? ' (goes to the recheck)' : ''}`,
    )
    finals.set(first, final)
  }))

  return { results: input.results.map((result) => finals.get(result) ?? result), stats }
}

export function combineExtension(
  first: ModelVerificationTargetResult,
  extension: ModelVerificationTargetResult,
  referenceId: string,
): ModelVerificationTargetResult {
  if (!first.stats || !extension.stats) throw new Error('a close-call extension needs the stats of both sets')
  const { extensionPending: _pending, ...firstAudit } = first
  const pooled = pooledCloseCallVerdict(
    { stats: first.stats, probeCount: first.probeCount },
    { stats: extension.stats, probeCount: extension.probeCount },
  )
  if (pooled.verdict === 'UNKNOWN') throw new Error(pooled.verdictReason ?? 'pooled verdict is UNKNOWN')
  // A set whose successful batches lacked verified ResponseAuth cannot count towards a verdict.
  const verdict = extension.responseAuthVerified === false ? 'UNDETERMINED' : pooled.verdict
  return {
    ...firstAudit,
    status: verdict,
    outcomeReason: verdict === 'UNDETERMINED' ? (extension.outcomeReason ?? first.outcomeReason ?? null) : null,
    cumulativeCost: addAuditCostSummaries(first.cumulativeCost ?? first.cost, extension.cumulativeCost ?? extension.cost),
    extension: {
      rule: CLOSE_CALL_RULE_ID,
      auditId: extension.auditId,
      status: extension.status,
      referenceId,
      probeCount: extension.probeCount,
      parsedProbeCount: extension.parsedProbeCount,
      correctProbeCount: extension.correctProbeCount,
      responseAuthVerified: extension.responseAuthVerified !== false,
      cost: extension.cost,
      evidencePath: extension.evidencePath,
      evidenceHash: extension.evidenceHash,
      firstLook: { status: first.status, pValue: first.stats.pValueBinomial },
      pooled: { ...pooled.stats, verdict, verdictReason: pooled.verdictReason },
    },
  }
}
