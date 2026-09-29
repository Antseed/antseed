import { describe, expect, it } from 'vitest';
import {
  UNIT_BILLING_UNIT_IDS_V1,
  completedRequestPrice, evaluateUnitBilling, parseMicroUsdc,
  unitUsageFromReport, unitUsageToBillingReport,
  validateUnitBillingModelV1, validateUnitBillingUsage, validateUnitBillingUsageReportV1,
  type UnitBillingContext, type UnitBillingModelV1, type UnitBillingUsageReportV1,
} from './billing.js';
import { WELL_KNOWN_SERVICE_API_PROTOCOLS } from './service-api.js';

const context: UnitBillingContext = {
  sellerPeerId: 'a'.repeat(40), provider: 'router', service: 'route',
  serviceApiProtocol: 'levanto-routing', unitLimits: { completed_requests: 1 },
};

describe('shared unit billing', () => {
  it.each(['0', '1', '1000', '40000'])('computes %s micro-USDC exactly', price => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit: 'completed_requests', priceUsd: Number(price) / 1_000_000 }] };
    expect(completedRequestPrice(model)).toBe(BigInt(price));
    expect(evaluateUnitBilling(model, context, { units: { completed_requests: 1 } })).toBe(BigInt(price));
    expect(evaluateUnitBilling(model, context, { units: { completed_requests: 0 } })).toBe(0n);
  });
  it.each([undefined, null, 1000, '01', '-1', '0.1', '1e3', '9007199254740992'])('rejects malformed price %s', price => {
    expect(() => parseMicroUsdc(price as string)).toThrow();
  });
  it('preserves image v1 calculation and report shapes', () => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };
    const usage = { units: { output_images: 2 } };
    expect(evaluateUnitBilling(model, { ...context, serviceApiProtocol: 'openai-images' }, usage)).toBe(80000n);
    expect(unitUsageToBillingReport(usage)).toEqual({ version: 1, units: { output_images: '2' } });
    expect(validateUnitBillingModelV1({ version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] })).toEqual([]);
    expect(unitUsageToBillingReport({ units: { completed_requests: 1 } })).toEqual({ version: 1, units: { completed_requests: '1' } });
  });
  it.each([{}, { version: 2, components: [] }, { version: 2, components: [{ unit: 'output_images', priceMicroUsdc: '1000' }] }, { version: 2, components: [{ unit: 'completed_requests', priceMicroUsdc: 1000 }] }])('rejects invalid models %j', model => {
    expect(validateUnitBillingModelV1(model as UnitBillingModelV1)).not.toEqual([]);
  });
  it.each([{}, { version: 2, units: { completed_requests: '1' } }, { version: 2, units: { output_images: '1' } }, { version: 1, units: { completed_requests: '2' } }, { version: 1, units: { completed_requests: 1 } }, { version: 1, units: { completed_requests: '1', output_images: '1' } }])('rejects malformed reports %j', report => {
    expect(validateUnitBillingUsageReportV1(report as UnitBillingUsageReportV1)).not.toEqual([]);
    expect(() => unitUsageFromReport(report as UnitBillingUsageReportV1)).toThrow();
  });
  it('rejects request prices that change charge after metadata encoding', () => {
    expect(() => completedRequestPrice({ version: 1, components: [{ unit: 'completed_requests', priceUsd: 16777217 / 1_000_000 }] })).toThrow('float32');
    expect(() => completedRequestPrice({ version: 1, components: [{ unit: 'completed_requests', priceUsd: 9007199254740991 / 1_000_000 }] })).toThrow('float32');
  });
  it('rejects mixed units and request matching rules', () => {
    const component = { unit: 'completed_requests' as const, priceUsd: 0.001 };
    expect(validateUnitBillingModelV1({ version: 1, components: [component, { unit: 'output_images', priceUsd: 0.04 }] })).not.toEqual([]);
    expect(validateUnitBillingModelV1({ version: 1, components: [{ ...component, match: { model: 'route' } }] })).not.toEqual([]);
  });
  it('enforces observed usage, request limits, report version and exact price', () => {
    const model = { version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd: 0.001 }] };
    const usage = { units: { completed_requests: 1 } };
    const report = unitUsageToBillingReport(usage);
    expect(validateUnitBillingUsage(model, context, report, 1000n, 1.4, usage)).toBe(1000n);
    for (const cost of [999n, 1001n]) expect(() => validateUnitBillingUsage(model, context, report, cost, 1.4, usage)).toThrow();
    expect(() => validateUnitBillingUsage(model, context, report, 1000n, 1.4)).toThrow('observed');
    expect(() => validateUnitBillingUsage(model, context, { version: 1, units: { output_images: '1' } }, 1000n, 1.4, usage)).toThrow('model');
    expect(() => evaluateUnitBilling(model, { ...context, unitLimits: { completed_requests: 0 } }, usage)).toThrow();
    expect(() => evaluateUnitBilling(model, context, { units: { completed_requests: 2 } })).toThrow();
    expect(() => unitUsageToBillingReport({ units: { completed_requests: 1, output_images: 1 } })).toThrow();
  });
});

describe('unit billing registry', () => {
  it('keeps stable metadata ids for billing units', () => {
    expect(UNIT_BILLING_UNIT_IDS_V1).toEqual({
      output_images: 0,
      completed_requests: 1,
      video_generations: 2,
      video_seconds: 3,
    });
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
