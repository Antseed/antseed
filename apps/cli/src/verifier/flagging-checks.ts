import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'

/**
 * The checks of a seller audit that can end in DIFF, by the name a DIFF is attributed to. A DIFF is
 * recorded on chain only when a second auditor's check of the same name flags the seller too, on its
 * own fresh material (`same-check.ts`).
 */
export type AuditCheckId = 'tokens' | 'output-cap' | 'output-echo' | 'output-offset' | 'kbf'

export const AUDIT_CHECK_IDS: readonly AuditCheckId[] = Object.freeze(['tokens', 'output-cap', 'output-echo', 'output-offset', 'kbf'])

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
 * Empty when nothing flagged.
 */
export function flaggingChecks(
  evidence: Pick<ProxyAuditEvidenceV1, 'tokenizerPrecheck' | 'outputCap' | 'outputEcho' | 'exchanges'>,
  kbfVerdict: 'SAME' | 'DIFF' | 'UNDETERMINED' | null,
): AuditCheckId[] {
  const checks: AuditCheckId[] = []
  if (evidence.tokenizerPrecheck?.outcome === 'mismatch') checks.push('tokens')
  if (evidence.outputCap?.outcome === 'flag') checks.push('output-cap')
  if (evidence.outputEcho?.growth?.outcome === 'flag') checks.push('output-echo')
  if (evidence.outputEcho?.fixedAmount?.outcome === 'flag') checks.push('output-offset')
  if (evidence.exchanges.length > 0 && kbfVerdict === 'DIFF') checks.push('kbf')
  return checks
}

/**
 * The checks that ran to a pass in one audit: the pre-check matched, the cap check passed, the questions
 * were asked and say SAME. A confirmer's SAME counts only when a check that flagged first passed here.
 */
export function passedChecks(
  evidence: Pick<ProxyAuditEvidenceV1, 'tokenizerPrecheck' | 'outputCap' | 'outputEcho' | 'exchanges'>,
  kbfVerdict: 'SAME' | 'DIFF' | 'UNDETERMINED' | null,
): AuditCheckId[] {
  const checks: AuditCheckId[] = []
  if (evidence.tokenizerPrecheck?.outcome === 'match') checks.push('tokens')
  if (evidence.outputCap?.outcome === 'pass') checks.push('output-cap')
  // Each finding passes on its own: a seller that only failed to be a candidate has not passed.
  if (evidence.outputEcho?.growth?.outcome === 'pass') checks.push('output-echo')
  if (evidence.outputEcho?.fixedAmount?.outcome === 'pass') checks.push('output-offset')
  if (evidence.exchanges.length > 0 && kbfVerdict === 'SAME') checks.push('kbf')
  return checks
}

/** The checks an audit's summary shows decided (flagged or passed), for the planner, which has no evidence at hand. */
export function decidedChecks(result: {
  status: string
  parsedProbeCount?: number
  tokenizerPrecheck?: { outcome: string }
  outputCap?: { outcome: string }
  outputEcho?: { growth?: string; fixedAmount?: string }
}): AuditCheckId[] {
  const checks: AuditCheckId[] = []
  if (result.tokenizerPrecheck?.outcome === 'match' || result.tokenizerPrecheck?.outcome === 'mismatch') checks.push('tokens')
  if (result.outputCap?.outcome === 'pass' || result.outputCap?.outcome === 'flag') checks.push('output-cap')
  if (result.outputEcho?.growth === 'pass' || result.outputEcho?.growth === 'flag') checks.push('output-echo')
  if (result.outputEcho?.fixedAmount === 'pass' || result.outputEcho?.fixedAmount === 'flag') checks.push('output-offset')
  if ((result.parsedProbeCount ?? 0) > 0 && (result.status === 'SAME' || result.status === 'DIFF')) checks.push('kbf')
  return checks
}

/** A plain name for people, as in a verdict reason. */
export function describeAuditCheck(check: AuditCheckId): string {
  switch (check) {
    case 'tokens': return 'the token-count pre-check'
    case 'output-cap': return 'the cap check'
    case 'output-echo': return 'the echo check'
    case 'output-offset': return 'the echo check\'s fixed amount'
    case 'kbf': return 'the questions'
  }
}
