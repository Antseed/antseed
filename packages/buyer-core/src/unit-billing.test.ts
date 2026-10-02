import { describe, expect, it } from 'vitest';
import type { UnitBillingContext, UnitBillingModelV1 } from '@antseed/protocol/billing';
import {
  computeFinalUnitBilling,
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

  it('bills one completed request per well-formed routing response', () => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] };
    const context: UnitBillingContext = { ...imageContext, serviceApiProtocol: 'model-routing', unitLimits: { completed_requests: 1 } };
    const response = (statusCode: number, body: unknown) => ({
      requestId: 'r', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const ranked = { version: 1, recommendations: [{ model: 'm', peer: 'p', provider: 'openai' }] };

    expect(isUnitBilledProtocol('model-routing')).toBe(true);
    expect(validateUnitBillingModelForProtocolV1('model-routing', model)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('openai-images', model)).toEqual(['completed_requests is not supported for openai-images']);
    expect(computeFinalUnitBilling(model, context, response(200, ranked)).costUsdc).toBe(1_000n);
    expect(computeFinalUnitBilling(model, context, response(200, { version: 1, recommendations: [] })).costUsdc).toBe(0n);
    expect(computeFinalUnitBilling(model, context, response(200, 'garbage')).costUsdc).toBe(0n);
    expect(computeFinalUnitBilling(model, context, response(500, ranked)).costUsdc).toBe(0n);
  });

  it.each([
    ['video_generations', 'video billing is not implemented'],
    ['video_seconds', 'video billing is not implemented'],
  ] as const)('fails closed for reserved %s billing', (unit, message) => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit, priceUsd: 0.1 }] };

    expect(validateUnitBillingModelForProtocolV1('openai-images', model)).toEqual([message]);
    expect(() => estimateUnitRequestCost(model, imageContext, { units: { [unit]: 1 } })).toThrow(message);
  });
});
