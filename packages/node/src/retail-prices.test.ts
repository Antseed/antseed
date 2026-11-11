import { describe, expect, it } from 'vitest';
import { canonicalModelKey } from './model-identity.js';
import { parseRetailPrices, retailTokenCostUsd, totalRetailUsage } from './retail-prices.js';

describe('parseRetailPrices', () => {
  it('reads per-token prices as per million, keyed by both id and name', () => {
    const prices = parseRetailPrices({ data: [
      { id: 'openai/gpt-4o', name: 'GPT-4o', pricing: { prompt: '0.00001', completion: '0.00003', input_cache_read: '0.000001' } },
      { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
    ] });
    expect(prices?.get('gpt4o')).toEqual({ input: 10, output: 30, cachedInput: 1 });
    expect(prices?.size).toBe(1);
  });

  it('keeps an explicit free cache-read price, so cached tokens cost nothing', () => {
    const prices = parseRetailPrices({ data: [{ id: 'm', pricing: { prompt: '0.00001', completion: '0.00003', input_cache_read: '0' } }] });
    const price = prices?.get('m');
    expect(price).toEqual({ input: 10, output: 30, cachedInput: 0 });
    expect(retailTokenCostUsd(1_000_000, 1_000_000, 0, price!)).toBe(0);
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

describe('parseRetailPrices with malformed fields', () => {
  it('skips a bad field and keeps the valid rows, and keeps an explicit free cache read', () => {
    const prices = parseRetailPrices({ data: [
      { id: 'vendor/bad-object', pricing: { prompt: { toString: null }, completion: '0.000002' } },
      { id: 'vendor/huge', pricing: { prompt: 1e308, completion: '0.000001' } },
      { id: 'vendor/good', pricing: { prompt: '0.000001', completion: '0.000003', input_cache_read: '0' } },
    ] });
    const bad = prices?.get(canonicalModelKey('vendor/bad-object'));
    expect(bad?.input).toBeNull();
    expect(bad?.output).toBeCloseTo(2);
    const huge = prices?.get(canonicalModelKey('vendor/huge'));
    expect(huge?.input).toBeNull();
    expect(huge?.output).toBeCloseTo(1);
    const good = prices?.get(canonicalModelKey('vendor/good'));
    expect(good?.input).toBeCloseTo(1);
    expect(good?.output).toBeCloseTo(3);
    expect(good?.cachedInput).toBe(0);
  });
});

describe('totalRetailUsage', () => {
  const prices = new Map([[canonicalModelKey('vendor/model-a'), { input: 1, output: 2, cachedInput: null }]]);
  const names = new Map([['0xaa', 'vendor/model-a'], ['0xbb', 'vendor/unpriced']]);

  it('totals matched services only, counting free usage at $0 paid', () => {
    const totals = totalRetailUsage([
      { serviceIdHash: '0xAA', amountUsdc: '500000', inputTokens: '1000000', cachedInputTokens: '0', outputTokens: 500_000, requestCount: 3 },
      { serviceIdHash: '0xaa', amountUsdc: 0, inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, requestCount: 1 },
      { serviceIdHash: '0xbb', amountUsdc: '900000', inputTokens: '1000000', cachedInputTokens: '0', outputTokens: '0', requestCount: 5 },
    ], names, prices);
    expect(totals).toEqual({ retailUsd: 3, paidUsd: 0.5, matchedServices: 2, matchedRequests: 4 });
  });

  it('is null when nothing matched or nothing costs anything at retail', () => {
    expect(totalRetailUsage([], names, prices)).toBeNull();
    expect(totalRetailUsage([{ serviceIdHash: '0xaa', amountUsdc: '1', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0' }], names, prices)).toBeNull();
  });
});
