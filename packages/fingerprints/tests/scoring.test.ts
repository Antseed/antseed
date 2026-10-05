import { describe, expect, it } from 'vitest';
import { computeMatchVector, matchesTolerance } from '../src/verifiers/kbf/scoring.js';
import type { KbfProbe } from '../src/types.js';

function makeProbe(overrides: Partial<KbfProbe> = {}): KbfProbe {
  return {
    id: 'chemistry_mp:test',
    name: 'test',
    domain: 'chemistry_mp',
    template: 'The melting point of {name} is ___°C.',
    consensus: 1000,
    range: [-300, 4000],
    tolerance: { mode: 'absolute', value: 5 },
    ...overrides,
  };
}

describe('matchesTolerance', () => {
  it('absolute mode: within, boundary-exact, and outside', () => {
    const probe = makeProbe();
    expect(matchesTolerance(1000, probe)).toBe(true);
    expect(matchesTolerance(1003, probe)).toBe(true);
    expect(matchesTolerance(1005, probe)).toBe(true); // boundary-exact inclusive
    expect(matchesTolerance(995, probe)).toBe(true); // lower boundary
    expect(matchesTolerance(1005.0001, probe)).toBe(false);
    expect(matchesTolerance(994.9, probe)).toBe(false);
  });

  it('relative mode: scaled by |consensus|', () => {
    const probe = makeProbe({ consensus: 200, tolerance: { mode: 'relative', value: 0.01 } });
    expect(matchesTolerance(202, probe)).toBe(true); // exactly 1%
    expect(matchesTolerance(198, probe)).toBe(true);
    expect(matchesTolerance(202.1, probe)).toBe(false);
  });

  it('relative mode with negative consensus uses absolute magnitude', () => {
    const probe = makeProbe({
      consensus: -400,
      range: [-1000, 0],
      tolerance: { mode: 'relative', value: 0.01 },
    });
    expect(matchesTolerance(-400, probe)).toBe(true);
    expect(matchesTolerance(-404, probe)).toBe(true); // exactly 1% of 400
    expect(matchesTolerance(-405, probe)).toBe(false);
  });

  it('zero tolerance requires exact match', () => {
    const probe = makeProbe({ consensus: 46, tolerance: { mode: 'absolute', value: 0 } });
    expect(matchesTolerance(46, probe)).toBe(true);
    expect(matchesTolerance(47, probe)).toBe(false);
  });
});

describe('computeMatchVector', () => {
  const probes = [
    makeProbe({ id: 'p1', consensus: 1000 }),
    makeProbe({ id: 'p2', consensus: 46, range: [2, 200], tolerance: { mode: 'absolute', value: 0 } }),
    makeProbe({ id: 'p3', consensus: 300, tolerance: { mode: 'relative', value: 0.01 } }),
  ];

  it('scores match, mismatch, and unparseable entries', () => {
    expect(computeMatchVector([1002, 48, 302], probes)).toEqual([1, 0, 1]);
  });

  it('counts missing answers as discrepancies', () => {
    expect(computeMatchVector([null, 46, null], probes)).toEqual([0, 1, 0]);
  });

  it('counts finite out-of-range answers as discrepancies', () => {
    expect(computeMatchVector([9999, 1, 300], probes)).toEqual([0, 0, 1]);
  });

  it('accepts range-boundary values as parseable', () => {
    // range for p1 is [-300, 4000]
    expect(computeMatchVector([4000, 46, 300], probes)).toEqual([0, 1, 1]);
    expect(computeMatchVector([-300, 46, 300], probes)).toEqual([0, 1, 1]);
  });

  it('throws on length mismatch', () => {
    expect(() => computeMatchVector([1], probes)).toThrow(/length/);
  });
});
