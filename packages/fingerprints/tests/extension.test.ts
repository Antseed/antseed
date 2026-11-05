import { describe, expect, it } from 'vitest';
import {
  KBF_EXTENSION_RULE,
  KBF_EXTENSION_RULE_V1,
  KBF_EXTENSION_RULE_V2,
  binomialOneSidedPValue,
  classifyKbfFirstLook,
  computeKbfPooledVerdict,
  kbfExtensionRuleById,
  type KbfExtensionRule,
} from '../src/verifiers/kbf/index.js';

function binomialPmf(n: number, k: number, p: number): number {
  let logC = 0;
  for (let i = 1; i <= k; i += 1) logC += Math.log(n - k + i) - Math.log(i);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

/**
 * Exact probability that a seller with mismatch rate q is called DIFF by a close-call rule, with every
 * set of size n and the null rate p0 (q = p0 is an honest seller exactly at the limit).
 */
function sequentialDiffRate(n: number, p0: number, q: number, rule: KbfExtensionRule): number {
  const pmf = Array.from({ length: n + 1 }, (_, k) => binomialPmf(n, k, q));
  // Mismatch totals still undecided after the current look, with their probabilities.
  let open = new Map<number, number>([[0, 1]]);
  let diff = 0;
  for (let look = 0; look <= rule.maxExtensions; look += 1) {
    const next = new Map<number, number>();
    for (const [total, weight] of open) {
      for (let k = 0; k <= n; k += 1) {
        const w = weight * pmf[k]!;
        if (w < 1e-15) continue;
        next.set(total + k, (next.get(total + k) ?? 0) + w);
      }
    }
    open = new Map();
    const scored = (look + 1) * n;
    for (const [total, weight] of next) {
      const p = binomialOneSidedPValue(total, scored, p0);
      const last = look === rule.maxExtensions;
      if (last) {
        if (p < rule.pooledAlpha) diff += weight;
      } else if (p < rule.clearDiffAlpha) {
        diff += weight;
      } else if (p < rule.greyUpper) {
        open.set(total, weight);
      }
    }
  }
  return diff;
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

  const v1 = KBF_EXTENSION_RULE_V1;

  it('sums both sets', () => {
    const pooled = computeKbfPooledVerdict({ first: set(30, 450, 25, 150), extension: set(36, 450, 28, 150), rule: v1 });
    expect(pooled.stats.selfHamming).toBe(66);
    expect(pooled.stats.selfTotal).toBe(900);
    expect(pooled.stats.targetHamming).toBe(53);
    expect(pooled.stats.targetTotal).toBe(300);
    expect(pooled.stats.targetCoverage).toBe(1);
    expect(pooled.verdict).toBe('DIFF');
  });

  it('calls bad luck SAME when the second set is normal', () => {
    const pooled = computeKbfPooledVerdict({ first: set(30, 450, 18, 150), extension: set(30, 450, 9, 150), rule: v1 });
    expect(pooled.verdict).toBe('SAME');
  });

  it('applies the coverage gates to the pooled sets', () => {
    // Pooled coverage 0.7: significant, but below the 0.8 a DIFF needs.
    const low = computeKbfPooledVerdict({
      first: set(3, 450, 40, 110, 150), extension: set(3, 450, 40, 100, 150), minCoverage: 0.5, minDiffCoverage: 0.8, rule: v1,
    });
    expect(low.verdict).toBe('UNDETERMINED');
    const veryLow = computeKbfPooledVerdict({ first: set(3, 450, 10, 50, 150), extension: set(3, 450, 10, 50, 150), rule: v1 });
    expect(veryLow.verdict).toBe('UNDETERMINED');
  });

  it('rejects invalid statistics', () => {
    expect(computeKbfPooledVerdict({ first: set(3, 0, 1, 10), extension: set(3, 450, 1, 10) }).verdict).toBe('UNKNOWN');
    expect(computeKbfPooledVerdict({ first: set(3, 450, 11, 10), extension: set(3, 450, 1, 10) }).verdict).toBe('UNKNOWN');
  });

  it('keeps the worst-case false-DIFF of both looks under 5% (v1)', () => {
    for (const n of [100, 150, 200, 300]) {
      for (const p0 of [0.05, 0.1, 0.17, 0.27, 0.285]) {
        expect(sequentialDiffRate(n, p0, p0, v1)).toBeLessThan(0.0425);
      }
    }
  });
});

describe('kbf-extension-v2 (up to two extra sets)', () => {
  const set = (selfHamming: number, selfTotal: number, targetHamming: number, targetTotal: number, probeCount = targetTotal) => ({
    stats: { selfHamming, selfTotal, targetHamming, targetTotal }, probeCount,
  });
  const v2 = KBF_EXTENSION_RULE_V2;

  it('is the default rule and is found by id', () => {
    expect(KBF_EXTENSION_RULE).toBe(v2);
    expect(kbfExtensionRuleById('kbf-extension-v2')).toBe(v2);
    expect(kbfExtensionRuleById('kbf-extension-v1')).toBe(KBF_EXTENSION_RULE_V1);
    expect(kbfExtensionRuleById('kbf-extension-v9')).toBeNull();
    expect(v2.maxExtensions).toBe(2);
  });

  it('asks a second extra set when the first pooled look is still a close call', () => {
    // Self-error 10/300; the seller is a bit worse on both sets: still in the grey zone after one extra set.
    const first = set(10, 300, 9, 100);
    const pooled = computeKbfPooledVerdict({ first, extensions: [set(10, 300, 9, 100)], rule: v2 });
    expect(pooled.stats.pValueBinomial).toBeGreaterThanOrEqual(v2.clearDiffAlpha);
    expect(pooled.stats.pValueBinomial).toBeLessThan(v2.greyUpper);
    expect(pooled.extend).toBe(true);
    expect(pooled.verdict).toBe('UNDETERMINED');
    // The same look under v1 is its last one and is decided at 0.05.
    const single = computeKbfPooledVerdict({ first, extensions: [set(10, 300, 9, 100)], rule: KBF_EXTENSION_RULE_V1 });
    expect(single.extend).toBe(false);
    expect(single.verdict).toBe('DIFF');
  });

  it('decides an interim look that is clear on its own', () => {
    const clearSame = computeKbfPooledVerdict({ first: set(10, 300, 9, 100), extensions: [set(10, 300, 2, 100)], rule: v2 });
    expect(clearSame.extend).toBe(false);
    expect(clearSame.verdict).toBe('SAME');
    const clearDiff = computeKbfPooledVerdict({ first: set(10, 300, 9, 100), extensions: [set(10, 300, 20, 100)], rule: v2 });
    expect(clearDiff.extend).toBe(false);
    expect(clearDiff.verdict).toBe('DIFF');
  });

  it('decides the third look at 0.05 on all three sets', () => {
    // 8/100 three times: p of about 0.017 on all 300, under 0.05 → DIFF (it was grey after two sets).
    const s8 = set(10, 300, 8, 100);
    expect(computeKbfPooledVerdict({ first: s8, extensions: [s8], rule: v2 }).extend).toBe(true);
    const pooled = computeKbfPooledVerdict({ first: s8, extensions: [s8, s8], rule: v2 });
    expect(pooled.extend).toBe(false);
    expect(pooled.stats.targetHamming).toBe(24);
    expect(pooled.stats.targetTotal).toBe(300);
    expect(pooled.stats.selfTotal).toBe(900);
    expect(pooled.stats.pValueBinomial).toBeGreaterThan(v2.clearDiffAlpha);
    expect(pooled.stats.pValueBinomial).toBeLessThan(v2.pooledAlpha);
    expect(pooled.verdict).toBe('DIFF');
    // A normal third set brings the seller back: SAME.
    expect(computeKbfPooledVerdict({ first: s8, extensions: [s8, set(10, 300, 1, 100)], rule: v2 }).verdict).toBe('SAME');
  });

  it('rejects more extra sets than the rule allows, and none', () => {
    const s = set(10, 300, 7, 100);
    expect(computeKbfPooledVerdict({ first: s, extensions: [s, s, s], rule: v2 }).verdict).toBe('UNKNOWN');
    expect(computeKbfPooledVerdict({ first: s, extensions: [s, s], rule: KBF_EXTENSION_RULE_V1 }).verdict).toBe('UNKNOWN');
    expect(computeKbfPooledVerdict({ first: s, extensions: [], rule: v2 }).verdict).toBe('UNKNOWN');
  });

  it('keeps the worst-case false-DIFF of all three looks under the two-look rule', () => {
    let worst = 0;
    for (const n of [100, 150, 200, 300]) {
      for (const p0 of [0.02, 0.05, 0.1, 0.17, 0.27, 0.285, 0.36]) {
        const rate = sequentialDiffRate(n, p0, p0, v2);
        worst = Math.max(worst, rate);
        expect(rate).toBeLessThan(0.035);
      }
    }
    expect(worst).toBeGreaterThan(0.03);
  });

  it('catches a grey-zone cheater more often than the two-look rule', () => {
    // Null rate 10%, the seller 17%, 100 questions per set.
    expect(sequentialDiffRate(100, 0.1, 0.17, v2)).toBeGreaterThan(sequentialDiffRate(100, 0.1, 0.17, KBF_EXTENSION_RULE_V1));
  });
});
