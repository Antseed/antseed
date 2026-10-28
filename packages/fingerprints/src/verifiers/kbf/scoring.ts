/**
 * Match-vector computation: tolerance matching of parsed answers against
 * probe consensus values.
 */

import type { KbfProbe, MatchEntry, MatchVector } from '../../types.js';

/** True when `answer` is within the probe's tolerance of its consensus. */
export function matchesTolerance(answer: number, probe: KbfProbe): boolean {
  const { mode, value } = probe.tolerance;
  const diff = Math.abs(answer - probe.consensus);
  if (mode === 'absolute') {
    return diff <= value;
  }
  if (mode === 'relative') {
    return diff <= Math.abs(probe.consensus) * value;
  }
  throw new Error(`matchesTolerance: unknown tolerance mode "${String(mode)}"`);
}

/**
 * Score one answer: 1 within tolerance of consensus, 0 outside it, and null
 * when the answer is missing, non-finite, or outside the probe's plausible
 * range. A null answer is left unscored, as in the KBF paper (v3) and its
 * reference code: it counts neither as a match nor as a discrepancy.
 */
export function scoreKbfAnswer(answer: number | null | undefined, probe: KbfProbe): MatchEntry {
  if (answer === null || answer === undefined || !Number.isFinite(answer)) return null;
  const range = probe.range;
  if (Array.isArray(range) && range.length === 2 && (answer < range[0] || answer > range[1])) return null;
  return matchesTolerance(answer, probe) ? 1 : 0;
}

/**
 * Score a completed probe response. Missing, non-finite, and out-of-range
 * answers are unscored (null), exactly like probes that could not be attempted
 * because transport failed, so the verdict compares only answered probes.
 */
export function computeMatchVector(
  answers: ReadonlyArray<number | null>,
  probes: readonly KbfProbe[],
): MatchVector {
  if (answers.length !== probes.length) {
    throw new Error(
      `computeMatchVector: answers length ${answers.length} !== probes length ${probes.length}`,
    );
  }
  return probes.map((probe, i): MatchEntry => scoreKbfAnswer(answers[i], probe));
}

/**
 * True when more than half of a batch's answers are unscoreable. The KBF
 * reference code re-asks such a batch (up to twice) and keeps the attempt with
 * the most scoreable answers.
 */
export function isLowCoverageKbfBatch(matches: ReadonlyArray<MatchEntry>): boolean {
  const missing = matches.filter((match) => match === null).length;
  return matches.length >= 3 && missing * 2 > matches.length;
}

/** Re-asks of a low-coverage batch after the first try, as in the KBF reference code. */
export const KBF_LOW_COVERAGE_RETRIES = 2;
