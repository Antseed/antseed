import { describe, expect, it } from 'vitest';
import {
  isCostQualityTradeoff,
  parseIrpModelsResponse,
  parseIrpModelEntries,
  withinIrpPricing,
  parseIrpProblem,
  irpProblemBody,
  isIrpPath,
  IRP_SUGGEST_WIRE,
  validateIrpRankRequest,
  validateIrpRankResponse,
  type IrpCandidate,
  type IrpRankRequest,
} from './irp.js';

const peerA = 'a'.repeat(40);
const peerB = 'b'.repeat(40);
const supported = ['claude-sonnet-4-6', 'kimi-k3'];

const candidates: IrpCandidate[] = [
  { id: `anthropic:claude-sonnet-4-6@${peerA}`, model: 'claude-sonnet-4-6',
    pricing: { input: 3, cache_read: 0.3, output: 15 }, expected_usage: { cache_read_tokens: 10_000 } },
  { id: `moonshot:kimi-k3@${peerB}`, model: 'kimi-k3', pricing: { input: 0.8, cache_read: 0.8, output: 3 } },
];

function rank(routing: Partial<IrpRankRequest['routing']> = {}, request: IrpRankRequest['request'] = { messages: [{ role: 'user', content: 'Refactor this module' }] }): IrpRankRequest {
  return { request, routing: { cost_quality_tradeoff: 3, candidates: structuredClone(candidates), ...routing } };
}

describe('model-routing models (IRP §4)', () => {
  it('reads model ids and ignores unknown members', () => {
    expect(parseIrpModelsResponse({ object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'x' }], extra: { 'r.example': {} } }))
      .toEqual(['kimi-k3']);
    expect(parseIrpModelsResponse({ object: 'list', data: [] })).toEqual([]);
  });

  it('keeps max_pricing on model entries and checks prices against it', () => {
    expect(parseIrpModelEntries({ object: 'list', data: [
      { id: '*', object: 'model', max_pricing: { input: 0, output: 0, extra: 1 } },
      { id: 'kimi-k3', object: 'model' },
    ] })).toEqual([{ id: '*', max_pricing: { input: 0, output: 0 } }, { id: 'kimi-k3' }]);
    for (const max_pricing of [{ input: -1 }, { output: '0' }, 0]) {
      expect(() => parseIrpModelEntries({ object: 'list', data: [{ id: '*', object: 'model', max_pricing }] })).toThrow('max_pricing');
    }
    const price = { input: 1, cache_read: 0.1, output: 4 };
    expect(withinIrpPricing(price, undefined)).toBe(true);
    expect(withinIrpPricing(price, { input: 1 })).toBe(true);
    expect(withinIrpPricing(price, { output: 3 })).toBe(false);
  });

  it('rejects malformed lists', () => {
    for (const invalid of [
      { data: [] }, { object: 'list' }, { object: 'list', data: [{ id: 'm' }] }, { object: 'list', data: [{ id: '', object: 'model' }] },
      { object: 'list', data: [{ id: 'm', object: 'model' }, { id: 'm', object: 'model' }] },
    ]) expect(() => parseIrpModelsResponse(invalid)).toThrow();
  });
});

describe('model-routing rank request (IRP §5.1)', () => {
  it('accepts plain IRP requests, with or without a tradeoff, ignoring unknown members', () => {
    expect(() => validateIrpRankRequest(rank(), supported)).not.toThrow();
    expect(() => validateIrpRankRequest(rank({ cost_quality_tradeoff: undefined }))).not.toThrow();
    expect(() => validateIrpRankRequest({ ...rank(), extra: { 'c.example': {} } })).not.toThrow();
    expect(() => validateIrpRankRequest(rank({ candidates: [{ ...candidates[1]!, extra: { 'c.example': {} } } as IrpCandidate] }))).not.toThrow();
    expect(() => validateIrpRankRequest(rank({ candidates: [{ ...candidates[1]!, expected_usage: {} }] }))).not.toThrow();
  });

  it('rejects unsupported models, duplicate ids and invalid values', () => {
    expect(() => validateIrpRankRequest(rank({ candidates: [{ ...candidates[0]!, model: 'gpt-5.5' }] }), supported)).toThrow('does not support');
    expect(() => validateIrpRankRequest(rank({ candidates: [candidates[0]!, candidates[0]!] }))).toThrow('Duplicate');
    for (const tradeoff of [-1, 11, 2.5, '5']) {
      expect(() => validateIrpRankRequest(rank({ cost_quality_tradeoff: tradeoff as number }))).toThrow('rank request');
    }
    expect(() => validateIrpRankRequest(rank({ candidates: [] }))).toThrow();
    expect(() => validateIrpRankRequest(rank({ candidates: Array.from({ length: 513 }, (_, index) => ({ ...candidates[1]!, id: `c${index}` })) }))).toThrow();
    expect(() => validateIrpRankRequest(rank({}, { messages: [] }))).toThrow();
    expect(() => validateIrpRankRequest(rank({}, { messages: [{ role: 'human', content: 'hi' }] }))).toThrow();
    for (const candidate of [
      { ...candidates[1]!, id: '' }, { ...candidates[1]!, id: 'x'.repeat(129) },
      { ...candidates[1]!, pricing: { input: 1, output: 1 } }, { ...candidates[1]!, pricing: { input: -1, cache_read: 0, output: 1 } },
      { ...candidates[1]!, expected_usage: { cache_read_tokens: 1.5 } },
    ]) expect(() => validateIrpRankRequest(rank({ candidates: [candidate as IrpCandidate] }))).toThrow('candidate');
  });

  it('checks tradeoff values', () => {
    expect([0, 5, 10].every(isCostQualityTradeoff)).toBe(true);
    expect([-1, 11, 1.5, '5', null].some(isCostQualityTradeoff)).toBe(false);
  });

  it('identifies IRP paths', () => {
    expect(['/v1/routing/models', '/v1/routing/rank?x=1'].every(isIrpPath)).toBe(true);
    expect(isIrpPath('/v1/chat/completions')).toBe(false);
  });

  it('classifies requests and bills only rankings naming a sent candidate', () => {
    expect(IRP_SUGGEST_WIRE.requestAction('GET', '/v1/routing/models')).toBe('catalog');
    expect(IRP_SUGGEST_WIRE.requestAction('POST', '/v1/routing/rank')).toBe('rank');
    expect(IRP_SUGGEST_WIRE.requestAction('POST', '/v1/routing/models')).toBeNull();
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const ids = IRP_SUGGEST_WIRE.rankCandidateIds(encode(rank()));
    expect(ids).toEqual(candidates.map(candidate => candidate.id));
    const ranking = { id: 'r1', object: 'routing.ranking', created: 1, router: { id: 'x', version: '1' } };
    expect(IRP_SUGGEST_WIRE.isBillableRanking(encode({ ...ranking, ranked: [{ candidate_id: ids[1] }] }), ids)).toBe(true);
    expect(IRP_SUGGEST_WIRE.isBillableRanking(encode({ ...ranking, ranked: [{ candidate_id: 'unknown' }] }), ids)).toBe(false);
    expect(IRP_SUGGEST_WIRE.isBillableRanking(new TextEncoder().encode('not json'), ids)).toBe(false);
  });
});

describe('model-routing rank response (IRP §5.2)', () => {
  const envelope = (ranked: unknown[]) => ({ id: 'rank_1', object: 'routing.ranking', created: 1_790_000_000, router: { id: 'alpha', version: '1' }, ranked });

  it('keeps sent candidates in router order with well-formed predictions', () => {
    const [a, b] = candidates.map(candidate => candidate.id) as [string, string];
    expect(validateIrpRankResponse(envelope([
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
    expect(() => validateIrpRankResponse({ recommendations: [] }, candidates)).toThrow('Invalid');
    expect(() => validateIrpRankResponse(envelope([]), candidates)).toThrow('Invalid');
    expect(() => validateIrpRankResponse({ ...envelope([{ candidate_id: candidates[0]!.id }]), router: { id: 'x' } }, candidates)).toThrow('Invalid');
    expect(() => validateIrpRankResponse({ ...envelope([{ candidate_id: candidates[0]!.id }]), object: 'list' }, candidates)).toThrow('Invalid');
    expect(() => validateIrpRankResponse(envelope([{ candidate_id: 'unknown' }]), candidates)).toThrow('no ranking');
  });
});

describe('model-routing problem details (IRP §8)', () => {
  it('reads and writes RFC 9457 bodies', () => {
    const body = JSON.parse(new TextDecoder().decode(irpProblemBody(422, 'urn:irp:problem:no-scorable-candidate', 'No scorable candidate', 'None fit.')));
    expect(body).toEqual({ type: 'urn:irp:problem:no-scorable-candidate', title: 'No scorable candidate', status: 422, detail: 'None fit.' });
    expect(parseIrpProblem(body)).toEqual(body);
    expect(parseIrpProblem({ status: 500 })).toBeNull();
    expect(parseIrpProblem('x')).toBeNull();
  });
});
