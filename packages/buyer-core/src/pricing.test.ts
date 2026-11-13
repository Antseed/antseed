import { describe, it, expect } from 'vitest';
import { computeCostUsdc } from './pricing.js';
import { formatUsdc, parseUsdc } from './usdc-utils.js';

describe('computeCostUsdc', () => {
  const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 };

  it('prices fresh input, cached input, and output separately', () => {
    // 250k fresh * $3/M + 50k cached * $0.30/M + 20k out * $15/M = $1.065 = 1_065_000 base units
    expect(computeCostUsdc(250_000, 20_000, pricing, 50_000)).toBe(1_065_000n);
  });

  it('falls back to the input rate when no cached rate is set', () => {
    const noCachedRate = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    expect(computeCostUsdc(250_000, 20_000, noCachedRate, 50_000)).toBe(1_200_000n);
  });

  it('is zero for zero usage', () => {
    expect(computeCostUsdc(0, 0, pricing)).toBe(0n);
  });
});

describe('usdc-utils', () => {
  it('formats and parses base units', () => {
    expect(formatUsdc(1_500_000n)).toContain('1.5');
    expect(parseUsdc('1.5')).toBe(1_500_000n);
    expect(parseUsdc(formatUsdc(123_456n))).toBe(123_456n);
  });
});
