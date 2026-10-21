import { describe, expect, it, vi } from 'vitest';
import { isFreeUnitBillingModel, type SerializedHttpRequest } from '@antseed/node';
import plugin, { FreeModelRouter, modelKeys, parseScores } from './index.js';

const scorePages = [
  {
    data: [
      { id: 'z-ai/glm-5.3-flash', benchmarks: { artificial_analysis: { intelligence: 41.8, coding: 50 } } },
      { id: 'qwen/qwen3.6-27b', benchmarks: { artificial_analysis: { intelligence: 21.4, coding: 53.7 } } },
    ],
    meta: { has_more: true, next_offset: 2 },
  },
  {
    data: [
      { id: 'z-ai/glm-4.7-flash', benchmarks: { artificial_analysis: { intelligence: 14.9, coding: null } } },
      { id: 'openai/gpt-5.5', benchmarks: { artificial_analysis: { intelligence: 38.4 } } },
      { id: 'qwen/qwen-2.5-coder-32b-instruct', benchmarks: { artificial_analysis: { intelligence: 6.7 } } },
    ],
    meta: { has_more: false },
  },
];

function stubFetch(routes: { scores?: unknown[] | Error } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'scores.test') {
      if (routes.scores instanceof Error) throw routes.scores;
      const pages = routes.scores ?? scorePages;
      return new Response(JSON.stringify(pages[Number(url.searchParams.get('offset')) ? 1 : 0]));
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const urls = { scoresUrl: 'https://scores.test/api/v1/models' };

const request = (method: string, path: string, body?: unknown): SerializedHttpRequest => ({
  requestId: 'r1', method, path, headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body)),
});

const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body));

const candidate = (id: string, model: string, input = 0, output = 0) => ({ id, model, pricing: { input, cache_read: input, output } });

const rankBody = (candidates: ReturnType<typeof candidate>[]) => ({
  request: { messages: [{ role: 'user', content: 'hello' }] },
  routing: { candidates },
});

const rankedIds = (body: Uint8Array): string[] => decode(body).ranked.map((entry: { candidate_id: string }) => entry.candidate_id);

describe('helpers', () => {
  it('reads the chosen Artificial Analysis metric and skips missing scores', () => {
    const coding = parseScores(scorePages, 'coding');
    expect([...coding.values()]).toEqual([50, 53.7]);
  });

  it('strips deployment suffixes but never the parameter size', () => {
    expect(modelKeys('GLM-5.3-Flash-EXL3')).toContain(modelKeys('z-ai/glm-5.3-flash')[0]);
    expect(modelKeys('claude-opus-5-fast')).toContain(modelKeys('claude-opus-5')[0]);
    expect(modelKeys('qwen2.5-coder-7b')).not.toContain(modelKeys('qwen-2.5-coder-32b-instruct').at(-1));
  });
});

describe('FreeModelRouter', () => {
  it('lists * plus the seller-preferred models, free only, without any network fetch', async () => {
    const fetchMock = stubFetch();
    const router = new FreeModelRouter({ ...urls, preferredModels: ['qwen2.5-coder-7b'], fetch: fetchMock });
    const response = await router.handleRequest(request('GET', '/v1/routing/models'));
    expect(response.statusCode).toBe(200);
    const free = { input: 0, cache_read: 0, output: 0 };
    expect(decode(response.body).data).toEqual([
      { id: '*', object: 'model', max_pricing: free },
      { id: 'qwen2.5-coder-7b', object: 'model', max_pricing: free },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the price limit when paid candidates are ranked too', async () => {
    const router = new FreeModelRouter({ scoresUrl: '', includePaid: true });
    const response = await router.handleRequest(request('GET', '/v1/routing/models'));
    expect(decode(response.body).data).toEqual([{ id: '*', object: 'model' }]);
  });

  it('ranks any free model the buyer sends, including ones no list ever named', async () => {
    const router = new FreeModelRouter({ scoresUrl: '' });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('new@a', 'brand-new-model-9b'),
      candidate('other@b', 'another-unlisted-model'),
    ])));
    expect(response.statusCode).toBe(200);
    expect(rankedIds(response.body)).toEqual(['new@a', 'other@b']);
  });

  it('ranks free candidates by live score, keeps buyer order within a model, and puts unscored last', async () => {
    const router = new FreeModelRouter({ ...urls, fetch: stubFetch() });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('small@a', 'qwen2.5-coder-7b'),
      candidate('paid@b', 'gpt-5.5', 1.25, 10),
      candidate('glm@c', 'glm-4.7-flash'),
      candidate('qwen@d', 'qwen3.6-27b'),
      candidate('glm@e', 'glm-4.7-flash'),
    ])));
    expect(response.statusCode).toBe(200);
    const ranking = decode(response.body);
    expect(ranking.object).toBe('routing.ranking');
    expect(rankedIds(response.body)).toEqual(['qwen@d', 'glm@c', 'glm@e', 'small@a']);
    expect(ranking.ranked[0].expected_cost_usd).toBe(0);
  });

  it('ranks by coding score when asked', async () => {
    const router = new FreeModelRouter({ ...urls, metric: 'coding', fetch: stubFetch() });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('flash@a', 'GLM-5.3-Flash-EXL3'),
      candidate('qwen@b', 'qwen3.6-27b'),
    ])));
    expect(rankedIds(response.body)).toEqual(['qwen@b', 'flash@a']);
  });

  it('puts seller-preferred models first', async () => {
    const router = new FreeModelRouter({ ...urls, preferredModels: ['qwen2.5-coder-7b'], fetch: stubFetch() });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('qwen@a', 'qwen3.6-27b'),
      candidate('small@b', 'qwen2.5-coder-7b'),
    ])));
    expect(rankedIds(response.body)).toEqual(['small@b', 'qwen@a']);
  });

  it('keeps buyer order when scores are unavailable', async () => {
    const router = new FreeModelRouter({ ...urls, fetch: stubFetch({ scores: new Error('offline') }) });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('small@a', 'qwen2.5-coder-7b'),
      candidate('qwen@b', 'qwen3.6-27b'),
    ])));
    expect(response.statusCode).toBe(200);
    expect(rankedIds(response.body)).toEqual(['small@a', 'qwen@b']);
  });

  it('keeps the last good scores when a refresh fails', async () => {
    let now = 0;
    let scoresUp = true;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!scoresUp) throw new Error('offline');
      return new Response(JSON.stringify(scorePages[Number(url.searchParams.get('offset')) ? 1 : 0]));
    });
    const router = new FreeModelRouter({ ...urls, fetch: fetchMock as unknown as typeof fetch, refreshMs: 1_000, now: () => now });
    await router.init();
    scoresUp = false;
    now = 5_000;
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('small@a', 'glm-4.7-flash'),
      candidate('flash@b', 'GLM-5.3-Flash-EXL3'),
    ])));
    expect(rankedIds(response.body)).toEqual(['flash@b', 'small@a']);
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).searchParams.get('offset') === '2')).toBe(true);
  });

  it('ranks paid candidates after free ones, cheapest first, when asked', async () => {
    const router = new FreeModelRouter({ scoresUrl: '', includePaid: true });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('pricey@a', 'gpt-5.5', 1.25, 10),
      candidate('cheap@b', 'deepseek-v4-flash', 0.1, 0.2),
      candidate('free@c', 'glm-4.7-flash'),
    ])));
    expect(rankedIds(response.body)).toEqual(['free@c', 'cheap@b', 'pricey@a']);
  });

  it('answers 422 when no candidate is free', async () => {
    const router = new FreeModelRouter({ scoresUrl: '' });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([candidate('paid@a', 'gpt-5.5', 1, 1)])));
    expect(response.statusCode).toBe(422);
    expect(decode(response.body).type).toBe('urn:irp:problem:no-scorable-candidate');
  });

  it('answers 400 for malformed rank requests', async () => {
    const router = new FreeModelRouter({ scoresUrl: '' });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', { routing: {} }));
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('application/problem+json');
  });
});

describe('provider-free-model-router plugin', () => {
  const offline = { FREE_ROUTER_SCORES_URL: '' };

  it('advertises one free model-routing service by default', () => {
    const provider = plugin.createProvider(offline) as Awaited<ReturnType<typeof plugin.createProvider>>;
    expect(provider.services).toEqual(['free-model-router']);
    expect(provider.serviceApiProtocols).toEqual({ 'free-model-router': ['irp-suggest'] });
    expect(provider.pricing.defaults).toEqual({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
    expect(isFreeUnitBillingModel(provider.serviceUnitBillingModels!['free-model-router']!['irp-suggest']!)).toBe(true);
  });

  it('charges the configured price per ranking', () => {
    const provider = plugin.createProvider({ ...offline, FREE_ROUTER_PRICE_USD: '0.001' }) as Awaited<ReturnType<typeof plugin.createProvider>>;
    expect(provider.serviceUnitBillingModels!['free-model-router']!['irp-suggest']).toEqual({
      version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }],
    });
  });

  it('validates its configuration', () => {
    expect((plugin.createProvider({ ...offline, ANTSEED_ALLOWED_SERVICES: 'route' }) as { services: string[] }).services).toEqual(['route']);
    expect(() => plugin.createProvider({ ...offline, ANTSEED_ALLOWED_SERVICES: 'a,b' })).toThrow('exactly one');
    expect(() => plugin.createProvider({ ...offline, FREE_ROUTER_METRIC: 'vibes' })).toThrow('intelligence or coding');
    expect(() => plugin.createProvider({ ...offline, FREE_ROUTER_PRICE_USD: '-1' })).toThrow('non-negative');
  });
});
