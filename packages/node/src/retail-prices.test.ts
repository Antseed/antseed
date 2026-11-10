import { describe, expect, it } from 'vitest';
import { parseRetailPrices } from './retail-prices.js';

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
});
