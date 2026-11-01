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
   * A DIFF from the answered probes alone needs at least this scored fraction.
   * Below it the result is DIFF only when it holds even with every missing answer
   * counted as a match. Default: `minCoverage` (no extra requirement).
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
 *   one-sided binomial test of the target's mismatch count against p0.
 *
 * Missing answers cannot improve the verdict. DIFF when the answered probes are
 * significant (with `minDiffCoverage` scored) or when even counting every missing
 * answer as a match is significant. SAME only when the answered probes are not
 * significant and neither is counting every missing answer as a mismatch; a seller
 * that leaves out the answers it would get wrong is UNDETERMINED, not SAME.
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
  const missing = total - parsed;
  const pValue = binomialOneSidedPValue(mismatches, parsed, p0);
  const significant = pValue < alpha;
  // Bounds over every way the missing answers could have gone.
  const missingAsMatches = binomialOneSidedPValue(mismatches, total, p0) < alpha;
  const missingAsMismatches = missing > 0 && binomialOneSidedPValue(mismatches + missing, total, p0) < alpha;
  const verdict: FingerprintVerdict = (significant && coverage >= minDiffCoverage) || missingAsMatches
    ? 'DIFF'
    : significant || missingAsMismatches ? 'UNDETERMINED' : 'SAME';

  return {
    verdict,
    verdictReason:
      verdict === 'DIFF'
        ? `binomial p-value ${pValue.toExponential(4)} below alpha ${alpha}`
        : verdict === 'UNDETERMINED'
          ? significant
            ? `binomial p-value ${pValue.toExponential(4)} below alpha ${alpha}, but coverage ${coverage.toFixed(4)} is below the ${minDiffCoverage} a DIFF needs`
            : `${missing} missing answers could hide a DIFF (coverage ${coverage.toFixed(4)})`
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
