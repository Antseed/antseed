import { describe, expect, it } from 'vitest';
import type { UnitBillingModelV1 } from '@antseed/protocol/billing';
import {
  captureUnitBillingContext,
  computeFinalUnitBilling,
  estimateUnitRequestCost,
  isUnitBilledProtocol,
  validateUnitBillingModelForProtocolV1,
} from './unit-billing.js';

/** Half a cent per completed call. */
const perCall: UnitBillingModelV1 = { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.005 }] };

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function capture(method: string, path: string) {
  return captureUnitBillingContext({
    sellerPeerId: 'a'.repeat(40),
    provider: 'openapi',
    service: 'flights',
    serviceApiProtocol: 'openapi-data',
    request: { requestId: 'r', method, path, headers: { 'content-type': 'application/json' }, body: json({ from: 'TLV', to: 'LIS' }) },
  });
}

const answer = (statusCode: number, body: Uint8Array = json({ flights: [] })) => ({
  requestId: 'r', statusCode, headers: { 'content-type': 'application/json' }, body,
});

describe('data billing', () => {
  it('bills completed_requests for openapi-data, beside routing', () => {
    expect(isUnitBilledProtocol('openapi-data')).toBe(true);
    expect(validateUnitBillingModelForProtocolV1('openapi-data', perCall)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('irp-suggest', perCall)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('openai-images', perCall)).toEqual(['completed_requests is not supported for openai-images']);
    expect(validateUnitBillingModelForProtocolV1('openapi-data', { version: 1, components: [{ unit: 'input_characters', priceUsd: 0.0001 }] }))
      .toEqual(['input_characters is not supported for openapi-data']);
  });

  it('reserves one call for an operation and nothing for the description', () => {
    const call = capture('POST', '/v1/data/flights/search');
    expect(call.requestUsage).toEqual({ units: { completed_requests: 1 } });
    expect(call.requestFacts).toEqual({ kind: 'data', action: 'call' });
    expect(estimateUnitRequestCost(perCall, call.context, call.requestUsage)).toBe(5_000n);

    const describeRequest = capture('GET', '/v1/data/flights/openapi.json');
    expect(describeRequest.requestUsage).toEqual({ units: {} });
    expect(estimateUnitRequestCost(perCall, describeRequest.context, describeRequest.requestUsage)).toBe(0n);
  });

  it('charges a delivered answer and nothing for an error, an empty answer or the description', () => {
    const call = capture('POST', '/v1/data/flights/search');
    expect(computeFinalUnitBilling(perCall, call.context, answer(200), call.requestFacts).costUsdc).toBe(5_000n);
    expect(computeFinalUnitBilling(perCall, call.context, answer(400, json({ error: 'unknown airport' })), call.requestFacts).costUsdc).toBe(0n);
    expect(computeFinalUnitBilling(perCall, call.context, answer(502), call.requestFacts).costUsdc).toBe(0n);
    expect(computeFinalUnitBilling(perCall, call.context, answer(200, new Uint8Array()), call.requestFacts).costUsdc).toBe(0n);

    const describeRequest = capture('GET', '/v1/data/flights/openapi.json');
    expect(computeFinalUnitBilling(perCall, describeRequest.context, answer(200, json({ openapi: '3.1.0' })), describeRequest.requestFacts).costUsdc).toBe(0n);
  });
});
