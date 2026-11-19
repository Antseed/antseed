import { readingsOfSummary, verdictOf } from './audit-checks.js'
import { confirmationUndecidedReason } from './outcome-reason.js'
import {
  KBF_AUDIT_VERIFY_OPTIONS,
  KBF_EXTENSION_RULE,
  KBF_EXTENSION_RULE_V1,
  classifyKbfFirstLook,
  computeKbfPooledVerdict,
  kbfExtensionRuleById,
  type FingerprintStats,
  type KbfExtensionRule,
  type KbfPooledVerdictResult,
} from '@antseed/fingerprints'
import type { ModelVerificationExtensionV1, ModelVerificationTargetResult } from './model-run.js'

/**
 * Close calls (`kbf-extension-v1` / `-v2`, not part of the KBF reference code): a first audit whose
 * p-value is neither clearly small nor clearly large gets extra sets of never-seen questions (one
 * under v1, up to two under v2) and is decided on all sets pooled. These helpers are shared by the
 * run, the epoch plan, the overview and submission, so they all agree on what is still waiting for
 * its extra questions.
 */
export type CloseCallRuleId = KbfExtensionRule['id']

/** The rule new close calls are decided by (`verifier.closeCallExtensions`, default 2). */
export const CLOSE_CALL_RULE_ID: CloseCallRuleId = KBF_EXTENSION_RULE.id

/** Rule for `verifier.closeCallExtensions`: 2 → v2, 1 → v1, 0 → none (single look). */
export function closeCallRuleForExtensions(count: number): KbfExtensionRule | null {
  if (count >= 2) return KBF_EXTENSION_RULE
  if (count === 1) return KBF_EXTENSION_RULE_V1
  return null
}

/** The close-call rule a first audit is decided by, or null for the single-look rule. */
export function closeCallRule(result: Pick<ModelVerificationTargetResult, 'decisionRule'>): KbfExtensionRule | null {
  return kbfExtensionRuleById(result.decisionRule)
}

/** Extra sets asked so far, oldest first. */
export function extensionSets(
  result: Pick<ModelVerificationTargetResult, 'extension' | 'extension2'>,
): ModelVerificationExtensionV1[] {
  return [result.extension, result.extension2].filter((set): set is ModelVerificationExtensionV1 => set !== undefined)
}

/** The latest extra set, whose `pooled` holds the look over every set so far. */
export function latestExtension(
  result: Pick<ModelVerificationTargetResult, 'extension' | 'extension2'>,
): ModelVerificationExtensionV1 | undefined {
  return result.extension2 ?? result.extension
}

/**
 * True when this close call still needs another extra set: its first audit is in the grey zone and
 * has none yet, or its latest pooled look is still a close call and the rule allows one more.
 */
export function needsExtension(result: Pick<ModelVerificationTargetResult,
  'decisionRule' | 'stats' | 'responseAuthVerified' | 'extension' | 'extension2' | 'outcomeReason' | 'closeCallClosed'> & { parsedProbeCount?: number }): boolean {
  const rule = closeCallRule(result)
  if (!rule || !result.stats) return false
  // A flagged audit whose extra set could not be asked in its run: its questions read as undecided.
  if (result.closeCallClosed) return false
  // A set whose ResponseAuth failed, or a seller that refuses the request profile (temperature), is
  // UNDETERMINED whatever its p-value; extra questions do not fix that.
  if (result.responseAuthVerified === false || result.outcomeReason?.code === 'request_profile_incompatible') return false
  // A confirmation whose check to repeat did not decide is audited again whole; its questions are not extended.
  if (result.outcomeReason?.code === 'confirmation_undecided') return false
  const sets = extensionSets(result)
  if (sets.length === 0) {
    return classifyKbfFirstLook(result.stats, { minCoverage: KBF_AUDIT_VERIFY_OPTIONS.minCoverage, rule }) === 'extend'
  }
  const latest = sets[sets.length - 1]!
  return latest.pooled.extendNext === true && sets.length < rule.maxExtensions
}

/**
 * The audit's verdict: the pooled verdict after a close call, else the first audit's own verdict.
 * Null while a close call waits for extra questions.
 */
/** The questions' own verdict, after any close call; null while a close call waits for an extra set. */
export function stageOneVerdict(result: ModelVerificationTargetResult): 'SAME' | 'DIFF' | 'UNDETERMINED' | null {
  const questions = questionsView(result)
  if (needsExtension(questions)) return null
  if (result.closeCallClosed) return 'UNDETERMINED'
  const latest = latestExtension(result)
  if (latest) return latest.pooled.verdict
  return questions.status
}

/** A result as the questions alone see it: their own verdict and outcome reason. */
function questionsView(result: ModelVerificationTargetResult): ModelVerificationTargetResult {
  return {
    ...result,
    status: result.questionsStatus ?? result.status,
    outcomeReason: result.questionsOutcomeReason !== undefined ? result.questionsOutcomeReason : (result.outcomeReason ?? null),
  }
}

/**
 * Sets an audit's verdict over every test from the questions' own verdict and the test records (`verdictOf`, rule
 * `all-tests-v1`). Only the questions' fields and the records are read, so it gives the same answer whenever it is
 * called again: after the close-call rule is attached (`run.ts`), and after an extra set is pooled. While a close call
 * waits, `status` holds the verdict so far and a confirmation of the questions waits with it.
 */
export function settleAuditVerdict<T extends ModelVerificationTargetResult>(result: T): T {
  const questions = questionsView(result)
  const pending = needsExtension(questions)
  const latest = latestExtension(result)
  const questionsStatus = result.closeCallClosed ? 'UNDETERMINED' as const
    : !pending && latest ? latest.pooled.verdict : questions.status
  const audit = verdictOf(readingsOfSummary({ ...result, questionsStatus }), questionsStatus, result.confirming, { questionsPending: pending })
  const questionsOutcome = questions.outcomeReason ?? null
  return {
    ...result,
    status: audit.verdict,
    questionsStatus,
    questionsOutcomeReason: questionsOutcome,
    outcomeReason: audit.undecidedConfirmation ? confirmationUndecidedReason(audit.undecidedConfirmation, 0) : questionsOutcome,
  }
}

export function pooledCloseCallVerdict(
  first: { stats: FingerprintStats; probeCount: number },
  extensions: ReadonlyArray<{ stats: FingerprintStats; probeCount: number }>,
  rule: KbfExtensionRule = KBF_EXTENSION_RULE,
): KbfPooledVerdictResult {
  return computeKbfPooledVerdict({
    first,
    extensions,
    minCoverage: KBF_AUDIT_VERIFY_OPTIONS.minCoverage,
    minDiffCoverage: KBF_AUDIT_VERIFY_OPTIONS.minDiffCoverage,
    rule,
  })
}
