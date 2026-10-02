import { describe, expect, it } from 'vitest';
import {
  UNIT_BILLING_UNITS_V1,
  validateUnitBillingUsage,
  type UnitBillingContext,
  type UnitBillingModelV1,
} from './billing.js';
import { WELL_KNOWN_SERVICE_API_PROTOCOLS } from './service-api.js';

describe('unit billing registry', () => {
  it('preserves billing unit positions in metadata', () => {
    expect(UNIT_BILLING_UNITS_V1.slice(0, 4)).toEqual([
      'output_images',
      'completed_requests',
      'video_generations',
      'video_seconds',
    ]);
  });

  it('keeps service API protocol positions append-only', () => {
    expect(WELL_KNOWN_SERVICE_API_PROTOCOLS.slice(0, 6)).toEqual([
      'anthropic-messages',
      'openai-chat-completions',
      'openai-completions',
      'openai-responses',
      'openai-images',
      'typesafe-systemone',
    ]);
  });

  it('validates every reported unit against request limits', () => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };
    const context: UnitBillingContext = {
      sellerPeerId: 'a'.repeat(40),
      provider: 'openai',
      service: 'image',
      serviceApiProtocol: 'openai-images',
      unitLimits: { output_images: 1, video_seconds: 8 },
    };

    expect(() => validateUnitBillingUsage(
      model,
      context,
      { version: 1, units: { video_seconds: '9' } },
      0n,
      1,
      { units: { video_seconds: 9 } },
    )).toThrow('Seller reported video_seconds=9 but request allowed 8');
  });
});
