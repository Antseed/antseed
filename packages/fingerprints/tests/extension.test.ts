import { describe, expect, it } from 'vitest';
import {
  KBF_EXTENSION_RULE,
  binomialOneSidedPValue,
  classifyKbfFirstLook,
  computeKbfPooledVerdict,
} from '../src/verifiers/kbf/index.js';

function binomialPmf(n: number, k: number, p: number): number {
  let logC = 0;
  for (let i = 1; i <= k; i += 1) logC += Math.log(n - k + i) - Math.log(i);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

/** Exact false-DIFF of the two-look rule for a seller exactly at the limit (q = p0), n2 = n1. */
function twoLookFalseDiff(n: number, p0: number): number {
  const first = Array.from({ length: n + 1 }, (_, k) => binomialPmf(n, k, p0));
  const second = first;
  let total = 0;
  for (let k1 = 0; k1 <= n; k1 += 1) {
    const p1 = binomialOneSidedPValue(k1, n, p0);
    if (p1 < KBF_EXTENSION_RULE.clearDiffAlpha) {
      total += first[k1]!;
      continue;
    }
    if (p1 >= KBF_EXTENSION_RULE.greyUpper) continue;
    for (let k2 = 0; k2 <= n; k2 += 1) {
      if (binomialOneSidedPValue(k1 + k2, 2 * n, p0) < KBF_EXTENSION_RULE.pooledAlpha) total += first[k1]! * second[k2]!;
    }
  }
  return total;
}

describe('classifyKbfFirstLook', () => {
  it('extends only close calls with enough coverage', () => {
    expect(classifyKbfFirstLook({ pValueBinomial: 0.0049, targetCoverage: 1 })).toBe('clear');
    expect(classifyKbfFirstLook({ pValueBinomial: 0.005, targetCoverage: 1 })).toBe('extend');
    expect(classifyKbfFirstLook({ pValueBinomial: 0.199, targetCoverage: 0.6 })).toBe('extend');
    expect(classifyKbfFirstLook({ pValueBinomial: 0.2, targetCoverage: 1 })).toBe('clear');
    expect(classifyKbfFirstLook({ pValueBinomial: 0.05, targetCoverage: 0.49 })).toBe('clear');
    expect(classifyKbfFirstLook({ pValueBinomial: null, targetCoverage: null })).toBe('clear');
  });
});

describe('computeKbfPooledVerdict', () => {
  const set = (selfHamming: number, selfTotal: number, targetHamming: number, targetTotal: number, probeCount = targetTotal) => ({
    stats: { selfHamming, selfTotal, targetHamming, targetTotal }, probeCount,
  });

  it('sums both sets', () => {
    const pooled = computeKbfPooledVerdict({ first: set(30, 450, 25, 150), extension: set(36, 450, 28, 150) });
    expect(pooled.stats.selfHamming).toBe(66);
    expect(pooled.stats.selfTotal).toBe(900);
    expect(pooled.stats.targetHamming).toBe(53);
    expect(pooled.stats.targetTotal).toBe(300);
    expect(pooled.stats.targetCoverage).toBe(1);
    expect(pooled.verdict).toBe('DIFF');
  });

  it('calls bad luck SAME when the second set is normal', () => {
    const pooled = computeKbfPooledVerdict({ first: set(30, 450, 18, 150), extension: set(30, 450, 9, 150) });
    expect(pooled.verdict).toBe('SAME');
  });

  it('applies the coverage gates to the pooled sets', () => {
    // Pooled coverage 0.7: significant, but below the 0.8 a DIFF needs.
    const low = computeKbfPooledVerdict({
      first: set(3, 450, 40, 110, 150), extension: set(3, 450, 40, 100, 150), minCoverage: 0.5, minDiffCoverage: 0.8,
    });
    expect(low.verdict).toBe('UNDETERMINED');
    const veryLow = computeKbfPooledVerdict({ first: set(3, 450, 10, 50, 150), extension: set(3, 450, 10, 50, 150) });
    expect(veryLow.verdict).toBe('UNDETERMINED');
  });

  it('rejects invalid statistics', () => {
    expect(computeKbfPooledVerdict({ first: set(3, 0, 1, 10), extension: set(3, 450, 1, 10) }).verdict).toBe('UNKNOWN');
    expect(computeKbfPooledVerdict({ first: set(3, 450, 11, 10), extension: set(3, 450, 1, 10) }).verdict).toBe('UNKNOWN');
  });

  it('keeps the worst-case false-DIFF of both looks under 5%', () => {
    for (const n of [100, 150, 200, 300]) {
      for (const p0 of [0.05, 0.1, 0.17, 0.27, 0.285]) {
        expect(twoLookFalseDiff(n, p0)).toBeLessThan(0.0425);
      }
    }
  });
});
