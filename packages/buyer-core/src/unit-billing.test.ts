import { describe, expect, it } from 'vitest';
import type { UnitBillingContext, UnitBillingModelV1 } from '@antseed/protocol/billing';
import { validateUnitBillingUsage } from '@antseed/protocol/billing';
import {
  captureUnitBillingContext,
  computeFinalUnitBilling,
  estimateUnitRequestCost,
  isUnitBilledProtocol,
  validateUnitBillingModelForProtocolV1,
} from './unit-billing.js';

const videoModel: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] };
const response = (body: object, statusCode = 200) => ({
  requestId: 'request',
  statusCode,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(body)),
});

function capture(
  path = '/api/v1/video/queue',
  body: object = { model: 'wan-2.5', duration: '8s' },
  method = 'POST',
) {
  return captureUnitBillingContext({
    sellerPeerId: 'a'.repeat(40),
    provider: 'venice',
    service: 'wan-2.5',
    serviceApiProtocol: 'venice-video',
    request: {
      requestId: 'request',
      method,
      path,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    },
  });
}

describe('acceptance-based video metering', () => {
  it('bills the requested duration once on acceptance, not on retrieve', () => {
    const captured = capture();
    expect(computeFinalUnitBilling(videoModel, captured.context, response({ queue_id: 'task' }), captured.requestFacts).costUsdc).toBe(800000n);
    const followUp = capture('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: 'task' });
    expect(computeFinalUnitBilling(videoModel, followUp.context, response({ status: 'SUCCEEDED' }), followUp.requestFacts).costUsdc).toBe(0n);
  });

  it('rejects missing duration and unmatched tiers before submission', () => {
    const missing = capture('/api/v1/video/queue', { model: 'wan-2.5' });
    expect(() => estimateUnitRequestCost(videoModel, missing.context, missing.requestUsage)).toThrow(/duration/);
    const captured = capture();
    const tier: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1, match: { resolution: '1080p' } }] };
    expect(() => estimateUnitRequestCost(tier, captured.context, captured.requestUsage)).toThrow(/No billing component/);
  });

  it('allows fixed per-generation prices without duration', () => {
    const captured = capture('/api/v1/video/queue', { model: 'wan-2.5' });
    const fixed: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.5 }] };
    expect(computeFinalUnitBilling(fixed, captured.context, response({ queue_id: 'task' }), captured.requestFacts).costUsdc).toBe(500000n);
  });

  it('charges zero for rejected or malformed acceptances and rejects inflated reports', () => {
    const captured = capture();
    for (const rejected of [response({ queue_id: 'task' }, 400), response({}), response({ queue_id: 'task', error: 'failed' })]) {
      expect(computeFinalUnitBilling(videoModel, captured.context, rejected, captured.requestFacts).costUsdc).toBe(0n);
    }
    expect(() => validateUnitBillingUsage(
      videoModel,
      captured.context,
      { version: 1, units: { video_seconds: '9' } },
      900000n,
      1,
      { units: { video_seconds: 8 } },
    )).toThrow();
  });
});

describe('unit billing adapters', () => {
  const imageContext: UnitBillingContext = {
    sellerPeerId: 'a'.repeat(40),
    provider: 'openai',
    service: 'image',
    serviceApiProtocol: 'openai-images',
  };

  it('routes image and Venice video billing through their adapters', () => {
    const image: UnitBillingModelV1 = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };

    expect(isUnitBilledProtocol('openai-images')).toBe(true);
    expect(isUnitBilledProtocol('venice-video')).toBe(true);
    expect(isUnitBilledProtocol('openai-responses')).toBe(false);
    expect(validateUnitBillingModelForProtocolV1('openai-images', image)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('venice-video', videoModel)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('openai-images', videoModel)).toEqual(['video_seconds is not supported for openai-images']);
    expect(estimateUnitRequestCost(image, imageContext, { units: { output_images: 2 } })).toBe(80_000n);
  });

  it('fails closed for completed-request billing', () => {
    const completed: UnitBillingModelV1 = { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.1 }] };
    expect(validateUnitBillingModelForProtocolV1('openai-images', completed)).toEqual(['completed-request billing is not implemented']);
    expect(() => estimateUnitRequestCost(completed, imageContext, { units: { completed_requests: 1 } })).toThrow('completed-request billing is not implemented');
  });
});
