/**
 * KBF verdict computation: reference self-error CP upper bound plus a
 * one-sided binomial test on the target's mismatch count.
 */

import { isMatchVector, type FingerprintVerdict, type MatchVector } from '../../types.js';
import { binomialOneSidedPValue, clopperPearsonUpper } from './stats.js';

export interface KbfVerdictInput {
  /** Reference model's own mismatch count on this probe set. */
  selfHamming: number;
  /** Reference model's own probe count. */
  selfTotal: number;
  /** Target seller's match vector (1 match, 0 discrepancy, null unscored). */
  targetMatchVector: MatchVector;
  /** Below this scored fraction, the verdict is UNDETERMINED. Default 0.5. */
  minCoverage?: number;
  /**
   * A DIFF also needs at least this scored fraction; below it a would-be DIFF is
   * UNDETERMINED, so a seller cannot make a DIFF likelier by leaving answers out.
   * Default: `minCoverage` (no extra requirement).
   */
  minDiffCoverage?: number;
  /** Clopper-Pearson confidence for the self-error upper bound. Default 0.99. */
  cpConfidence?: number;
  /** One-sided binomial threshold for DIFF. Default 0.05. */
  alpha?: number;
}

export interface KbfVerdictStats {
  selfHamming: number;
  selfTotal: number;
  targetHamming: number | null;
  targetTotal: number | null;
  targetCoverage: number | null;
  p0Cp99: number | null;
  pValueBinomial: number | null;
}

export interface KbfVerdictResult {
  verdict: FingerprintVerdict;
  verdictReason: string | null;
  stats: KbfVerdictStats;
}

/**
 * Compute the KBF verdict:
 * - invalid reference self-test or empty match vector → UNKNOWN;
 * - fewer than `minCoverage` of the target's probes scored → UNDETERMINED;
 * - otherwise p0 = CP upper bound on the reference self-error rate and a
 *   one-sided binomial test of the target's mismatch count against p0:
 *   pValue < alpha → DIFF, else SAME.
 */
export function computeKbfVerdict(input: KbfVerdictInput): KbfVerdictResult {
  const { selfHamming, selfTotal, targetMatchVector } = input;
  const minCoverage = input.minCoverage ?? 0.5;
  const minDiffCoverage = Math.max(minCoverage, input.minDiffCoverage ?? minCoverage);
  const cpConfidence = input.cpConfidence ?? 0.99;
  const alpha = input.alpha ?? 0.05;

  const emptyStats: KbfVerdictStats = {
    selfHamming,
    selfTotal,
    targetHamming: null,
    targetTotal: null,
    targetCoverage: null,
    p0Cp99: null,
    pValueBinomial: null,
  };

  const selfInvalid =
    !Number.isInteger(selfHamming) ||
    !Number.isInteger(selfTotal) ||
    selfTotal <= 0 ||
    selfHamming < 0 ||
    selfHamming > selfTotal;
  if (selfInvalid) {
    return {
      verdict: 'UNKNOWN',
      verdictReason: `invalid reference self-test (hamming=${selfHamming}, total=${selfTotal})`,
      stats: emptyStats,
    };
  }
  if (targetMatchVector.length === 0) {
    return {
      verdict: 'UNKNOWN',
      verdictReason: 'empty target match vector',
      stats: emptyStats,
    };
  }
  // Runtime-validate at the public boundary: an arbitrary truthy entry (2,
  // true, "1") must not be silently counted as a match.
  if (!isMatchVector(targetMatchVector)) {
    return {
      verdict: 'UNKNOWN',
      verdictReason: 'match vector entries must be exactly 0, 1, or null',
      stats: emptyStats,
    };
  }

  const total = targetMatchVector.length;
  let parsed = 0;
  let mismatches = 0;
  for (const entry of targetMatchVector) {
    if (entry === null) continue;
    parsed += 1;
    if (entry === 0) mismatches += 1;
  }
  const coverage = parsed / total;

  if (coverage < minCoverage || parsed === 0) {
    return {
      verdict: 'UNDETERMINED',
      verdictReason: `coverage ${coverage.toFixed(4)} below minimum ${minCoverage}`,
      stats: {
        ...emptyStats,
        targetHamming: mismatches,
        targetTotal: parsed,
        targetCoverage: coverage,
      },
    };
  }

  const p0 = clopperPearsonUpper(selfHamming, selfTotal, cpConfidence);
  const pValue = binomialOneSidedPValue(mismatches, parsed, p0);
  const significant = pValue < alpha;
  const verdict: FingerprintVerdict = !significant
    ? 'SAME'
    : coverage < minDiffCoverage ? 'UNDETERMINED' : 'DIFF';

  return {
    verdict,
    verdictReason:
      verdict === 'DIFF'
        ? `binomial p-value ${pValue.toExponential(4)} below alpha ${alpha}`
        : verdict === 'UNDETERMINED'
          ? `binomial p-value ${pValue.toExponential(4)} below alpha ${alpha}, but coverage ${coverage.toFixed(4)} is below the ${minDiffCoverage} a DIFF needs`
          : null,
    stats: {
      selfHamming,
      selfTotal,
      targetHamming: mismatches,
      targetTotal: parsed,
      targetCoverage: coverage,
      p0Cp99: p0,
      pValueBinomial: pValue,
    },
  };
}

/**
 * Close-call extension rule (`kbf-extension-v1`). A first audit whose p-value is clearly small
 * (< `clearDiffAlpha`) or clearly large (>= `greyUpper`) is decided as today. In between, the seller
 * is asked one more set of never-seen probes of the same size and the verdict is taken on both sets
 * pooled at `pooledAlpha`. This is a two-look sequential test: the strict first look keeps the
 * worst-case false-DIFF rate of both looks together at about 4% (exact binomial search over
 * n = 100..300, p0 = 0.02..0.36), under the single-look 5%. Not part of the KBF reference code.
 */
export const KBF_EXTENSION_RULE = Object.freeze({
  id: 'kbf-extension-v1',
  clearDiffAlpha: 0.005,
  greyUpper: 0.2,
  pooledAlpha: 0.05,
  extensionSize: 'first-set-probe-count',
} as const);

export type KbfExtensionRule = typeof KBF_EXTENSION_RULE;

/**
 * Whether a first audit is decided on its own (`clear`) or needs an extension (`extend`). Low
 * coverage (UNDETERMINED by `minCoverage`) and invalid stats are always `clear`.
 */
export function classifyKbfFirstLook(
  stats: Pick<KbfVerdictStats, 'pValueBinomial' | 'targetCoverage'>,
  options: { minCoverage?: number; rule?: KbfExtensionRule } = {},
): 'clear' | 'extend' {
  const rule = options.rule ?? KBF_EXTENSION_RULE;
  const minCoverage = options.minCoverage ?? 0.5;
  const p = stats.pValueBinomial;
  const coverage = stats.targetCoverage;
  if (p === null || coverage === null || !Number.isFinite(p) || coverage < minCoverage) return 'clear';
  return p >= rule.clearDiffAlpha && p < rule.greyUpper ? 'extend' : 'clear';
}

export interface KbfPooledSetInput {
  /** The set's own stats, as recorded in its audit evidence. */
  stats: Pick<KbfVerdictStats, 'selfHamming' | 'selfTotal' | 'targetHamming' | 'targetTotal'>;
  /** Probes the set asked (scored or not). */
  probeCount: number;
}

/**
 * The verdict on a first set and its extension pooled: both are disjoint probe sets of the same
 * bank, so pooling is sums. p0 is the Clopper-Pearson upper bound of the combined self-test, the
 * target count is the combined mismatches over the combined scored answers, and coverage is
 * combined scored answers over combined probes. The coverage gates are the single-set ones.
 */
export function computeKbfPooledVerdict(input: {
  first: KbfPooledSetInput;
  extension: KbfPooledSetInput;
  minCoverage?: number;
  minDiffCoverage?: number;
  cpConfidence?: number;
  rule?: KbfExtensionRule;
}): KbfVerdictResult {
  const rule = input.rule ?? KBF_EXTENSION_RULE;
  const minCoverage = input.minCoverage ?? 0.5;
  const minDiffCoverage = Math.max(minCoverage, input.minDiffCoverage ?? minCoverage);
  const cpConfidence = input.cpConfidence ?? 0.99;
  const sets = [input.first, input.extension];
  const selfHamming = sets.reduce((sum, set) => sum + set.stats.selfHamming, 0);
  const selfTotal = sets.reduce((sum, set) => sum + set.stats.selfTotal, 0);
  const emptyStats: KbfVerdictStats = {
    selfHamming, selfTotal, targetHamming: null, targetTotal: null, targetCoverage: null, p0Cp99: null, pValueBinomial: null,
  };
  const invalid = sets.some((set) => !Number.isInteger(set.probeCount) || set.probeCount <= 0
    || !Number.isInteger(set.stats.selfHamming) || !Number.isInteger(set.stats.selfTotal)
    || set.stats.selfTotal <= 0 || set.stats.selfHamming < 0 || set.stats.selfHamming > set.stats.selfTotal
    || !Number.isInteger(set.stats.targetHamming) || !Number.isInteger(set.stats.targetTotal)
    || (set.stats.targetTotal as number) < 0 || (set.stats.targetTotal as number) > set.probeCount
    || (set.stats.targetHamming as number) < 0 || (set.stats.targetHamming as number) > (set.stats.targetTotal as number));
  if (invalid) return { verdict: 'UNKNOWN', verdictReason: 'invalid set statistics for a pooled verdict', stats: emptyStats };
  const mismatches = sets.reduce((sum, set) => sum + (set.stats.targetHamming as number), 0);
  const parsed = sets.reduce((sum, set) => sum + (set.stats.targetTotal as number), 0);
  const probes = sets.reduce((sum, set) => sum + set.probeCount, 0);
  const coverage = parsed / probes;
  if (coverage < minCoverage || parsed === 0) {
    return {
      verdict: 'UNDETERMINED',
      verdictReason: `pooled coverage ${coverage.toFixed(4)} below minimum ${minCoverage}`,
      stats: { ...emptyStats, targetHamming: mismatches, targetTotal: parsed, targetCoverage: coverage },
    };
  }
  const p0 = clopperPearsonUpper(selfHamming, selfTotal, cpConfidence);
  const pValue = binomialOneSidedPValue(mismatches, parsed, p0);
  const significant = pValue < rule.pooledAlpha;
  const verdict: FingerprintVerdict = !significant ? 'SAME' : coverage < minDiffCoverage ? 'UNDETERMINED' : 'DIFF';
  return {
    verdict,
    verdictReason: verdict === 'DIFF'
      ? `pooled binomial p-value ${pValue.toExponential(4)} below alpha ${rule.pooledAlpha} (${rule.id})`
      : verdict === 'UNDETERMINED'
        ? `pooled binomial p-value ${pValue.toExponential(4)} below alpha ${rule.pooledAlpha}, but pooled coverage ${coverage.toFixed(4)} is below the ${minDiffCoverage} a DIFF needs`
        : null,
    stats: {
      selfHamming, selfTotal, targetHamming: mismatches, targetTotal: parsed, targetCoverage: coverage, p0Cp99: p0, pValueBinomial: pValue,
    },
  };
}
