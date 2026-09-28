import { describe, expect, it } from 'vitest';
import { GesundaiDevRouter, GESUNDAI_TARGET, findGesundaiOffer } from '../scripts/gesundai-router.mjs';
import { validateRoutingResponse } from '../../plugins/router-levanto/src/validation.js';

const offer = { ...GESUNDAI_TARGET, inputUsdPerMillion: 0.65, outputUsdPerMillion: 3.25,
  cachedInputUsdPerMillion: 0.07, effectiveReputationScore: 70 };
const input = { v: 1, preferences: { cqt: '5' }, service: 'levanto-route', inputMessage: 'Hello', promptTokens: 2,
  expectedCachedTokens: [], constraints: { allowedPeerIds: [GESUNDAI_TARGET.peerId], allowedCandidates: [GESUNDAI_TARGET] } };
const request = (body: unknown) => ({ requestId: 'test', method: 'POST', path: '/_antseed/levanto-route',
  headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) });
const json = (response: { body: Uint8Array }) => JSON.parse(Buffer.from(response.body).toString());

describe('standalone GesundAI development router', () => {
  it('advertises and enforces v1 exact candidates without looking up or charging excluded inference', async () => {
    let lookups = 0;
    const provider = new GesundaiDevRouter(async () => { lookups++; return offer; });
    const catalog = provider.routingCatalog;
    expect(catalog.models).toEqual([{ provider: GESUNDAI_TARGET.provider, serviceId: GESUNDAI_TARGET.serviceId }]);
    const body = { ...input, catalogRevision: catalog.revision };
    const response = await provider.handleRequest(request(body));
    expect(response.statusCode).toBe(200);
    expect(validateRoutingResponse(json(response), body)).toEqual([{ peer: GESUNDAI_TARGET.peerId, model: GESUNDAI_TARGET.serviceId, provider: GESUNDAI_TARGET.provider }]);
    expect((await provider.handleRequest(request({ ...body, catalogRevision: `0x${'0'.repeat(64)}` }))).statusCode).toBe(409);
    expect((await provider.handleRequest(request({ ...body, constraints: { allowedCandidates: [{ ...GESUNDAI_TARGET, provider: 'impostor' }] } }))).statusCode).toBe(422);
    expect(lookups).toBe(1);
  });
  it('returns only the exact GesundAI Astra target at every CQT, with real advertised prices', async () => {
    const provider = new GesundaiDevRouter(async () => offer);
    expect(provider.serviceUnitBillingModels['levanto-route']['levanto-routing'].components[0].priceUsd).toBe(0);
    for (const cqt of [1, 3, 5, 7, 9]) {
      const body = { ...input, preferences: { cqt: String(cqt) } };
      const response = await provider.handleRequest(request(body));
      expect(response.statusCode).toBe(200);
      expect(validateRoutingResponse(json(response), body)).toEqual([{ peer: GESUNDAI_TARGET.peerId, model: 'gpt-6-astra', provider: GESUNDAI_TARGET.provider }]);
      expect(json(response).ranked[0].price).toEqual({ inUsdPerM: 0.65, outUsdPerM: 3.25, cachedInUsdPerM: 0.07 });
    }
  });

  it.each([
    { allowedPeerIds: [] }, { allowedPeerIds: ['a'.repeat(40)] }, { blockedPeerIds: [GESUNDAI_TARGET.peerId] },
    { maxInputUsdPerMillion: 0.1 }, { minTrustScore: 99 },
  ])('does not substitute another peer when the target violates %j', async (constraints) => {
    const response = await new GesundaiDevRouter(async () => offer).handleRequest(request({ ...input, constraints: { ...input.constraints, ...constraints } }));
    expect(response.statusCode).toBe(503);
    expect(json(response).ranked).toBeUndefined();
  });

  it.each([undefined, { ...offer, peerId: 'b'.repeat(40) }, { ...offer, serviceId: 'other' },
    { ...offer, inputUsdPerMillion: undefined }])('rejects missing or mismatched offers', async (value) => {
    expect((await new GesundaiDevRouter(async () => value).handleRequest(request(input))).statusCode).toBe(503);
  });

  it('rejects malformed input and reports a catalog outage without returning a recommendation', async () => {
    const provider = new GesundaiDevRouter(async () => { throw new Error('Catalog offline'); });
    expect((await provider.handleRequest(request({ ...input, preferences: { cqt: '2' } }))).statusCode).toBe(400);
    expect((await provider.handleRequest({ ...request(input), body: Buffer.from('{invalid') })).statusCode).toBe(400);
    expect((await provider.handleRequest({ ...request(input), path: '/other' })).statusCode).toBe(404);
    expect(json(await provider.handleRequest(request(input)))).toEqual({ error: 'Catalog offline' });
  });

  it('matches catalog offers by exact peer/provider/service, not an impersonated display name', () => {
    const impostor = { ...offer, peerId: 'f'.repeat(40), displayName: 'GesundAI' };
    expect(findGesundaiOffer({ data: [{ peers: [impostor] }] })).toBeUndefined();
    expect(findGesundaiOffer({ data: [{ peers: [impostor, offer] }] })).toEqual(offer);
  });
});
