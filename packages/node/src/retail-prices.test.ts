import { describe, expect, it } from 'vitest';
import { parseRetailPrices, retailTokenCostUsd } from './retail-prices.js';

describe('parseRetailPrices', () => {
  it('reads per-token prices as per million, keyed by both id and name', () => {
    const prices = parseRetailPrices({ data: [
      { id: 'openai/gpt-4o', name: 'GPT-4o', pricing: { prompt: '0.00001', completion: '0.00003', input_cache_read: '0.000001' } },
      { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
    ] });
    expect(prices?.get('gpt4o')).toEqual({ input: 10, output: 30, cachedInput: 1 });
    expect(prices?.size).toBe(1);
  });

  it('is null for a malformed or unpriced list', () => {
    expect(parseRetailPrices({ data: 'x' })).toBeNull();
    expect(parseRetailPrices({ data: [{ id: 'a', pricing: null }] })).toBeNull();
  });

  it('prices cached input apart, falling back to the input price', () => {
    // 1M input of which 0.5M cached, 1M output at $10 / $1 cached / $30.
    expect(retailTokenCostUsd(1_000_000, 500_000, 1_000_000, { input: 10, output: 30, cachedInput: 1 })).toBeCloseTo(35.5);
    expect(retailTokenCostUsd(1_000_000, 2_000_000, 0, { input: 10, output: null, cachedInput: null })).toBeCloseTo(10);
  });
});
