import { describe, expect, it } from 'vitest';
import type { UnitBillingContext, UnitBillingModelV1 } from '@antseed/protocol/billing';
import {
  estimateUnitRequestCost,
  isUnitBilledProtocol,
  validateUnitBillingModelForProtocolV1,
} from './unit-billing.js';

const imageContext: UnitBillingContext = {
  sellerPeerId: 'a'.repeat(40),
  provider: 'openai',
  service: 'image',
  serviceApiProtocol: 'openai-images',
};

describe('unit billing adapters', () => {
  it('routes image billing through the image adapter', () => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };

    expect(isUnitBilledProtocol('openai-images')).toBe(true);
    expect(isUnitBilledProtocol('openai-responses')).toBe(false);
    expect(validateUnitBillingModelForProtocolV1('openai-images', model)).toEqual([]);
    expect(estimateUnitRequestCost(model, imageContext, { units: { output_images: 2 } })).toBe(80_000n);
  });

  it.each([
    ['completed_requests', 'completed-request billing is not implemented'],
    ['video_generations', 'video billing is not implemented'],
    ['video_seconds', 'video billing is not implemented'],
  ] as const)('fails closed for reserved %s billing', (unit, message) => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit, priceUsd: 0.1 }] };

    expect(validateUnitBillingModelForProtocolV1('openai-images', model)).toEqual([message]);
    expect(() => estimateUnitRequestCost(model, imageContext, { units: { [unit]: 1 } })).toThrow(message);
  });
});
