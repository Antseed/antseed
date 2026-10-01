import { describe, expect, it } from 'vitest';
import {
  validateRoutingDescribeResponse,
  validateRoutingRankRequest,
  validateRoutingRankResponse,
  type RoutingCandidateV1,
  type RoutingDescribeResponseV1,
  type RoutingRankRequestV1,
} from './model-routing.js';

const peerA = 'a'.repeat(40);
const peerB = 'b'.repeat(40);

const alpha: RoutingDescribeResponseV1 = {
  version: 1, revision: 'alpha-1', name: 'Alpha', supportedServiceIds: ['claude-sonnet-4-6', 'kimi-k3'],
  preferences: { tradeoff: { title: 'Tradeoff', options: ['1', '3', '5', '7', '9'], default: '5' } },
};

const beta: RoutingDescribeResponseV1 = {
  version: 1, revision: 'beta-1', name: 'Beta Router', supportedServiceIds: ['claude-haiku-4-5-20251001', 'kimi-k3'],
  preferences: { policy: { title: 'Routing policy',
      options: ['balanced', 'cost_efficient', 'capability_heavy', 'domain_skills'], default: 'balanced' } },
};

const candidates: RoutingCandidateV1[] = [
  { model: 'claude-sonnet-4-6', peer: peerA, provider: 'anthropic',
    price: { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 }, expectedCachedInputTokens: 10_000 },
  { model: 'kimi-k3', peer: peerB, provider: 'moonshot', price: { inputUsdPerMillion: 0.8, outputUsdPerMillion: 3 },
    expectedCachedInputTokens: 0 },
];

function route(overrides: Partial<RoutingRankRequestV1> = {}): RoutingRankRequestV1 {
  return { version: 1, service: 'route', revision: 'alpha-1', preferences: { tradeoff: '7' },
    input: { text: 'Refactor this module', estimatedTokens: 12_000 }, candidates: structuredClone(candidates), ...overrides };
}

describe('model-routing describe', () => {
  it('accepts router-defined settings for different routers', () => {
    expect(() => validateRoutingDescribeResponse(alpha)).not.toThrow();
    expect(() => validateRoutingDescribeResponse(beta)).not.toThrow();
  });

  it('rejects malformed descriptions', () => {
    for (const invalid of [
      { ...alpha, version: 2 }, { ...alpha, revision: '' }, { ...alpha, supportedServiceIds: ['kimi-k3', 'kimi-k3'] },
      { ...alpha, supportedServiceIds: 'kimi-k3' }, { ...alpha, extra: true },
      { ...alpha, preferences: { tradeoff: { options: [1, 3] } } }, { ...alpha, preferences: { tradeoff: { options: ['1'], type: 'string' } } },
    ]) expect(() => validateRoutingDescribeResponse(invalid)).toThrow();
  });
});

describe('model-routing rank request', () => {
  it('accepts candidates the router supports with valid preferences', () => {
    expect(() => validateRoutingRankRequest(route(), alpha)).not.toThrow();
    expect(() => validateRoutingRankRequest(route({ revision: 'beta-1', preferences: { policy: 'cost_efficient' },
      candidates: [{ ...candidates[1]! }] }), beta)).not.toThrow();
  });

  it('rejects stale revisions, unsupported models, duplicates and invalid preferences', () => {
    expect(() => validateRoutingRankRequest(route({ revision: 'old' }), alpha)).toThrow('refresh');
    expect(() => validateRoutingRankRequest(route({ candidates: [{ ...candidates[0]!, model: 'gpt-5.5' }] }), alpha)).toThrow('does not support');
    expect(() => validateRoutingRankRequest(route({ candidates: [candidates[0]!, candidates[0]!] }), alpha)).toThrow('Duplicate');
    expect(() => validateRoutingRankRequest(route({ preferences: { tradeoff: '2' } }), alpha)).toThrow();
    expect(() => validateRoutingRankRequest(route({ preferences: { policy: 'balanced' } }), alpha)).toThrow('unknown');
    expect(() => validateRoutingRankRequest(route({ candidates: [] }), alpha)).toThrow();
    expect(() => validateRoutingRankRequest(route({ input: { text: ' ', estimatedTokens: 1 } }), alpha)).toThrow();
    expect(() => validateRoutingRankRequest(route({ candidates: [{ ...candidates[0]!, expectedCachedInputTokens: -1 }] }), alpha)).toThrow('candidate');
    expect(() => validateRoutingRankRequest(route({ candidates: [{ ...candidates[0]!, peer: 'not-a-peer' }] }), alpha)).toThrow('candidate');
  });
});

describe('model-routing rank response', () => {
  it('keeps exact sent candidates in router order and drops the rest', () => {
    const response = { version: 1, recommendations: [
      { model: 'kimi-k3', peer: peerA, provider: 'moonshot' },
      { model: 'kimi-k3', peer: peerB, provider: 'moonshot', reasoningEffort: 'high' },
      { model: 'kimi-k3', peer: peerB, provider: 'moonshot' },
      { model: 'kimi-k3', peer: peerB, provider: 'moonshot' },
      { model: 'claude-sonnet-4-6', peer: peerA, provider: 'anthropic' },
    ] };
    expect(validateRoutingRankResponse(response, candidates)).toEqual([
      { model: 'kimi-k3', peer: peerB, provider: 'moonshot' },
      { model: 'claude-sonnet-4-6', peer: peerA, provider: 'anthropic' },
    ]);
  });

  it('rejects malformed responses and responses with no sent candidate', () => {
    expect(() => validateRoutingRankResponse({ version: 1, recommendations: [] }, candidates)).toThrow('Invalid');
    expect(() => validateRoutingRankResponse({ version: 1, recommendations: [{ model: 'x', peer: peerA, provider: 'y' }] }, candidates)).toThrow('no recommendation');
    expect(() => validateRoutingRankResponse({ version: 1, recommendations: [candidates[0]], details: { confidence: 0.9 } }, candidates)).toThrow('Invalid');
    expect(() => validateRoutingRankResponse({ recommendations: [candidates[0]] }, candidates)).toThrow('Invalid');
  });
});
