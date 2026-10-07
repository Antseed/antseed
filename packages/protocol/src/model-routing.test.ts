import { describe, expect, it } from 'vitest';
import {
  isCostQualityTradeoff,
  parseRoutingModelsResponse,
  parseRoutingProblem,
  routingProblemBody,
  findRoutingService,
  isModelRoutingPath,
  validateRoutingRankRequest,
  validateRoutingRankResponse,
  type RoutingCandidateV1,
  type RoutingRankRequestV1,
} from './model-routing.js';

const peerA = 'a'.repeat(40);
const peerB = 'b'.repeat(40);
const supported = ['claude-sonnet-4-6', 'kimi-k3'];

const candidates: RoutingCandidateV1[] = [
  { id: `anthropic:claude-sonnet-4-6@${peerA}`, model: 'claude-sonnet-4-6',
    pricing: { input: 3, cache_read: 0.3, output: 15 }, expected_usage: { cache_read_tokens: 10_000 } },
  { id: `moonshot:kimi-k3@${peerB}`, model: 'kimi-k3', pricing: { input: 0.8, cache_read: 0.8, output: 3 } },
];

function rank(routing: Partial<RoutingRankRequestV1['routing']> = {}, request: RoutingRankRequestV1['request'] = { messages: [{ role: 'user', content: 'Refactor this module' }] }): RoutingRankRequestV1 {
  return { request, routing: { cost_quality_tradeoff: 3, candidates: structuredClone(candidates), ...routing } };
}

describe('model-routing models (IRP §4)', () => {
  it('reads model ids and ignores unknown members', () => {
    expect(parseRoutingModelsResponse({ object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'x' }], extra: { 'r.example': {} } }))
      .toEqual(['kimi-k3']);
    expect(parseRoutingModelsResponse({ object: 'list', data: [] })).toEqual([]);
  });

  it('rejects malformed lists', () => {
    for (const invalid of [
      { data: [] }, { object: 'list' }, { object: 'list', data: [{ id: 'm' }] }, { object: 'list', data: [{ id: '', object: 'model' }] },
      { object: 'list', data: [{ id: 'm', object: 'model' }, { id: 'm', object: 'model' }] },
    ]) expect(() => parseRoutingModelsResponse(invalid)).toThrow();
  });
});

describe('model-routing rank request (IRP §5.1)', () => {
  it('accepts plain IRP requests, with or without a tradeoff, ignoring unknown members', () => {
    expect(() => validateRoutingRankRequest(rank(), supported)).not.toThrow();
    expect(() => validateRoutingRankRequest(rank({ cost_quality_tradeoff: undefined }))).not.toThrow();
    expect(() => validateRoutingRankRequest({ ...rank(), extra: { 'c.example': {} } })).not.toThrow();
    expect(() => validateRoutingRankRequest(rank({ candidates: [{ ...candidates[1]!, extra: { 'c.example': {} } } as RoutingCandidateV1] }))).not.toThrow();
    expect(() => validateRoutingRankRequest(rank({ candidates: [{ ...candidates[1]!, expected_usage: {} }] }))).not.toThrow();
  });

  it('rejects unsupported models, duplicate ids and invalid values', () => {
    expect(() => validateRoutingRankRequest(rank({ candidates: [{ ...candidates[0]!, model: 'gpt-5.5' }] }), supported)).toThrow('does not support');
    expect(() => validateRoutingRankRequest(rank({ candidates: [candidates[0]!, candidates[0]!] }))).toThrow('Duplicate');
    for (const tradeoff of [-1, 11, 2.5, '5']) {
      expect(() => validateRoutingRankRequest(rank({ cost_quality_tradeoff: tradeoff as number }))).toThrow('rank request');
    }
    expect(() => validateRoutingRankRequest(rank({ candidates: [] }))).toThrow();
    expect(() => validateRoutingRankRequest(rank({ candidates: Array.from({ length: 513 }, (_, index) => ({ ...candidates[1]!, id: `c${index}` })) }))).toThrow();
    expect(() => validateRoutingRankRequest(rank({}, { messages: [] }))).toThrow();
    expect(() => validateRoutingRankRequest(rank({}, { messages: [{ role: 'human', content: 'hi' }] }))).toThrow();
    for (const candidate of [
      { ...candidates[1]!, id: '' }, { ...candidates[1]!, id: 'x'.repeat(129) },
      { ...candidates[1]!, pricing: { input: 1, output: 1 } }, { ...candidates[1]!, pricing: { input: -1, cache_read: 0, output: 1 } },
      { ...candidates[1]!, expected_usage: { cache_read_tokens: 1.5 } },
    ]) expect(() => validateRoutingRankRequest(rank({ candidates: [candidate as RoutingCandidateV1] }))).toThrow('candidate');
  });

  it('checks tradeoff values', () => {
    expect([0, 5, 10].every(isCostQualityTradeoff)).toBe(true);
    expect([-1, 11, 1.5, '5', null].some(isCostQualityTradeoff)).toBe(false);
  });

  it('identifies routing paths and a peer\'s single routing service', () => {
    expect(['/v1/routing/models', '/v1/routing/rank?x=1'].every(isModelRoutingPath)).toBe(true);
    expect(isModelRoutingPath('/v1/chat/completions')).toBe(false);
    const route = { alpha: { services: { route: ['model-routing'], chat: ['openai-chat-completions'] } } };
    expect(findRoutingService(route)).toEqual({ provider: 'alpha', serviceId: 'route' });
    expect(findRoutingService({ ...route, beta: { services: { other: ['model-routing'] } } })).toBeNull();
    expect(findRoutingService(undefined)).toBeNull();
  });
});

describe('model-routing rank response (IRP §5.2)', () => {
  const envelope = (ranked: unknown[]) => ({ id: 'rank_1', object: 'routing.ranking', created: 1_790_000_000, router: { id: 'alpha', version: '1' }, ranked });

  it('keeps sent candidates in router order with well-formed predictions', () => {
    const [a, b] = candidates.map(candidate => candidate.id) as [string, string];
    expect(validateRoutingRankResponse(envelope([
      { candidate_id: 'unknown' },
      { candidate_id: b, expected_quality: 0.7, expected_cost_usd: 0.002, reasoning_effort: 'low',
        expected_usage: { input_tokens: 100, cache_read_tokens: 0, output_tokens: 50 }, extra: { 'r.example': {} } },
      { candidate_id: b },
      { candidate_id: a, expected_quality: 3, expected_usage: { input_tokens: 1 } },
    ]), candidates)).toEqual([
      { candidate_id: b, expected_quality: 0.7, expected_cost_usd: 0.002, reasoning_effort: 'low',
        expected_usage: { input_tokens: 100, cache_read_tokens: 0, output_tokens: 50 } },
      { candidate_id: a },
    ]);
  });

  it('rejects bad envelopes and rankings with no sent candidate', () => {
    expect(() => validateRoutingRankResponse({ recommendations: [] }, candidates)).toThrow('Invalid');
    expect(() => validateRoutingRankResponse(envelope([]), candidates)).toThrow('Invalid');
    expect(() => validateRoutingRankResponse({ ...envelope([{ candidate_id: candidates[0]!.id }]), router: { id: 'x' } }, candidates)).toThrow('Invalid');
    expect(() => validateRoutingRankResponse({ ...envelope([{ candidate_id: candidates[0]!.id }]), object: 'list' }, candidates)).toThrow('Invalid');
    expect(() => validateRoutingRankResponse(envelope([{ candidate_id: 'unknown' }]), candidates)).toThrow('no ranking');
  });
});

describe('model-routing problem details (IRP §8)', () => {
  it('reads and writes RFC 9457 bodies', () => {
    const body = JSON.parse(new TextDecoder().decode(routingProblemBody(422, 'urn:irp:problem:no-scorable-candidate', 'No scorable candidate', 'None fit.')));
    expect(body).toEqual({ type: 'urn:irp:problem:no-scorable-candidate', title: 'No scorable candidate', status: 422, detail: 'None fit.' });
    expect(parseRoutingProblem(body)).toEqual(body);
    expect(parseRoutingProblem({ status: 500 })).toBeNull();
    expect(parseRoutingProblem('x')).toBeNull();
  });
});
