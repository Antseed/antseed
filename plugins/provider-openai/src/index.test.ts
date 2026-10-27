import { describe, it, expect, vi } from 'vitest';
import plugin from './index.js';

describe('provider-openai plugin', () => {
  it('has correct name and metadata', () => {
    expect(plugin.name).toBe('openai');
    expect(plugin.displayName).toBe('OpenAI-Compatible');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('has configSchema with expected fields', () => {
    const keys = plugin.configSchema!.map((f) => f.key);
    expect(keys).toContain('OPENAI_API_KEY');
    expect(keys).toContain('OPENAI_BASE_URL');
    expect(keys).toContain('OPENAI_PROVIDER_FLAVOR');
    expect(keys).toContain('OPENAI_UPSTREAM_PROVIDER');
    expect(keys).toContain('ANTSEED_SERVICE_ALIAS_MAP_JSON');
    expect(keys).toContain('ANTSEED_INPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_OUTPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_MAX_CONCURRENCY');
    expect(keys).toContain('ANTSEED_ALLOWED_SERVICES');
    expect(keys).toContain('ANTSEED_FALLBACK_UPSTREAMS_JSON');
  });

  it('serves a service from a fallback upstream when the main upstream is out of quota', async () => {
    const originalFetch = globalThis.fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"quota"}', { status: 429, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{"id":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-main',
        OPENAI_BASE_URL: 'https://api.moonshot.example',
        ANTSEED_ALLOWED_SERVICES: 'kimi-k3.1-pro',
        ANTSEED_FALLBACK_UPSTREAMS_JSON: JSON.stringify([{
          baseUrl: 'https://openrouter.example/api',
          apiKey: 'sk-backup',
          serviceAliasMap: { 'kimi-k3.1-pro': 'moonshotai/kimi-k3.1-pro' },
        }]),
      });

      const response = await provider.handleRequest({
        requestId: 'req-kimi-1',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'kimi-k3.1-pro', messages: [] })),
      });

      expect(response.statusCode).toBe(200);
      const [url, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('https://openrouter.example/api/v1/chat/completions');
      expect((requestInit.headers as Record<string, string>)['authorization']).toBe('Bearer sk-backup');
      expect(JSON.parse(new TextDecoder().decode(requestInit.body as Uint8Array)).model).toBe('moonshotai/kimi-k3.1-pro');
    } finally {
      globalThis.fetch = originalFetch;
      warn.mockRestore();
    }
  });

  it('creates provider with valid config', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
    });
    expect(provider.name).toBe('openai');
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(10);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(10);
    expect(provider.maxConcurrency).toBe(10);
  });

  it('supports openrouter flavor-specific behavior', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_PROVIDER_FLAVOR: 'openrouter',
      OPENAI_UPSTREAM_PROVIDER: 'together',
    });

    expect(provider.name).toBe('openai');
  });

  it('requires API key', () => {
    expect(() => plugin.createProvider({})).toThrow('OPENAI_API_KEY is required');
  });

  it('applies custom pricing and concurrency', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      ANTSEED_INPUT_USD_PER_MILLION: '3',
      ANTSEED_OUTPUT_USD_PER_MILLION: '7',
      ANTSEED_MAX_CONCURRENCY: '5',
    });
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(3);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(7);
    expect(provider.maxConcurrency).toBe(5);
  });

  it('advertises and rewrites aliased image services correctly', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-test-key',
        ANTSEED_ALLOWED_SERVICES: 'cover-art',
        ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"gpt-image-1"}',
        ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({
          'cover-art': {
            'openai-images': {
              version: 1,
              components: [],
            },
          },
        }),
      });

      expect(provider.serviceApiProtocols?.['cover-art']).toEqual(['openai-images']);
      expect(provider.serviceUnitBillingModels?.['cover-art']?.['openai-images']).toEqual({
        version: 1,
        components: [],
      });

      const response = await provider.handleRequest({
        requestId: 'req-image-1',
        method: 'POST',
        path: '/v1/images/generations',
        headers: {
          'content-type': 'application/json',
        },
        body: new TextEncoder().encode(JSON.stringify({ model: 'cover-art', prompt: 'tiny purple cube' })),
      });

      expect(response.statusCode).toBe(200);
      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsedBody = JSON.parse(
        new TextDecoder().decode((requestInit.body as Uint8Array) ?? new Uint8Array(0)),
      ) as { model?: string };
      expect(parsedBody.model).toBe('gpt-image-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('allows image services without explicit billing as free/default', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      ANTSEED_ALLOWED_SERVICES: 'cover-art',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"gpt-image-1"}',
    });

    expect(provider.serviceApiProtocols?.['cover-art']).toEqual(['openai-images']);
    expect(provider.serviceUnitBillingModels).toBeUndefined();
  });

  it('advertises image billing only when explicitly configured', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      ANTSEED_ALLOWED_SERVICES: 'cover-art',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"gpt-image-1"}',
      ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({
        'cover-art': {
          'openai-images': {
            version: 1,
            components: [
              {
                unit: 'output_images',
                priceUsd: 0.00816,
                match: { size: '1024x1024', quality: 'low' },
              },
            ],
          },
        },
      }),
    });

    expect(provider.serviceUnitBillingModels?.['cover-art']?.['openai-images']).toEqual({
      version: 1,
      components: [
        {
          unit: 'output_images',
          priceUsd: 0.00816,
          match: { size: '1024x1024', quality: 'low' },
        },
      ],
    });
  });

  it('defaults image services to outputs: ["image"] capabilities', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      ANTSEED_ALLOWED_SERVICES: 'cover-art,gpt-5.5',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"gpt-image-1"}',
    });

    expect(provider.serviceCapabilities?.['cover-art']).toEqual({ outputs: ['image'] });
    expect(provider.serviceCapabilities?.['gpt-5.5']).toBeUndefined();
  });

  it('lets explicit capability config override the image-service default', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      ANTSEED_ALLOWED_SERVICES: 'cover-art',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"gpt-image-1"}',
      ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({
        'cover-art': {
          inputs: ['text', 'image'],
          supportedParameters: ['background', 'output_format', 'quality', 'size'],
        },
      }),
    });

    expect(provider.serviceCapabilities?.['cover-art']).toEqual({
      outputs: ['image'],
      inputs: ['text', 'image'],
      supportedParameters: ['background', 'output_format', 'quality', 'size'],
    });
  });

  it('advertises supported image model families as openai-images', async () => {
    const imageServices = [
      'grok-imagine-image',
      'grok-imagine-image-quality',
      'venice-sd35',
      'flux-2-pro',
      'krea-v2-large',
      'nano-banana-pro',
      'qwen-image-3-pro',
      'wan-2-7-pro-text-to-image',
    ];
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_BASE_URL: 'https://api.venice.ai/api',
      ANTSEED_ALLOWED_SERVICES: imageServices.join(','),
    });

    for (const service of imageServices) {
      expect(provider.serviceApiProtocols?.[service]).toEqual(['openai-images']);
      expect(provider.serviceCapabilities?.[service]).toEqual({ outputs: ['image'] });
    }
  });

  it('does not advertise image services for openrouter flavor yet', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_PROVIDER_FLAVOR: 'openrouter',
      ANTSEED_ALLOWED_SERVICES: 'cover-art',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"openai/gpt-image-1"}',
    });

    expect(provider.serviceApiProtocols?.['cover-art']).toBeUndefined();
  });

  it('rewrites announced service names via ANTSEED_SERVICE_ALIAS_MAP_JSON', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-test-key',
        ANTSEED_ALLOWED_SERVICES: 'kimi2.5',
        ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"kimi2.5":"together/kimi2.5"}',
      });

      const response = await provider.handleRequest({
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
        },
        body: new TextEncoder().encode(JSON.stringify({ model: 'kimi2.5', messages: [] })),
      });

      expect(response.statusCode).toBe(200);
      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsedBody = JSON.parse(
        new TextDecoder().decode((requestInit.body as Uint8Array) ?? new Uint8Array(0)),
      ) as { model?: string };
      expect(parsedBody.model).toBe('together/kimi2.5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
