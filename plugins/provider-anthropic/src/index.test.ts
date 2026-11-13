import { describe, it, expect, vi, afterEach } from 'vitest';
import plugin from './index.js';

describe('provider-anthropic plugin', () => {
  it('has correct name and metadata', () => {
    expect(plugin.name).toBe('anthropic');
    expect(plugin.displayName).toBe('Anthropic');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('has configSchema with expected fields', () => {
    const keys = plugin.configSchema!.map((f) => f.key);
    expect(keys).toContain('ANTHROPIC_API_KEY');
    expect(keys).toContain('ANTSEED_INPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_OUTPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_MAX_CONCURRENCY');
    expect(keys).toContain('ANTSEED_ALLOWED_SERVICES');
    expect(keys).not.toContain('ANTSEED_AUTH_TYPE');
  });

  it('requires API key', () => {
    expect(() => plugin.createProvider({})).toThrow('ANTHROPIC_API_KEY is required');
  });

  it('creates provider with API key', () => {
    const provider = plugin.createProvider({
      ANTHROPIC_API_KEY: 'sk-test-key',
    });
    expect(provider.name).toBe('anthropic');
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(10);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(10);
    expect(provider.maxConcurrency).toBe(10);
  });

  it('applies custom pricing', () => {
    const provider = plugin.createProvider({
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTSEED_INPUT_USD_PER_MILLION: '5',
      ANTSEED_OUTPUT_USD_PER_MILLION: '15',
    });
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(5);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(15);
  });

  it('applies custom concurrency', () => {
    const provider = plugin.createProvider({
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTSEED_MAX_CONCURRENCY: '5',
    });
    expect(provider.maxConcurrency).toBe(5);
  });
});

describe('provider-anthropic upstream request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function upstreamRequest(
    body: Record<string, unknown>,
    options: { headers?: Record<string, string>; stream?: boolean; config?: Record<string, string> } = {},
  ): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = plugin.createProvider({ ANTHROPIC_API_KEY: 'sk-test-key', ...options.config });
    const request = {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: new TextEncoder().encode(JSON.stringify(body)),
    };
    if (options.stream) {
      await provider.handleRequestStream!(request, { onResponseStart: () => undefined, onResponseChunk: () => undefined });
    } else {
      await provider.handleRequest(request);
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return {
      headers: init.headers as Record<string, string>,
      body: JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>,
    };
  }

  const messages = [{ role: 'user', content: 'hi' }];
  const sampling = { temperature: 0.7, top_p: 0.9, top_k: 5 };

  it('drops sampling fields for a model that rejects them', async () => {
    const sent = await upstreamRequest({ model: 'claude-haiku-5-5', max_tokens: 8, ...sampling, messages });
    expect(sent.body).toEqual({ model: 'claude-haiku-5-5', max_tokens: 8, messages });
  });

  it('drops them on a streaming request too', async () => {
    const sent = await upstreamRequest({ model: 'claude-opus-4-7', max_tokens: 8, stream: true, ...sampling, messages }, { stream: true });
    expect(sent.body).toEqual({ model: 'claude-opus-4-7', max_tokens: 8, stream: true, messages });
  });

  it('judges the upstream model an announced service maps to', async () => {
    const sent = await upstreamRequest(
      { model: 'fast', max_tokens: 8, temperature: 0, messages },
      { config: { ANTSEED_ALLOWED_SERVICES: 'fast', ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"fast":"claude-haiku-5-5"}' } },
    );
    expect(sent.body).toEqual({ model: 'claude-haiku-5-5', max_tokens: 8, messages });
  });

  it('keeps sampling fields for a model that accepts them', async () => {
    const sent = await upstreamRequest({ model: 'claude-haiku-4-5', max_tokens: 8, temperature: 0.7, messages });
    expect(sent.body.temperature).toBe(0.7);
  });

  it('leaves them to the upstream on an API version that rejects them for a model that honors them', async () => {
    const sent = await upstreamRequest(
      { model: 'claude-haiku-4-5', max_tokens: 8, temperature: 0.7, messages },
      { headers: { 'anthropic-version': '2026-10-21' } },
    );
    expect(sent.body.temperature).toBe(0.7);
    expect(sent.headers['anthropic-version']).toBe('2026-10-21');
  });

  it('adds anthropic-version when the request has none', async () => {
    const sent = await upstreamRequest({ model: 'claude-haiku-5-5', max_tokens: 8, messages });
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('keeps the anthropic-version and anthropic-beta the request sent', async () => {
    const sent = await upstreamRequest(
      { model: 'claude-haiku-5-5', max_tokens: 8, messages },
      { headers: { 'Anthropic-Version': '2026-10-21', 'anthropic-beta': 'example-beta-2026-01-01' } },
    );
    expect(sent.headers['Anthropic-Version']).toBe('2026-10-21');
    expect(sent.headers['anthropic-version']).toBeUndefined();
    expect(sent.headers['anthropic-beta']).toBe('example-beta-2026-01-01');
  });
});
