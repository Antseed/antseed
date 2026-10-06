import { describe, expect, it } from 'vitest';
import { validateRoutingRankResponse } from '@antseed/node';
import { GesundaiDevRouter, GESUNDAI_TARGET, findGesundaiOffer } from '../scripts/gesundai-router.mjs';

const offer = { ...GESUNDAI_TARGET, inputUsdPerMillion: 0.65, outputUsdPerMillion: 3.25,
  cachedInputUsdPerMillion: 0.07, effectiveReputationScore: 70 };
const candidate = { id: `${GESUNDAI_TARGET.provider}:${GESUNDAI_TARGET.serviceId}@${GESUNDAI_TARGET.peerId}`,
  model: GESUNDAI_TARGET.serviceId, pricing: { input: 0.65, cache_read: 0.07, output: 3.25 } };
const input = { request: { messages: [{ role: 'user', content: 'Hello' }] }, routing: { candidates: [candidate] } };
const request = (body: unknown) => ({ requestId: 'test', method: 'POST', path: '/v1/routing/rank',
  headers: { 'content-type': 'application/json', 'x-antseed-service': 'levanto-route' }, body: Buffer.from(JSON.stringify(body)) });
const json = (response: { body: Uint8Array }) => JSON.parse(Buffer.from(response.body).toString());

describe('standalone GesundAI development router', () => {
  it('lists IRP models and never looks up excluded inference candidates', async () => {
    let lookups = 0;
    const provider = new GesundaiDevRouter(async () => { lookups++; return offer; });
    const models = await provider.handleRequest({ ...request({}), method: 'GET', path: '/v1/routing/models' });
    expect(json(models)).toEqual({ object: 'list', data: [{ id: GESUNDAI_TARGET.serviceId, object: 'model' }] });
    const response = await provider.handleRequest(request(input));
    expect(response.statusCode).toBe(200);
    expect(validateRoutingRankResponse(json(response), [candidate])).toEqual([{ candidate_id: candidate.id }]);
    expect((await provider.handleRequest(request({ ...input, routing: { candidates: [{ ...candidate, id: 'impostor' }] } }))).statusCode).toBe(422);
    expect(lookups).toBe(1);
  });

  it.each([0, 1, 5, 9, 10, undefined])('ranks the exact target at IRP costQualityTradeoff %s', async (cost_quality_tradeoff) => {
    const provider = new GesundaiDevRouter(async () => offer);
    expect(provider.serviceUnitBillingModels['levanto-route']['model-routing'].components[0].priceUsd).toBe(0);
    const response = await provider.handleRequest(request({ ...input, routing: { ...input.routing, cost_quality_tradeoff } }));
    expect(response.statusCode).toBe(200);
    expect(validateRoutingRankResponse(json(response), [candidate])).toEqual([{ candidate_id: candidate.id }]);
  });

  it.each([undefined, { ...offer, peerId: 'b'.repeat(40) }, { ...offer, serviceId: 'other' },
    { ...offer, inputUsdPerMillion: undefined }])('rejects missing or mismatched offers', async (value) => {
    expect((await new GesundaiDevRouter(async () => value).handleRequest(request(input))).statusCode).toBe(503);
  });

  it('rejects malformed input and reports an outage without returning a recommendation', async () => {
    const provider = new GesundaiDevRouter(async () => { throw new Error('Catalog offline'); });
    expect((await provider.handleRequest(request({ ...input, routing: { ...input.routing, cost_quality_tradeoff: 11 } }))).statusCode).toBe(400);
    expect((await provider.handleRequest({ ...request(input), body: Buffer.from('{invalid') })).statusCode).toBe(400);
    expect((await provider.handleRequest({ ...request(input), path: '/other' })).statusCode).toBe(404);
    expect(json(await provider.handleRequest(request(input)))).toEqual({ detail: 'Catalog offline' });
  });

  it('matches offers by exact peer/provider/service, not an impersonated display name', () => {
    const impostor = { ...offer, peerId: 'f'.repeat(40), displayName: 'GesundAI' };
    expect(findGesundaiOffer({ data: [{ peers: [impostor] }] })).toBeUndefined();
    expect(findGesundaiOffer({ data: [{ peers: [impostor, offer] }] })).toEqual(offer);
  });
});
