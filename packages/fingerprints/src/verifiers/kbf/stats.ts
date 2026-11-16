/**
 * Exact statistics for KBF verdicts: Clopper-Pearson upper bounds and
 * one-sided binomial tail p-values. Self-contained (Numerical-Recipes-style
 * log-gamma, continued-fraction incomplete beta); no dependencies.
 */

// Lanczos approximation (g = 7, n = 9), accurate to ~1e-13 for x > 0.
const LANCZOS_G = 7;
const LANCZOS_COEFFS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** Natural log of the gamma function for x > 0. */
export function logGamma(x: number): number {
  if (!(x > 0)) {
    throw new Error(`logGamma: x must be > 0, got ${x}`);
  }
  if (x < 0.5) {
    // Reflection: Gamma(x) Gamma(1-x) = pi / sin(pi x)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let sum = LANCZOS_COEFFS[0]!;
  for (let i = 1; i < LANCZOS_COEFFS.length; i++) {
    sum += LANCZOS_COEFFS[i]! / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Natural log of the beta function B(a, b). */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Continued fraction for the incomplete beta function (Numerical Recipes
 * "betacf", modified Lentz's method).
 */
export function betacf(a: number, b: number, x: number): number {
  const MAX_ITER = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) {
      return h;
    }
  }
  throw new Error(`betacf: continued fraction did not converge (a=${a}, b=${b}, x=${x})`);
}

/** Regularized incomplete beta function I_x(a, b) for a, b > 0, x in [0, 1]. */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (!(a > 0) || !(b > 0)) {
    throw new Error(`regularizedIncompleteBeta: a and b must be > 0 (a=${a}, b=${b})`);
  }
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));
  // Use the continued fraction directly for x < (a+1)/(a+b+2), else the
  // symmetry transform for faster convergence.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/**
 * Exact Clopper-Pearson one-sided upper bound on a proportion, given
 * k errors in n trials at the given confidence (default 0.99, i.e. CP99).
 *
 * Equivalent to the Beta(k+1, n-k) quantile at `confidence`; solved by
 * bisection on I_p(k+1, n-k) which is monotonically increasing in p.
 */
export function clopperPearsonUpper(k: number, n: number, confidence = 0.99): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) {
    throw new Error(`clopperPearsonUpper: invalid k=${k}, n=${n}`);
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error(`clopperPearsonUpper: confidence must be in (0, 1), got ${confidence}`);
  }
  if (k >= n) {
    return 1;
  }
  const a = k + 1;
  const b = n - k;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(a, b, mid) < confidence) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-15) {
      break;
    }
  }
  return (lo + hi) / 2;
}

/**
 * One-sided binomial tail p-value: P(X >= k | n, p0). Computed in log
 * space (log-sum-exp over exact terms) for numerical stability.
 */
export function binomialOneSidedPValue(k: number, n: number, p0: number): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0) {
    throw new Error(`binomialOneSidedPValue: invalid k=${k}, n=${n}`);
  }
  if (!(p0 >= 0 && p0 <= 1)) {
    throw new Error(`binomialOneSidedPValue: p0 must be in [0, 1], got ${p0}`);
  }
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p0 === 0) return 0; // k >= 1 but X is always 0
  if (p0 === 1) return 1; // X is always n >= k

  const logP = Math.log(p0);
  const logQ = Math.log(1 - p0);
  const logNFact = logGamma(n + 1);

  const logTerms: number[] = [];
  let maxLog = -Infinity;
  for (let i = k; i <= n; i++) {
    const logTerm = logNFact - logGamma(i + 1) - logGamma(n - i + 1) + i * logP + (n - i) * logQ;
    logTerms.push(logTerm);
    if (logTerm > maxLog) {
      maxLog = logTerm;
    }
  }
  let sum = 0;
  for (const logTerm of logTerms) {
    sum += Math.exp(logTerm - maxLog);
  }
  const p = Math.exp(maxLog) * sum;
  return Math.min(1, Math.max(0, p));
}
