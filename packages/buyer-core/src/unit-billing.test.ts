import { describe, it, expect } from 'vitest';
import { captureUnitBillingContext, computeFinalUnitBilling, estimateUnitRequestCost } from './unit-billing.js';
import { validateUnitBillingUsage, type UnitBillingModelV1 } from '@antseed/protocol/billing';

const model: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] };
const response = (body: object, statusCode = 200) => ({ requestId: 'request', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
function capture(path = '/api/v3/contents/generations/tasks', body: object = { model: 'seedance-2-0', duration: 8 }, method = 'POST') {
  return captureUnitBillingContext({ sellerPeerId: 'a'.repeat(40), provider: 'seedance', service: 'seedance-2-0', serviceApiProtocol: 'seedance-video', request: { requestId: 'request', method, path, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) } });
}

describe('acceptance-based video metering', () => {
  it('bills the requested duration once on acceptance, not on status or cancellation', () => {
    const captured = capture();
    expect(computeFinalUnitBilling(model, captured.context, response({ id: 'task' }), captured.requestFacts).costUsdc).toBe(800000n);
    for (const method of ['GET', 'DELETE']) {
      const followUp = capture('/api/v3/contents/generations/tasks/task', {}, method);
      expect(computeFinalUnitBilling(model, followUp.context, response({ id: 'task', status: 'SUCCEEDED' }), followUp.requestFacts).costUsdc).toBe(0n);
    }
  });

  it('rejects missing duration for per-second pricing and unmatched tiers before submission', () => {
    const missing = capture('/api/v3/contents/generations/tasks', { model: 'seedance-2-0' });
    expect(() => estimateUnitRequestCost(model, missing)).toThrow(/duration/);
    const captured = capture();
    const tier: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1, match: { resolution: '1080p' } }] };
    expect(() => estimateUnitRequestCost(tier, captured)).toThrow(/No billing component/);
  });

  it('allows fixed per-generation prices without duration', () => {
    const captured = capture('/api/v3/contents/generations/tasks', { model: 'seedance-2-0' });
    const fixed: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.5 }] };
    expect(computeFinalUnitBilling(fixed, captured.context, response({ id: 'task' }), captured.requestFacts).costUsdc).toBe(500000n);
  });

  it('charges zero for rejections and malformed acceptance, and rejects inflated reports', () => {
    const captured = capture();
    for (const rejected of [response({ id: 'task' }, 400), response({}), response({ id: 'task', error: 'failed' })]) {
      expect(computeFinalUnitBilling(model, captured.context, rejected, captured.requestFacts).costUsdc).toBe(0n);
    }
    expect(() => validateUnitBillingUsage(model, captured.context, { version: 1, units: { video_seconds: '9' } }, 900000n, 1, { units: { video_seconds: 8 } })).toThrow();
  });

  it('multiplies Veo duration by requested video count', () => {
    const captured = capture('/v1beta/models/veo:predictLongRunning', { instances: [{ prompt: 'cat' }], parameters: { durationSeconds: '8', numberOfVideos: 2 } });
    expect(computeFinalUnitBilling(model, captured.context, response({ name: 'operations/job' }), captured.requestFacts).costUsdc).toBe(1600000n);
  });

  it('charges nothing for a seller replay of an already-accepted create', () => {
    const captured = capture();
    const replay = { ...response({ id: 'task' }), headers: { 'x-antseed-idempotent-replay': 'true' } };
    expect(computeFinalUnitBilling(model, captured.context, replay, captured.requestFacts).costUsdc).toBe(0n);
  });
});
