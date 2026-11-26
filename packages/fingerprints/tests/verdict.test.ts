import { describe, expect, it } from 'vitest';
import { KBF_COVERAGE_RULE, KBF_COVERAGE_RULE_V1, computeKbfVerdict, kbfCoverageRuleById } from '../src/verifiers/kbf/verdict.js';
import type { MatchVector } from '../src/types.js';

function vector(matches: number, mismatches: number, unparseable = 0): MatchVector {
  return [
    ...Array<1>(matches).fill(1),
    ...Array<0>(mismatches).fill(0),
    ...Array<null>(unparseable).fill(null),
  ];
}

describe('computeKbfVerdict', () => {
  it('SAME when target hamming is near the reference self-error', () => {
    // Reference: 3 errors in 224. CP99 upper bound ~0.0441.
    // Target: 5 mismatches in 220 parsed (~0.023) — consistent.
    const { verdict, stats } = computeKbfVerdict({
      selfHamming: 3,
      selfTotal: 224,
      targetMatchVector: vector(215, 5),
    });
    expect(verdict).toBe('SAME');
    expect(stats.p0Cp99).toBeCloseTo(0.044144, 5);
    expect(stats.pValueBinomial).toBeGreaterThanOrEqual(0.05);
    expect(stats.targetHamming).toBe(5);
    expect(stats.targetTotal).toBe(220);
  });

  it('SAME with zero target mismatches', () => {
    const { verdict, stats } = computeKbfVerdict({
      selfHamming: 0,
      selfTotal: 100,
      targetMatchVector: vector(100, 0),
    });
    expect(verdict).toBe('SAME');
    expect(stats.pValueBinomial).toBe(1);
  });

  it('DIFF for gross mismatch', () => {
    // Target mismatches 80 of 200 against p0 ~0.0441 — overwhelming evidence.
    const { verdict, verdictReason, stats } = computeKbfVerdict({
      selfHamming: 3,
      selfTotal: 224,
      targetMatchVector: vector(120, 80),
    });
    expect(verdict).toBe('DIFF');
    expect(stats.pValueBinomial).toBeLessThan(1e-10);
    expect(verdictReason).toMatch(/p-value/);
  });

  it('UNDETERMINED below minimum coverage', () => {
    // 40 parsed of 100 → coverage 0.4 < 0.5.
    const { verdict, stats } = computeKbfVerdict({
      selfHamming: 3,
      selfTotal: 224,
      targetMatchVector: vector(20, 20, 60),
    });
    expect(verdict).toBe('UNDETERMINED');
    expect(stats.targetCoverage).toBeCloseTo(0.4, 10);
    expect(stats.p0Cp99).toBeNull();
    expect(stats.pValueBinomial).toBeNull();
  });

  it('respects a custom minCoverage', () => {
    const input = {
      selfHamming: 3,
      selfTotal: 224,
      targetMatchVector: vector(20, 20, 60), // coverage 0.4
    };
    expect(computeKbfVerdict({ ...input, minCoverage: 0.3 }).verdict).not.toBe('UNDETERMINED');
    expect(computeKbfVerdict({ ...input, minCoverage: 0.5 }).verdict).toBe('UNDETERMINED');
  });

  it('a DIFF needs minDiffCoverage; a SAME only needs minCoverage', () => {
    // 70 of 100 scored (coverage 0.7), 40 mismatches against a ~1% reference: clearly significant.
    const diffInput = { selfHamming: 3, selfTotal: 224, targetMatchVector: vector(30, 40, 30) };
    expect(computeKbfVerdict(diffInput).verdict).toBe('DIFF');
    const strict = computeKbfVerdict({ ...diffInput, minDiffCoverage: 0.8 });
    expect(strict.verdict).toBe('UNDETERMINED');
    expect(strict.verdictReason).toMatch(/below the 0.8 a DIFF needs/);
    expect(strict.stats.pValueBinomial).not.toBeNull();
    // Same coverage, all matches: SAME is unaffected.
    const sameInput = { selfHamming: 3, selfTotal: 224, targetMatchVector: vector(70, 0, 30) };
    expect(computeKbfVerdict({ ...sameInput, minDiffCoverage: 0.8 }).verdict).toBe('SAME');
    // At or above 0.8 the DIFF stands.
    expect(computeKbfVerdict({ selfHamming: 3, selfTotal: 224, targetMatchVector: vector(40, 40, 20), minDiffCoverage: 0.8 }).verdict).toBe('DIFF');
  });

  it('kbf-coverage-v1: under minDiffCoverage, a look whose scored answers alone are decisive at p <= 1e-6 over at least 50 is DIFF', () => {
    expect(KBF_COVERAGE_RULE).toBe(KBF_COVERAGE_RULE_V1);
    expect([KBF_COVERAGE_RULE_V1.id, KBF_COVERAGE_RULE_V1.strictDiffAlpha, KBF_COVERAGE_RULE_V1.minScored]).toEqual(['kbf-coverage-v1', 1e-6, 50]);
    expect(Object.isFrozen(KBF_COVERAGE_RULE_V1)).toBe(true);
    expect(kbfCoverageRuleById('kbf-coverage-v1')).toBe(KBF_COVERAGE_RULE_V1);
    expect(kbfCoverageRuleById('kbf-coverage-v9')).toBeNull();
    expect(kbfCoverageRuleById(undefined)).toBeNull();
    const audit = { selfHamming: 15, selfTotal: 150, minCoverage: 0.5, minDiffCoverage: 0.8 };
    // 85 of 150 scored (coverage 0.57), 38 of them off: far beyond the bar.
    const farOff = { ...audit, targetMatchVector: vector(47, 38, 65) };
    const without = computeKbfVerdict(farOff);
    expect(without.verdict).toBe('UNDETERMINED');
    const withRule = computeKbfVerdict({ ...farOff, coverageRule: KBF_COVERAGE_RULE_V1 });
    expect(withRule.verdict).toBe('DIFF');
    expect(withRule.stats).toEqual(without.stats);
    expect(withRule.stats.pValueBinomial!).toBeLessThanOrEqual(1e-6);
    expect(withRule.verdictReason).toMatch(/at or below 0\.000001 over 85 scored answers \(kbf-coverage-v1\), though coverage 0\.5667 is below 0\.8/);
    // Fewer than 50 scored: UNDETERMINED, however far off.
    const few = computeKbfVerdict({ ...audit, targetMatchVector: vector(19, 30, 31), coverageRule: KBF_COVERAGE_RULE_V1 });
    expect([few.stats.targetTotal, few.stats.pValueBinomial! <= 1e-6, few.verdict]).toEqual([49, true, 'UNDETERMINED']);
    // Significant, but not at the strict bar: UNDETERMINED.
    const close = computeKbfVerdict({ ...audit, targetMatchVector: vector(67, 25, 58), coverageRule: KBF_COVERAGE_RULE_V1 });
    expect(close.stats.pValueBinomial!).toBeGreaterThan(1e-6);
    expect(close.stats.pValueBinomial!).toBeLessThan(0.05);
    expect(close.verdict).toBe('UNDETERMINED');
    // Under minCoverage: UNDETERMINED as before.
    expect(computeKbfVerdict({ ...audit, targetMatchVector: vector(20, 50, 80), coverageRule: KBF_COVERAGE_RULE_V1 }).verdict).toBe('UNDETERMINED');
    // At or above minDiffCoverage, and for a SAME, the rule changes nothing.
    for (const targetMatchVector of [vector(80, 40, 30), vector(80, 4, 66), vector(130, 10, 10)]) {
      const plain = computeKbfVerdict({ ...audit, targetMatchVector });
      if (plain.verdict === 'UNDETERMINED') continue;
      expect(computeKbfVerdict({ ...audit, targetMatchVector, coverageRule: KBF_COVERAGE_RULE_V1 })).toEqual(plain);
    }
    expect(computeKbfVerdict({ ...audit, targetMatchVector: vector(80, 4, 66), coverageRule: KBF_COVERAGE_RULE_V1 }).verdict).toBe('SAME');
  });

  it('UNDETERMINED when nothing parsed', () => {
    const { verdict } = computeKbfVerdict({
      selfHamming: 0,
      selfTotal: 10,
      targetMatchVector: vector(0, 0, 10),
    });
    expect(verdict).toBe('UNDETERMINED');
  });

  it('UNKNOWN for invalid reference self-test', () => {
    expect(
      computeKbfVerdict({ selfHamming: 0, selfTotal: 0, targetMatchVector: vector(10, 0) })
        .verdict,
    ).toBe('UNKNOWN');
    expect(
      computeKbfVerdict({ selfHamming: -1, selfTotal: 10, targetMatchVector: vector(10, 0) })
        .verdict,
    ).toBe('UNKNOWN');
    expect(
      computeKbfVerdict({ selfHamming: 11, selfTotal: 10, targetMatchVector: vector(10, 0) })
        .verdict,
    ).toBe('UNKNOWN');
  });

  it('UNKNOWN for an empty match vector', () => {
    const { verdict, verdictReason } = computeKbfVerdict({
      selfHamming: 3,
      selfTotal: 224,
      targetMatchVector: [],
    });
    expect(verdict).toBe('UNKNOWN');
    expect(verdictReason).toMatch(/empty/);
  });

  it('UNKNOWN when the match vector holds entries other than 0/1/null', () => {
    for (const bad of [2, true, '1', 0.5, -1]) {
      const { verdict, verdictReason } = computeKbfVerdict({
        selfHamming: 3,
        selfTotal: 224,
        targetMatchVector: [1, bad, 0] as unknown as MatchVector,
      });
      expect(verdict, String(bad)).toBe('UNKNOWN');
      expect(verdictReason).toMatch(/exactly 0, 1, or null/);
    }
  });

  it('alpha controls the DIFF threshold', () => {
    // Choose a borderline case: p0 ~ 0.0441, 14 mismatches in 220.
    const input = {
      selfHamming: 3,
      selfTotal: 224,
      targetMatchVector: vector(206, 14),
    };
    const loose = computeKbfVerdict({ ...input, alpha: 0.01 });
    const strict = computeKbfVerdict({ ...input, alpha: 0.2 });
    expect(loose.stats.pValueBinomial).toEqual(strict.stats.pValueBinomial);
    const p = loose.stats.pValueBinomial!;
    expect(loose.verdict).toBe(p < 0.01 ? 'DIFF' : 'SAME');
    expect(strict.verdict).toBe(p < 0.2 ? 'DIFF' : 'SAME');
  });
});
