import {
  KBF_AUDIT_VERIFY_OPTIONS,
  KBF_EXTENSION_RULE,
  classifyKbfFirstLook,
  computeKbfPooledVerdict,
  type FingerprintStats,
  type KbfVerdictResult,
} from '@antseed/fingerprints'
import type { ModelVerificationTargetResult } from './model-run.js'

/**
 * Close calls (`kbf-extension-v1`, not part of the KBF reference code): a first audit whose p-value
 * is neither clearly small nor clearly large is decided on twice the questions. These helpers are
 * shared by the run, the epoch plan, the overview and submission, so they all agree on what is
 * still waiting for its extra questions.
 */
export const CLOSE_CALL_RULE_ID = KBF_EXTENSION_RULE.id

/** True when this first audit is decided by the close-call rule and its p-value is in the grey zone. */
export function needsExtension(result: Pick<ModelVerificationTargetResult,
  'decisionRule' | 'stats' | 'responseAuthVerified'>): boolean {
  if (result.decisionRule !== CLOSE_CALL_RULE_ID || !result.stats) return false
  // A set whose ResponseAuth failed is UNDETERMINED whatever its p-value; extra questions do not fix that.
  if (result.responseAuthVerified === false) return false
  return classifyKbfFirstLook(result.stats, { minCoverage: KBF_AUDIT_VERIFY_OPTIONS.minCoverage }) === 'extend'
}

/**
 * Stage-1 verdict, before any DIFF recheck: the pooled verdict after a close call, else the first
 * audit's own verdict. Null while a close call waits for its extra questions. A rechecked result
 * had a stage-1 DIFF (its `status` then holds the final verdict).
 */
export function stageOneVerdict(result: ModelVerificationTargetResult): 'SAME' | 'DIFF' | 'UNDETERMINED' | null {
  if (result.extension) return result.extension.pooled.verdict
  if (needsExtension(result)) return null
  if (result.recheck) return 'DIFF'
  return result.status
}

export function pooledCloseCallVerdict(
  first: { stats: FingerprintStats; probeCount: number },
  extension: { stats: FingerprintStats; probeCount: number },
): KbfVerdictResult {
  return computeKbfPooledVerdict({
    first,
    extension,
    minCoverage: KBF_AUDIT_VERIFY_OPTIONS.minCoverage,
    minDiffCoverage: KBF_AUDIT_VERIFY_OPTIONS.minDiffCoverage,
    rule: KBF_EXTENSION_RULE,
  })
}
