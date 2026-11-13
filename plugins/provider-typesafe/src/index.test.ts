import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

describe('provider-typesafe plugin', () => {
  it('has correct name and metadata', () => {
    expect(plugin.name).toBe('typesafe');
    expect(plugin.displayName).toBe('TypeSafe');
    expect(plugin.type).toBe('provider');
    const keys = plugin.configSchema!.map((f) => f.key);
    expect(keys).toContain('TYPESAFE_API_KEY');
    expect(keys).toContain('TYPESAFE_BASE_URL');
    expect(keys).toContain('ANTSEED_ALLOWED_SERVICES');
  });

  it('requires an API key', () => {
    expect(() => plugin.createProvider({})).toThrow('TYPESAFE_API_KEY is required');
  });

  it('advertises every service as typesafe-systemone with input-only default pricing', () => {
    const provider = plugin.createProvider({
      TYPESAFE_API_KEY: 'ts-test-key',
      ANTSEED_ALLOWED_SERVICES: 'jev-latest, jev',
    });
    expect(provider.name).toBe('typesafe');
    expect(provider.services).toEqual(['jev-latest', 'jev']);
    expect(provider.serviceApiProtocols).toEqual({
      'jev-latest': ['typesafe-systemone'],
      jev: ['typesafe-systemone'],
    });
    expect(provider.pricing.defaults).toEqual({ inputUsdPerMillion: 0.05, outputUsdPerMillion: 0 });
    expect(provider.maxConcurrency).toBe(10);
  });

  it('relays /v1/systemone to the upstream with alias rewrite and bearer auth', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        model: 'jev-latest',
        answers: { is_urgent: { type: 'noul', noul: 0.92 } },
        usage: { input_tokens: 12, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = plugin.createProvider({
        TYPESAFE_API_KEY: 'ts-test-key',
        TYPESAFE_BASE_URL: 'https://api.example.test',
        ANTSEED_ALLOWED_SERVICES: 'jev',
        ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"jev":"jev-latest"}',
      });

      const response = await provider.handleRequest({
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/systemone',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          model: 'jev',
          state: 'Help! My payouts have been failing for 3 days.',
          questions: { is_urgent: { type: 'noul', instructions: 'The message conveys urgency' } },
        })),
      });

      expect(response.statusCode).toBe(200);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.test/v1/systemone');
      const headers = init.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer ts-test-key');
      const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as { model?: string; state?: string };
      expect(body.model).toBe('jev-latest');
      expect(body.state).toBe('Help! My payouts have been failing for 3 days.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
