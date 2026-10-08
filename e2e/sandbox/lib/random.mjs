import { createHash } from 'node:crypto';

/** 32-bit seed from any mix of values; the same parts always give the same seed. */
export function deriveSeed(...parts) {
  return createHash('sha256').update(parts.map(String).join('\u0000')).digest().readUInt32LE(0);
}

/** Seeded PRNG (mulberry32). Never use Math.random in the sandbox: runs must be reproducible per seed. */
export function createRng(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  return {
    next,
    chance(p) { return p > 0 && next() < p; },
    uniform(min, max) { return min + (max - min) * next(); },
    int(min, max) { return Math.floor(min + (max - min + 1) * next()); },
    normal() {
      if (spare !== null) { const value = spare; spare = null; return value; }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const radius = Math.sqrt(-2 * Math.log(u));
      spare = radius * Math.sin(2 * Math.PI * v);
      return radius * Math.cos(2 * Math.PI * v);
    },
    exponential(rate) {
      let u = 0;
      while (u === 0) u = next();
      return -Math.log(u) / rate;
    },
    pick(weights) {
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let target = next() * total;
      for (let index = 0; index < weights.length; index += 1) {
        target -= weights[index];
        if (target < 0) return index;
      }
      return weights.length - 1;
    },
  };
}

const Z99 = 2.3263478740408408;

/**
 * Distribution spec: a number (fixed), { type: 'fixed', value }, { type: 'uniform', min, max }
 * or { type: 'lognormal', median, p99 } (p99 >= median). Optional min/max clamp on any type.
 */
export function normalizeDist(spec, label, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const finite = (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}${name ? `.${name}` : ''} must be a number in ${min}..${max}`);
    return value;
  };
  let dist;
  if (typeof spec === 'number') dist = { type: 'fixed', value: finite(spec) };
  else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    const type = spec.type ?? (spec.median !== undefined ? 'lognormal' : spec.value !== undefined ? 'fixed' : 'uniform');
    if (type === 'fixed') dist = { type, value: finite(spec.value, 'value') };
    else if (type === 'uniform') {
      dist = { type, min: finite(spec.min, 'min'), max: finite(spec.max, 'max') };
      if (dist.max < dist.min) throw new Error(`${label}.max must be >= min`);
    } else if (type === 'lognormal') {
      dist = { type, median: finite(spec.median, 'median'), p99: finite(spec.p99 ?? spec.median, 'p99') };
      if (dist.median <= 0 || dist.p99 < dist.median) throw new Error(`${label} lognormal needs median > 0 and p99 >= median`);
    } else throw new Error(`${label}.type must be fixed, uniform or lognormal`);
    for (const bound of ['clampMin', 'clampMax']) if (spec[bound] !== undefined) dist[bound] = finite(spec[bound], bound);
  } else throw new Error(`${label} must be a number or a distribution object`);
  if (integer) dist.integer = true;
  return dist;
}

export function sampleDist(dist, rng) {
  let value;
  if (dist.type === 'fixed') value = dist.value;
  else if (dist.type === 'uniform') value = dist.integer ? rng.int(Math.ceil(dist.min), Math.floor(dist.max)) : rng.uniform(dist.min, dist.max);
  else {
    const sigma = Math.log(dist.p99 / dist.median) / Z99;
    value = dist.median * Math.exp(sigma * rng.normal());
  }
  if (dist.clampMin !== undefined) value = Math.max(dist.clampMin, value);
  if (dist.clampMax !== undefined) value = Math.min(dist.clampMax, value);
  return dist.integer ? Math.max(0, Math.round(value)) : value;
}

/** Zipf weights for ranks 1..n with exponent s (s = 0 is uniform). */
export function zipfWeights(n, s = 1) {
  return Array.from({ length: n }, (_, index) => 1 / (index + 1) ** s);
}
