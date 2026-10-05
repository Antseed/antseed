import { describe, expect, it } from 'vitest';
import { computeKbfVerdict } from '../src/verifiers/kbf/verdict.js';
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
