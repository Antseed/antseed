import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { addAuditCostSummaries, emptyAuditCostSummary, type AuditCostSummaryV1 } from './proxy-evidence.js'
import { auditDecision, closeCallRule, extensionSets, latestExtension, pooledCloseCallVerdict, settleAuditVerdict } from './close-call.js'
import { readingsOfSummary } from './audit-checks.js'
import type {
  ModelVerificationExtensionV1,
  ModelVerificationSkip,
  ModelVerificationTargetResult,
} from './model-run.js'
import { asError } from './utils.js'

export interface ExtensionRoundStats {
  extended: number
  same: number
  diff: number
  undetermined: number
  /** Close calls still in the grey zone after an extra set, asked one more set. */
  continued: number
  /** Close calls whose extension could not run; kept to extend in a later run of the same epoch. */
  pending: number
  cost: AuditCostSummaryV1
}

export interface ExtensionRoundOutcome {
  results: ModelVerificationTargetResult[]
  stats: ExtensionRoundStats
}

/**
 * A close-call first audit (0.005 <= p < 0.20 with enough answers) is asked the epoch question
 * set's next extra set (the same for every seller, as large as the first) and decided on the sets pooled. Under `kbf-extension-v2` a
 * pooled look that is still a close call gets one more set (at most two extra sets), and the last
 * look is decided at 0.05; under `kbf-extension-v1` the single extra set is decided at 0.05. A pooled
 * DIFF is submitted like any other DIFF, for another auditor to confirm. When an extra set cannot run (the set has
 * none, seller skipped), the result is kept with `extensionPending`: the next run of the model's open
 * audit window continues it, and once the window closes it is submitted as UNDETERMINED. A close
 * call carried over from an earlier run is extended the same way.
 */

export async function runExtensionRounds(input: {
  results: readonly ModelVerificationTargetResult[]
  reserve(first: ModelVerificationTargetResult): Promise<{ reference: KbfReferenceV1; auditId: string }>
  verify(
    first: ModelVerificationTargetResult,
    reference: KbfReferenceV1,
    auditId: string,
  ): Promise<ModelVerificationTargetResult | ModelVerificationSkip>
  concurrency(tasks: Array<() => Promise<void>>): Promise<void>
  log(message: string): void
}): Promise<ExtensionRoundOutcome> {
  const stats: ExtensionRoundStats = {
    extended: 0, same: 0, diff: 0, undetermined: 0, continued: 0, pending: 0, cost: emptyAuditCostSummary(),
  }
  let results = [...input.results]
  // One pass per extra set: a pass extends every close call that still needs a set (including ones
  // carried over as pending from an earlier run), and the next pass picks up those whose pooled look
  // is still a close call. A close call whose set could not run in this run waits for the next run.
  const pendingThisRun = new Set<string>()
  for (let pass = 1; pass <= MAX_EXTENSION_PASSES; pass += 1) {
    const closeCalls = results.filter((result) => !pendingThisRun.has(result.auditId) && auditDecision(result).pending)
    if (closeCalls.length === 0) break
    const finals = await runExtensionPass(input, closeCalls, stats)
    for (const final of finals.values()) if (final.extensionPending) pendingThisRun.add(final.auditId)
    results = results.map((result) => finals.get(result) ?? result)
  }
  return { results, stats }
}

/** The most extra sets any close-call rule allows. */
const MAX_EXTENSION_PASSES = 2

type ExtensionRoundInput = Parameters<typeof runExtensionRounds>[0]

async function runExtensionPass(
  input: ExtensionRoundInput,
  closeCalls: readonly ModelVerificationTargetResult[],
  stats: ExtensionRoundStats,
): Promise<Map<ModelVerificationTargetResult, ModelVerificationTargetResult>> {
  const reservations = new Map<ModelVerificationTargetResult, { reference: KbfReferenceV1; auditId: string }>()
  const skipReasons = new Map<ModelVerificationTargetResult, string>()
  for (const first of closeCalls) {
    try {
      reservations.set(first, await input.reserve(first))
    } catch (error) {
      skipReasons.set(first, asError(error).message)
    }
  }

  const finals = new Map<ModelVerificationTargetResult, ModelVerificationTargetResult>()
  const keepPending = (first: ModelVerificationTargetResult, label: string, reason: string): void => {
    // A flagged result never waits across runs: its questions read as undecided and its DIFF goes out with the
    // other flags now. Only a close call with no flag beside it waits for a later run.
    if (hasTestFlag(first)) {
      input.log(`extra questions could not run ${label}: ${reason} → another test flagged, so the questions stay undecided and the DIFF goes out now`)
      finals.set(first, settleAuditVerdict({ ...first, extensionPending: undefined, closeCallClosed: { reason } }))
      return
    }
    stats.pending += 1
    input.log(`extra questions could not run ${label}: ${reason} → close call kept; the next run of its audit window extends it, or it is submitted UNDETERMINED when the window closes`)
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
    const p = latestExtension(first)?.pooled.pValueBinomial ?? first.stats?.pValueBinomial
    input.log(
      `close call ${label} (p=${p === null || p === undefined ? '?' : p.toFixed(4)}, extra set ${extensionSets(first).length + 1}): `
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
    const pooled = latestExtension(final)!.pooled
    const setCount = extensionSets(final).length
    if (pooled.extendNext) stats.continued += 1
    else if (final.status === 'SAME') stats.same += 1
    else if (final.status === 'DIFF') stats.diff += 1
    else stats.undetermined += 1
    const pooledP = pooled.pValueBinomial
    input.log(
      `  ${label} pooled over ${setCount + 1} sets: ${pooled.targetHamming}/${pooled.targetTotal} wrong, `
      + `p=${pooledP === null ? '?' : pooledP.toFixed(4)} → `
      + (pooled.extendNext ? 'still a close call; one more set decides' : `${final.status}${final.status === 'DIFF' ? ' (another auditor confirms it)' : ''}`),
    )
    finals.set(first, final)
  }))
  return finals
}

/**
 * Adds one extra set to a close call: the first extra set becomes `extension`, the second
 * `extension2`. The new set's `pooled` is the look over the first set and every extra set so far,
 * decided by the result's close-call rule.
 */
export function combineExtension(
  first: ModelVerificationTargetResult,
  extension: ModelVerificationTargetResult,
  referenceId: string,
): ModelVerificationTargetResult {
  if (!first.stats || !extension.stats) throw new Error('a close-call extension needs the stats of both sets')
  const rule = closeCallRule(first)
  if (!rule) throw new Error('a close-call extension needs a close-call decision rule')
  const earlier = extensionSets(first)
  if (earlier.length >= rule.maxExtensions) throw new Error(`${rule.id} allows at most ${rule.maxExtensions} extra set(s)`)
  const { extensionPending: _pending, ...firstAudit } = first
  const extraSets = [
    ...earlier.map((set) => ({ stats: set.stats, probeCount: set.probeCount })),
    { stats: extension.stats, probeCount: extension.probeCount },
  ]
  if (extraSets.some((set) => !set.stats)) throw new Error('an earlier extra set has no statistics')
  // Every set of a close call is decided by one coverage rule: the first set's.
  if (extension.coverageRule !== first.coverageRule) throw new Error('an extra set decided by another coverage rule than its first set')
  const pooled = pooledCloseCallVerdict(
    { stats: first.stats, probeCount: first.probeCount },
    extraSets as Array<{ stats: NonNullable<ModelVerificationTargetResult['stats']>; probeCount: number }>,
    rule,
    first.coverageRule,
  )
  if (pooled.verdict === 'UNKNOWN') throw new Error(pooled.verdictReason ?? 'pooled verdict is UNKNOWN')
  // A set whose successful batches lacked verified ResponseAuth cannot count towards a verdict, and
  // more questions do not fix that.
  const authFailed = extension.responseAuthVerified === false
  const verdict = authFailed ? 'UNDETERMINED' : pooled.verdict
  const extendNext = !authFailed && pooled.extend
  const record: ModelVerificationExtensionV1 = {
    rule: rule.id,
    auditId: extension.auditId,
    status: extension.status,
    referenceId,
    probeCount: extension.probeCount,
    parsedProbeCount: extension.parsedProbeCount,
    correctProbeCount: extension.correctProbeCount,
    responseAuthVerified: !authFailed,
    stats: extension.stats,
    cost: extension.cost,
    evidencePath: extension.evidencePath,
    evidenceHash: extension.evidenceHash,
    // Its own earliest request: a confirmation is fresh only by the earliest over every set it pools.
    ...(extension.firstRequestAt !== undefined ? { firstRequestAt: extension.firstRequestAt } : {}),
    firstLook: earlier[0]?.firstLook ?? { status: first.questionsStatus ?? first.status, pValue: first.stats.pValueBinomial },
    pooled: { ...pooled.stats, verdict, verdictReason: pooled.verdictReason, ...(extendNext ? { extendNext: true } : {}) },
  }
  // The pooled look is the questions' verdict; the audit's is settled from it and the first set's test records.
  const questionsOutcome = verdict === 'UNDETERMINED' && !extendNext
    ? (extension.questionsOutcomeReason ?? extension.outcomeReason ?? first.questionsOutcomeReason ?? first.outcomeReason ?? null) : null
  return settleAuditVerdict({
    ...firstAudit,
    status: verdict,
    questionsStatus: verdict,
    outcomeReason: questionsOutcome,
    questionsOutcomeReason: questionsOutcome,
    cumulativeCost: addAuditCostSummaries(first.cumulativeCost ?? first.cost, extension.cumulativeCost ?? extension.cost),
    ...(earlier.length === 0 ? { extension: record } : { extension2: record }),
  })
}

/** Whether a test other than the questions flagged this audit (its summary's test records). */
function hasTestFlag(result: ModelVerificationTargetResult): boolean {
  return readingsOfSummary(result).some((reading) => reading.check !== 'kbf' && reading.outcome === 'flag')
}
