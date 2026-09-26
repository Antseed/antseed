import { describe, expect, it } from 'vitest';
import { validateRoutingRequest, validateRoutingResponse } from './validation.js';

const candidate = { peerId: 'a'.repeat(40), provider: 'openai', serviceId: 'model-a' };
const request = { v: 1, preferences: { strategy: 'balanced' }, inputMessage: 'Help with a function', promptTokens: 5, expectedCachedTokens: [], constraints: { allowedCandidates: [candidate] } };
const recommendation = { model: 'model-a', peer: candidate.peerId, provider: candidate.provider, estimate: { costUsd: 0.01, inputTokens: 5, cachedInputTokens: 0, outputTokens: 20 }, price: { inUsdPerM: 1, outUsdPerM: 3, cachedInUsdPerM: 0 } };
const response = { v: 1, router: 'levanto', ranked: [recommendation] };

describe('Levanto fulfillment contract', () => {
  it('v1 binds exact peer/provider/model destinations and an advertised catalog revision', () => {
    const revision = `0x${'a'.repeat(64)}`;
    const input = { ...request, catalogRevision: revision };
    const output = { ...response, catalogRevision: revision };
    expect(validateRoutingResponse(output, input)).toEqual([{ model: 'model-a', peer: candidate.peerId, provider: 'openai' }]);
    for (const change of [{ provider: 'other' }, { model: 'model-b' }, { peer: 'b'.repeat(40) }, { provider: undefined }]) {
      expect(() => validateRoutingResponse({ ...output, ranked: [{ ...output.ranked[0], ...change }] }, input)).toThrow('allowed candidates');
    }
    expect(() => validateRoutingResponse({ ...output, catalogRevision: `0x${'b'.repeat(64)}` }, input)).toThrow();
    expect(() => validateRoutingResponse(response, input)).toThrow();
    for (const allowedCandidates of [[], [candidate, candidate], [{ ...candidate, serviceId: '*' }], Array(513).fill(candidate)]) {
      expect(() => validateRoutingRequest({ ...input, constraints: { allowedCandidates } })).toThrow();
    }
    expect(() => validateRoutingRequest({ ...request, constraints: {} })).toThrow('allowed candidates');
    expect(() => validateRoutingRequest({ ...input, v: 2 })).toThrow();
    expect(() => validateRoutingResponse({ ...output, v: 2 }, input)).toThrow();
  });
  it('accepts v1 exact constraints without a catalog and rejects the old peer-only shape', () => {
    expect(() => validateRoutingRequest(request)).not.toThrow();
    expect(() => validateRoutingResponse(response, request)).not.toThrow();
    expect(() => validateRoutingRequest({ ...request, constraints: { allowedPeerIds: [candidate.peerId] } })).toThrow('allowed candidates');
    expect(() => validateRoutingResponse({ ...response, ranked: [{ ...recommendation, provider: undefined }] }, request)).toThrow('allowed candidates');
  });
  it.each([{ stream: true }, { promptTokens: -1 }, { cqt: 0 }, { inputMessage: '' }])('rejects invalid request fields %j', fields => {
    expect(() => validateRoutingRequest({ ...request, ...fields })).toThrow();
  });
  it.each([{ ranked: [] }, { v: 2 }, { renewalDue: true }, { error: 'failed' }, { ranked: [{}] }])('does not bill invalid responses %j', fields => {
    expect(() => validateRoutingResponse({ ...response, ...fields }, request)).toThrow();
  });
  it('checks buyer peer and price constraints', () => {
    for (const constraints of [{ allowedPeerIds: ['b'.repeat(40)] }, { blockedPeerIds: ['a'.repeat(40)] }, { maxInputUsdPerMillion: 0 }]) {
      expect(() => validateRoutingResponse(response, { ...request, constraints: { ...request.constraints, ...constraints } })).toThrow('constraints');
    }
    expect(() => validateRoutingResponse(response, { ...request, constraints: { ...request.constraints, allowedPeerIds: [] } })).not.toThrow();
  });
  it('does not silently discard router-added inference overrides', () => {
    expect(() => validateRoutingResponse({
      ...response, ranked: [{ ...recommendation, inference: { reasoningEffort: 'high' } }],
    }, request)).toThrow('No valid');
  });
  it('retains valid recommendations when other entries are malformed or outside the allowlist', () => {
    const ranked = [{ ...recommendation, peer: 'b'.repeat(40) }, {}, recommendation];
    expect(validateRoutingResponse({ ...response, ranked }, {
      ...request, constraints: { ...request.constraints, allowedPeerIds: ['a'.repeat(40)] },
    })).toEqual([{ model: 'model-a', peer: 'a'.repeat(40), provider: 'openai' }]);
  });
});
