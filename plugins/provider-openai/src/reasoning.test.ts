import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin from './index.js';
import { modelEntryReasoning, modelsListingPath } from './reasoning.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn().mockImplementation(async () => answer());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Shapes of the vendors' own model listings; ids and hosts are placeholders.
const xaiListing = {
  object: 'list',
  data: [
    { id: 'reasoner-a', object: 'model', capabilities: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'high' } },
    { id: 'plain-b', object: 'model', capabilities: { reasoning_effort: null } },
  ],
};
const effortListing = {
  object: 'list',
  data: [{ id: 'reasoner-c', object: 'model', owned_by: 'example', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }],
};

async function startedProvider(config: Record<string, string>) {
  const provider = await plugin.createProvider({ OPENAI_API_KEY: 'sk-test-key', ...config });
  await provider.init?.();
  return provider;
}

describe('reasoning efforts from the upstream model listing', () => {
  it('fills the list and reasoning from capabilities.reasoning_effort', async () => {
    const fetchMock = mockFetch(() => json(xaiListing));
    const provider = await startedProvider({
      OPENAI_BASE_URL: 'https://upstream.example',
      ANTSEED_ALLOWED_SERVICES: 'grok,plain-b',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"grok":"reasoner-a"}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upstream.example/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-key');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(provider.serviceCapabilities?.grok).toEqual({ reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] });
    expect(provider.serviceCapabilities?.['plain-b']).toBeUndefined();
  });

  it('fills from effort.supported_levels', async () => {
    mockFetch(() => json(effortListing));
    const provider = await startedProvider({ OPENAI_BASE_URL: 'https://upstream.example', ANTSEED_ALLOWED_SERVICES: 'reasoner-c' });
    expect(provider.serviceCapabilities?.['reasoner-c']).toEqual({ reasoning: true, reasoningEfforts: ['low', 'high', 'max'] });
  });

  it('reads the listing next to a rewritten chat path', async () => {
    const fetchMock = mockFetch(() => json(effortListing));
    const provider = await startedProvider({
      OPENAI_BASE_URL: 'https://rewrite.example/api',
      OPENAI_PATH_REWRITE_JSON: '{"/v1/chat/completions":"/v3/chat/completions"}',
      ANTSEED_ALLOWED_SERVICES: 'reasoner-c',
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://rewrite.example/api/v3/models');
    expect(provider.serviceCapabilities?.['reasoner-c']?.reasoningEfforts).toEqual(['low', 'high', 'max']);
    expect(modelsListingPath({ '/v1/models': '/custom/models' })).toBe('/custom/models');
    expect(modelsListingPath({ '/v1/chat/completions': '/chat/completions' })).toBe('/models');
    expect(modelsListingPath(undefined)).toBe('/v1/models');
  });

  it('ignores a rewrite that is not a string, and init still resolves', async () => {
    expect(modelsListingPath({ '/v1/chat/completions': 4 } as unknown as Record<string, string>)).toBe('/v1/models');
    expect(modelsListingPath({ '/v1/models': null, '/v1/chat/completions': '/v3/chat/completions' } as unknown as Record<string, string>)).toBe('/v3/models');
    const fetchMock = mockFetch(() => json(effortListing));
    const provider = await startedProvider({
      OPENAI_BASE_URL: 'https://upstream.example',
      OPENAI_PATH_REWRITE_JSON: '{"/v1/chat/completions": 4}',
      ANTSEED_ALLOWED_SERVICES: 'reasoner-c',
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://upstream.example/v1/models');
    expect(provider.serviceCapabilities?.['reasoner-c']?.reasoningEfforts).toEqual(['low', 'high', 'max']);
  });

  it('sends the extra headers the relay sends', async () => {
    const fetchMock = mockFetch(() => json(effortListing));
    await startedProvider({
      OPENAI_BASE_URL: 'https://upstream.example',
      OPENAI_EXTRA_HEADERS_JSON: '{"x-example-org":"org-1"}',
      ANTSEED_ALLOWED_SERVICES: 'reasoner-c',
    });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({ authorization: 'Bearer sk-test-key', 'x-example-org': 'org-1' });
  });

  it('keeps what the seller configured and never fills reasoning false', async () => {
    mockFetch(() => json(effortListing));
    const provider = await startedProvider({
      OPENAI_BASE_URL: 'https://upstream.example',
      ANTSEED_ALLOWED_SERVICES: 'own,off,own-other',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"own":"reasoner-c","off":"reasoner-c","own-other":"reasoner-c"}',
      ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({
        own: { reasoningEfforts: ['adaptive'] },
        off: { reasoning: false },
        'own-other': { contextWindow: 64000 },
      }),
    });
    expect(provider.serviceCapabilities?.own).toEqual({ reasoningEfforts: ['adaptive'] });
    expect(provider.serviceCapabilities?.off).toEqual({ reasoning: false });
    expect(provider.serviceCapabilities?.['own-other']).toEqual({ contextWindow: 64000, reasoning: true, reasoningEfforts: ['low', 'high', 'max'] });
  });

  it('drops a list with an invalid label or a duplicate, whole', async () => {
    mockFetch(() => json({
      data: [
        { id: 'bad-label', effort: { supported_levels: ['low', 'very high'] } },
        { id: 'duplicate', capabilities: { reasoning_effort: ['low', 'low'] } },
      ],
    }));
    const provider = await startedProvider({ OPENAI_BASE_URL: 'https://upstream.example', ANTSEED_ALLOWED_SERVICES: 'bad-label,duplicate' });
    expect(provider.serviceCapabilities?.['bad-label']).toBeUndefined();
    expect(provider.serviceCapabilities?.duplicate).toBeUndefined();
  });

  it('leaves capabilities unchanged when the listing fails, is too large or times out', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => json({ error: 'unauthorized' }, 401),
      () => new Response(new Uint8Array(4 * 1024 * 1024 + 1).fill(0x20)),
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      () => new Response('<html>not json</html>'),
      () => json({ data: [{ id: 'reasoner-c', model_spec: { capabilities: { supportsReasoning: true } } }] }),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [index, answer] of answers.entries()) {
        warn.mockClear();
        mockFetch(answer);
        const provider = await startedProvider({
          OPENAI_BASE_URL: 'https://upstream.example',
          ANTSEED_ALLOWED_SERVICES: 'reasoner-c',
          ANTSEED_SERVICE_CAPABILITIES_JSON: '{"reasoner-c":{"contextWindow":64000}}',
        });
        expect(provider.serviceCapabilities?.['reasoner-c']).toEqual({ contextWindow: 64000 });
        // A read that failed says so in one line, with host and path only; an answer without levels is not a failure.
        const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('reasoning efforts:'));
        expect(lines).toEqual(index < 4 ? ['reasoning efforts: could not read upstream.example/v1/models; announcing no list'] : []);
        expect(lines.join('\n')).not.toContain('sk-test-key');
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('does not read the OpenRouter catalogue or the Venice listing, nor list image services', async () => {
    const fetchMock = mockFetch(() => json(effortListing));
    const openrouter = await startedProvider({ OPENAI_BASE_URL: 'https://openrouter.ai/api', ANTSEED_ALLOWED_SERVICES: 'reasoner-c' });
    expect(openrouter.serviceCapabilities).toBeUndefined();
    const venice = await startedProvider({ OPENAI_PROVIDER_FLAVOR: 'venice', ANTSEED_ALLOWED_SERVICES: 'reasoner-c' });
    expect(venice.serviceCapabilities).toBeUndefined();
    const images = await startedProvider({ OPENAI_BASE_URL: 'https://upstream.example', ANTSEED_ALLOWED_SERVICES: 'gpt-image-1' });
    expect(images.serviceCapabilities?.['gpt-image-1']).toEqual({ outputs: ['image'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recognises only the documented entry shapes', () => {
    expect(modelEntryReasoning(null)).toBeNull();
    expect(modelEntryReasoning({ id: 'x' })).toBeNull();
    expect(modelEntryReasoning({ id: 'x', capabilities: { reasoning_effort: null } })).toBeNull();
    expect(modelEntryReasoning({ id: 'x', effort: {} })).toBeNull();
    expect(modelEntryReasoning({ id: 'x', effort: { supported_levels: ['none'] } })).toEqual({ efforts: ['none'], reasons: false });
  });
});
