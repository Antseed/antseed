import { describe, expect, it } from 'vitest';
import { poolYield } from './yield.js';
describe('pool yield', () => {
  it('annualizes a pool average for one completed epoch', () => {
    const y = poolYield(10n, 1000n, 8, 604800, 100, true);
    expect(y.apr).toBeCloseTo(52.142857);
    expect(y.apy).toBeCloseTo((1.01 ** (365 / 7) - 1) * 100);
    expect(y.startsAt).toBe(100 + 8 * 604800);
    expect(y.status).toBe('settled');
  });
  it('uses configured duration and marks estimates', () => {
    expect(poolYield(1n, 100n, 1, 86400, 0, false).apr).toBeCloseTo(365);
    expect(poolYield(1n, 100n, 1, 86400, 0, false).status).toBe('estimated');
  });
  it('distinguishes confirmed zero from unavailable inputs', () => {
    expect(poolYield(0n, 100n, 1, 604800, 0, true).apy).toBe(0);
    for (const [reward, principal] of [[null, 100n], [0n, null], [10n, 0n]] as const) expect(poolYield(reward, principal, 1, 604800, 0, true).status).toBe('unavailable');
    expect(poolYield(10n, 100n, -1, 604800, 0, true).apy).toBeNull();
  });
  it('does not return infinite APY', () => {
    expect(poolYield(10n ** 80n, 1n, 2, 1, 0, true).apy).toBeNull();
  });
});
