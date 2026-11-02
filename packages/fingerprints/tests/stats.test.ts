import { describe, expect, it } from 'vitest';
import {
  betacf,
  binomialOneSidedPValue,
  clopperPearsonUpper,
  logBeta,
  logGamma,
  regularizedIncompleteBeta,
} from '../src/verifiers/kbf/stats.js';

function binomialTailBruteForce(k: number, n: number, p0: number): number {
  const comb = (nn: number, kk: number): number => {
    let r = 1;
    for (let i = 1; i <= kk; i++) r = (r * (nn - i + 1)) / i;
    return r;
  };
  let sum = 0;
  for (let i = k; i <= n; i++) {
    sum += comb(n, i) * Math.pow(p0, i) * Math.pow(1 - p0, n - i);
  }
  return sum;
}

describe('logGamma / logBeta', () => {
  it('matches factorials: Gamma(n) = (n-1)!', () => {
    expect(Math.exp(logGamma(1))).toBeCloseTo(1, 10);
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 8);
    expect(Math.exp(logGamma(11))).toBeCloseTo(3628800, 2);
  });

  it('matches Gamma(0.5) = sqrt(pi)', () => {
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 10);
  });

  it('logBeta(2, 3) = ln(1/12)', () => {
    expect(logBeta(2, 3)).toBeCloseTo(Math.log(1 / 12), 10);
  });

  it('rejects non-positive input', () => {
    expect(() => logGamma(0)).toThrow();
    expect(() => logGamma(-1)).toThrow();
  });
});

describe('regularizedIncompleteBeta', () => {
  it('handles boundaries', () => {
    expect(regularizedIncompleteBeta(2, 3, 0)).toBe(0);
    expect(regularizedIncompleteBeta(2, 3, 1)).toBe(1);
  });

  it('I_x(1, 1) = x (uniform)', () => {
    expect(regularizedIncompleteBeta(1, 1, 0.3)).toBeCloseTo(0.3, 12);
  });

  it('I_x(1, n) = 1 - (1-x)^n', () => {
    const x = 0.05;
    const n = 20;
    expect(regularizedIncompleteBeta(1, n, x)).toBeCloseTo(1 - Math.pow(1 - x, n), 12);
  });

  it('symmetry: I_x(a, b) = 1 - I_{1-x}(b, a)', () => {
    const v = regularizedIncompleteBeta(4, 7, 0.35);
    expect(v).toBeCloseTo(1 - regularizedIncompleteBeta(7, 4, 0.65), 12);
  });

  it('betacf converges for typical arguments', () => {
    expect(Number.isFinite(betacf(4, 221, 0.02))).toBe(true);
  });
});

describe('clopperPearsonUpper', () => {
  it('k=0, n=224, conf=0.99 matches the closed form 1 - 0.01^(1/224)', () => {
    const expected = 1 - Math.pow(0.01, 1 / 224); // 0.020348904268503443
    expect(clopperPearsonUpper(0, 224, 0.99)).toBeCloseTo(expected, 9);
    expect(clopperPearsonUpper(0, 224, 0.99)).toBeCloseTo(0.0203489, 6);
  });

  it('k=0 closed form holds for other n and confidence levels', () => {
    expect(clopperPearsonUpper(0, 30, 0.95)).toBeCloseTo(1 - Math.pow(0.05, 1 / 30), 9);
    expect(clopperPearsonUpper(0, 10, 0.99)).toBeCloseTo(1 - Math.pow(0.01, 1 / 10), 9);
  });

  it('known value: k=1, n=10 at 95% one-sided is ~0.3942', () => {
    expect(clopperPearsonUpper(1, 10, 0.95)).toBeCloseTo(0.394163, 5);
  });

  it('satisfies the beta-quantile identity I_p(k+1, n-k) = confidence', () => {
    for (const [k, n, conf] of [
      [3, 224, 0.99],
      [5, 100, 0.99],
      [1, 30, 0.95],
    ] as const) {
      const p = clopperPearsonUpper(k, n, conf);
      expect(regularizedIncompleteBeta(k + 1, n - k, p)).toBeCloseTo(conf, 6);
    }
  });

  it('documented reference value: k=3, n=224 at CP99 (1e-6 tolerance)', () => {
    expect(clopperPearsonUpper(3, 224, 0.99)).toBeCloseTo(0.044144, 6);
  });

  it('k = n returns 1', () => {
    expect(clopperPearsonUpper(5, 5, 0.99)).toBe(1);
  });

  it('is monotonically increasing in k', () => {
    const a = clopperPearsonUpper(0, 100, 0.99);
    const b = clopperPearsonUpper(1, 100, 0.99);
    const c = clopperPearsonUpper(10, 100, 0.99);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('rejects invalid input', () => {
    expect(() => clopperPearsonUpper(-1, 10)).toThrow();
    expect(() => clopperPearsonUpper(11, 10)).toThrow();
    expect(() => clopperPearsonUpper(0, 0)).toThrow();
    expect(() => clopperPearsonUpper(0, 10, 1)).toThrow();
    expect(() => clopperPearsonUpper(0.5 as number, 10)).toThrow();
  });
});

describe('binomialOneSidedPValue', () => {
  it('matches brute-force summation for small n', () => {
    for (const [k, n, p0] of [
      [2, 10, 0.1],
      [0, 10, 0.1],
      [10, 10, 0.5],
      [5, 20, 0.3],
      [1, 30, 0.02],
      [7, 15, 0.4],
    ] as const) {
      expect(binomialOneSidedPValue(k, n, p0)).toBeCloseTo(binomialTailBruteForce(k, n, p0), 10);
    }
  });

  it('matches the incomplete-beta identity P(X >= k) = I_{p0}(k, n-k+1)', () => {
    expect(binomialOneSidedPValue(5, 20, 0.3)).toBeCloseTo(
      regularizedIncompleteBeta(5, 16, 0.3),
      10,
    );
  });

  it('handles edge cases', () => {
    expect(binomialOneSidedPValue(0, 10, 0.5)).toBe(1); // X >= 0 always
    expect(binomialOneSidedPValue(11, 10, 0.5)).toBe(0); // impossible
    expect(binomialOneSidedPValue(3, 10, 0)).toBe(0);
    expect(binomialOneSidedPValue(3, 10, 1)).toBe(1);
  });

  it('is numerically stable for large n and extreme tails', () => {
    const p = binomialOneSidedPValue(180, 224, 0.05);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1e-100);
  });

  it('uses an exact CP bound above 0.99 without clamping it', () => {
    const p0 = clopperPearsonUpper(99, 100, 0.99);
    expect(p0).toBeGreaterThan(0.99);
    expect(p0).toBeCloseTo(0.9998995016917583, 12);
    expect(binomialOneSidedPValue(317, 317, p0)).toBeCloseTo(0.9686426041855408, 12);
  });

  it('rejects invalid input', () => {
    expect(() => binomialOneSidedPValue(1, 10, -0.1)).toThrow();
    expect(() => binomialOneSidedPValue(1, 10, 1.1)).toThrow();
    expect(() => binomialOneSidedPValue(1.5 as number, 10, 0.5)).toThrow();
  });
});
