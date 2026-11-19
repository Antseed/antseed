import { checkLabel, checksWith, readingsOfEvidence, readingsOfSummary, type AuditCheckId } from './audit-checks.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'

export { AUDIT_CHECK_IDS, type AuditCheckId } from './audit-checks.js'

/**
 * The checks that flagged the seller in one audit, read from its evidence alone, so the auditor that
 * wrote it, a confirming auditor and any reader of the published evidence get the same answer.
 *
 * - `tokens`: the tokenizer pre-check found a mismatch.
 * - `output-cap`: the cap check flagged (`output-cap.ts`).
 * - `output-echo`, `output-offset`: the echo check flagged a growth or a fixed amount (`output-echo.ts`).
 * - `kbf`: questions were asked and the questions' verdict (after any close-call extra sets, which is
 *   what `kbfVerdict` must be) is DIFF.
 *
 * Empty when nothing flagged. In the order of `AUDIT_CHECK_IDS` (`audit-checks.ts`).
 */
export function flaggingChecks(
  evidence: Pick<ProxyAuditEvidenceV1, 'tokenizerPrecheck' | 'outputCap' | 'outputEcho' | 'exchanges'>,
  kbfVerdict: 'SAME' | 'DIFF' | 'UNDETERMINED' | null,
): AuditCheckId[] {
  return checksWith(readingsOfEvidence(evidence, kbfVerdict), 'flag')
}

/**
 * The checks that ran to a pass in one audit: the pre-check matched, the cap check passed, the questions
 * were asked and say SAME. A confirmer's SAME counts only when a check that flagged first passed here.
 * Each finding of the echo check passes on its own: a seller that only failed to be a candidate has not passed.
 */
export function passedChecks(
  evidence: Pick<ProxyAuditEvidenceV1, 'tokenizerPrecheck' | 'outputCap' | 'outputEcho' | 'exchanges'>,
  kbfVerdict: 'SAME' | 'DIFF' | 'UNDETERMINED' | null,
): AuditCheckId[] {
  return checksWith(readingsOfEvidence(evidence, kbfVerdict), 'pass')
}

/** The checks an audit's summary shows flagged, for the planner. */
export function flaggedSummaryChecks(result: Parameters<typeof decidedChecks>[0]): AuditCheckId[] {
  return checksWith(readingsOfSummary(result), 'flag')
}

/** The checks an audit's summary shows decided (flagged or passed), for the planner, which has no evidence at hand. */
export function decidedChecks(result: {
  status: string
  parsedProbeCount?: number
  tokenizerPrecheck?: { outcome: string }
  outputCap?: { outcome: string }
  outputEcho?: { growth?: string; fixedAmount?: string }
}): AuditCheckId[] {
  return checksWith(readingsOfSummary(result), 'flag', 'pass')
}

/**
 * What a finished local result decided, for `localResultAnswersConfirmation`: the checks it decided, or
 * `undecided-confirmation` for a confirmation that ran and did not decide. That is a result the epoch plan audits
 * again within its attempts (`confirmation_undecided`), or a confirmation (`confirmsDiff`) whose cell is done
 * UNDETERMINED: its attempts are used up, so it answers the target and the seller is not planned again in every run.
 */
export function localConfirmationDecision(
  result: Parameters<typeof decidedChecks>[0] & { outcomeReason?: { code?: string } | null; confirmsDiff?: boolean },
  done: boolean,
): AuditCheckId[] | 'undecided-confirmation' {
  if (result.outcomeReason?.code === 'confirmation_undecided') return 'undecided-confirmation'
  // Only a confirmation's own UNDETERMINED: a first look that overlapped the other auditor's flag answers nothing.
  if (done && result.status === 'UNDETERMINED' && result.confirmsDiff === true) return 'undecided-confirmation'
  return decidedChecks(result)
}

/** A plain name for people, as in a verdict reason. */
export function describeAuditCheck(check: AuditCheckId): string {
  return checkLabel(check)
}
