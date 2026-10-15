import { describe, expect, it, vi } from 'vitest';
import { isFreeUnitBillingModel, type SerializedHttpRequest } from '@antseed/node';
import plugin, { DefaultRouter, freeNetworkModels, modelKeys, parseScores } from './index.js';

const stats = {
  peers: [
    { providers: [{
      services: ['glm-4.7-flash', 'qwen2.5-coder-7b', 'flux-image', 'GLM-5.3-Flash-EXL3'],
      defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      serviceApiProtocols: {
        'glm-4.7-flash': ['openai-chat-completions'],
        'qwen2.5-coder-7b': ['openai-chat-completions'],
        'flux-image': ['openai-images'],
        'GLM-5.3-Flash-EXL3': ['openai-chat-completions'],
      },
    }] },
    { providers: [{
      services: ['gpt-5.5', 'qwen3.6-27b'],
      defaultPricing: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
      servicePricing: { 'qwen3.6-27b': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    }] },
  ],
};

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

function stubFetch(routes: { stats?: unknown; scores?: unknown[] | Error } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'stats.test') return new Response(JSON.stringify(routes.stats ?? stats));
    if (url.hostname === 'scores.test') {
      if (routes.scores instanceof Error) throw routes.scores;
      const pages = routes.scores ?? scorePages;
      return new Response(JSON.stringify(pages[Number(url.searchParams.get('offset')) ? 1 : 0]));
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const urls = { statsUrl: 'https://stats.test/stats', scoresUrl: 'https://scores.test/api/v1/models' };

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
  it('lists free chat models from the network snapshot', () => {
    expect(freeNetworkModels(stats)).toEqual(['glm-4.7-flash', 'qwen2.5-coder-7b', 'GLM-5.3-Flash-EXL3', 'qwen3.6-27b']);
  });

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

describe('DefaultRouter', () => {
  it('lists free network models, best live score first and unscored last', async () => {
    const router = new DefaultRouter({ ...urls, fetch: stubFetch() });
    const response = await router.handleRequest(request('GET', '/v1/routing/models'));
    expect(response.statusCode).toBe(200);
    expect(decode(response.body).data.map((entry: { id: string }) => entry.id))
      .toEqual(['GLM-5.3-Flash-EXL3', 'qwen3.6-27b', 'glm-4.7-flash', 'qwen2.5-coder-7b']);
  });

  it('ranks free candidates by live score, keeps buyer order within a model, and puts unscored last', async () => {
    const router = new DefaultRouter({ ...urls, fetch: stubFetch() });
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
    const router = new DefaultRouter({ ...urls, metric: 'coding', fetch: stubFetch() });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('flash@a', 'GLM-5.3-Flash-EXL3'),
      candidate('qwen@b', 'qwen3.6-27b'),
    ])));
    expect(rankedIds(response.body)).toEqual(['qwen@b', 'flash@a']);
  });

  it('puts seller-preferred models first', async () => {
    const router = new DefaultRouter({ ...urls, preferredModels: ['qwen2.5-coder-7b'], fetch: stubFetch() });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('qwen@a', 'qwen3.6-27b'),
      candidate('small@b', 'qwen2.5-coder-7b'),
    ])));
    expect(rankedIds(response.body)).toEqual(['small@b', 'qwen@a']);
  });

  it('keeps buyer order when scores are unavailable', async () => {
    const router = new DefaultRouter({ ...urls, fetch: stubFetch({ scores: new Error('offline') }) });
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
      if (url.hostname === 'stats.test') return new Response(JSON.stringify(stats));
      if (!scoresUp) throw new Error('offline');
      return new Response(JSON.stringify(scorePages[Number(url.searchParams.get('offset')) ? 1 : 0]));
    });
    const router = new DefaultRouter({ ...urls, fetch: fetchMock as unknown as typeof fetch, refreshMs: 1_000, now: () => now });
    await router.init();
    scoresUp = false;
    now = 5_000;
    expect((await router.listModels())[0]).toBe('GLM-5.3-Flash-EXL3');
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).searchParams.get('offset') === '2')).toBe(true);
  });

  it('ranks paid candidates after free ones, cheapest first, when asked', async () => {
    const router = new DefaultRouter({ statsUrl: '', scoresUrl: '', includePaid: true });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([
      candidate('pricey@a', 'gpt-5.5', 1.25, 10),
      candidate('cheap@b', 'deepseek-v4-flash', 0.1, 0.2),
      candidate('free@c', 'glm-4.7-flash'),
    ])));
    expect(rankedIds(response.body)).toEqual(['free@c', 'cheap@b', 'pricey@a']);
  });

  it('answers 422 when no candidate is free', async () => {
    const router = new DefaultRouter({ statsUrl: '', scoresUrl: '' });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', rankBody([candidate('paid@a', 'gpt-5.5', 1, 1)])));
    expect(response.statusCode).toBe(422);
    expect(decode(response.body).type).toBe('urn:irp:problem:no-scorable-candidate');
  });

  it('answers 400 for malformed rank requests', async () => {
    const router = new DefaultRouter({ statsUrl: '', scoresUrl: '' });
    const response = await router.handleRequest(request('POST', '/v1/routing/rank', { routing: {} }));
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('application/problem+json');
  });
});

describe('provider-default-router plugin', () => {
  const offline = { DEFAULT_ROUTER_STATS_URL: '', DEFAULT_ROUTER_SCORES_URL: '' };

  it('advertises one free model-routing service by default', () => {
    const provider = plugin.createProvider(offline) as Awaited<ReturnType<typeof plugin.createProvider>>;
    expect(provider.services).toEqual(['default-router']);
    expect(provider.serviceApiProtocols).toEqual({ 'default-router': ['model-routing'] });
    expect(provider.pricing.defaults).toEqual({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
    expect(isFreeUnitBillingModel(provider.serviceUnitBillingModels!['default-router']!['model-routing']!)).toBe(true);
  });

  it('charges the configured price per ranking', () => {
    const provider = plugin.createProvider({ ...offline, DEFAULT_ROUTER_PRICE_USD: '0.001' }) as Awaited<ReturnType<typeof plugin.createProvider>>;
    expect(provider.serviceUnitBillingModels!['default-router']!['model-routing']).toEqual({
      version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }],
    });
  });

  it('validates its configuration', () => {
    expect((plugin.createProvider({ ...offline, ANTSEED_ALLOWED_SERVICES: 'route' }) as { services: string[] }).services).toEqual(['route']);
    expect(() => plugin.createProvider({ ...offline, ANTSEED_ALLOWED_SERVICES: 'a,b' })).toThrow('exactly one');
    expect(() => plugin.createProvider({ ...offline, DEFAULT_ROUTER_METRIC: 'vibes' })).toThrow('intelligence or coding');
    expect(() => plugin.createProvider({ ...offline, DEFAULT_ROUTER_PRICE_USD: '-1' })).toThrow('non-negative');
  });
});
