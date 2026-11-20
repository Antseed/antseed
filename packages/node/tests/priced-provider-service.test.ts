import { describe, expect, it } from 'vitest';
import { isPricedProviderService } from '../src/index.js';

const zero = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
const unit = (priceUsd: number) => ({ 'irp-suggest': { version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd }] } });

describe('isPricedProviderService', () => {
  it('uses the service rates, else the provider defaults, including cached input', () => {
    expect(isPricedProviderService({ pricing: { defaults: zero, services: { a: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 0 } } } }, 'a')).toBe(true);
    expect(isPricedProviderService({ pricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } } }, 'b')).toBe(true);
    expect(isPricedProviderService({ pricing: { defaults: { ...zero, cachedInputUsdPerMillion: 0.1 } } }, 'c')).toBe(true);
    expect(isPricedProviderService({ pricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 }, services: { d: zero } } }, 'd')).toBe(false);
  });

  it('counts a non-free unit billing model with zero token rates', () => {
    expect(isPricedProviderService({ pricing: { defaults: zero }, serviceUnitBillingModels: { r: unit(0.001) } }, 'r')).toBe(true);
    expect(isPricedProviderService({ pricing: { defaults: zero }, serviceUnitBillingModels: { r: unit(0) } }, 'r')).toBe(false);
    expect(isPricedProviderService({ pricing: { defaults: zero }, serviceUnitBillingModels: { other: unit(1) } }, 'r')).toBe(false);
  });
});
