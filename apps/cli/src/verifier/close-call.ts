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
  'decisionRule' | 'stats' | 'responseAuthVerified' | 'extension' | 'extension2'>): boolean {
  const rule = closeCallRule(result)
  if (!rule || !result.stats) return false
  // A set whose ResponseAuth failed is UNDETERMINED whatever its p-value; extra questions do not fix that.
  if (result.responseAuthVerified === false) return false
  const sets = extensionSets(result)
  if (sets.length === 0) {
    return classifyKbfFirstLook(result.stats, { minCoverage: KBF_AUDIT_VERIFY_OPTIONS.minCoverage, rule }) === 'extend'
  }
  const latest = sets[sets.length - 1]!
  return latest.pooled.extendNext === true && sets.length < rule.maxExtensions
}

/**
 * Stage-1 verdict, before any DIFF recheck: the pooled verdict after a close call, else the first
 * audit's own verdict. Null while a close call waits for extra questions. A rechecked result had a
 * stage-1 DIFF (its `status` then holds the final verdict).
 */
export function stageOneVerdict(result: ModelVerificationTargetResult): 'SAME' | 'DIFF' | 'UNDETERMINED' | null {
  if (needsExtension(result)) return null
  const latest = latestExtension(result)
  if (latest) return latest.pooled.verdict
  if (result.recheck) return 'DIFF'
  return result.status
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
