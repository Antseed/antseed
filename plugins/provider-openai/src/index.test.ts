import { describe, it, expect, vi } from 'vitest';
import plugin from './index.js';

async function serializeForm(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const encoded = new Response(form);
  return {
    body: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encoded.headers.get('content-type') ?? '',
  };
}

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
    expect(keys).toContain('ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON');
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
      expect(provider.serviceCapabilities?.[service]).toEqual({
        outputs: ['image'],
        inputs: ['text'],
      });
    }
  });

  it('advertises Venice image input only for explicitly paired edit services', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_BASE_URL: 'https://api.venice.ai/api',
      ANTSEED_ALLOWED_SERVICES: 'grok-imagine-image-quality,venice-sd35',
      ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: JSON.stringify({
        'grok-imagine-image-quality': 'grok-imagine-quality-edit',
      }),
      ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({
        'grok-imagine-image-quality': { supportedParameters: ['quality'] },
        'venice-sd35': { inputs: ['text', 'image'] },
      }),
    });

    expect(provider.serviceCapabilities?.['grok-imagine-image-quality']).toEqual({
      outputs: ['image'],
      inputs: ['text', 'image'],
      supportedParameters: ['image', 'moderation', 'quality'],
    });
    expect(provider.serviceCapabilities?.['venice-sd35']).toEqual({
      outputs: ['image'],
      inputs: ['text'],
    });
  });

  it('translates OpenAI multipart edits to the configured Venice native model', async () => {
    const originalFetch = globalThis.fetch;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-venice-enhanced-prompt': 'make%20the%20sky%20warmer',
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-test-key',
        OPENAI_BASE_URL: 'https://api.venice.ai/api',
        ANTSEED_ALLOWED_SERVICES: 'cover-art',
        ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"grok-imagine-image-quality"}',
        ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"cover-art":"grok-imagine-quality-edit"}',
      });
      const form = new FormData();
      form.append('model', 'cover-art');
      form.append('prompt', 'make the sky warmer');
      form.append('n', '1');
      form.append('response_format', 'b64_json');
      form.append('moderation', 'low');
      form.append('resolution', '1K');
      form.append('image', new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }), 'source.png');
      const encoded = await serializeForm(form);

      const response = await provider.handleRequest({
        requestId: 'req-venice-edit',
        method: 'POST',
        path: '/v1/images/edits',
        headers: {
          'content-type': encoded.contentType,
          'x-antseed-service': 'cover-art',
        },
        body: encoded.body,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.venice.ai/api/v1/image/edit');
      const upstreamForm = await new Request(url, {
        method: 'POST',
        headers: requestInit.headers,
        body: requestInit.body,
      }).formData();
      expect(upstreamForm.get('model')).toBe('grok-imagine-quality-edit');
      expect(upstreamForm.get('prompt')).toBe('make the sky warmer');
      expect(upstreamForm.get('safe_mode')).toBe('false');
      expect(upstreamForm.get('resolution')).toBe('1K');
      expect(upstreamForm.has('quality')).toBe(false);
      expect(upstreamForm.has('n')).toBe(false);
      expect(upstreamForm.has('response_format')).toBe(false);
      expect(upstreamForm.has('moderation')).toBe(false);
      const upstreamImage = upstreamForm.get('image');
      expect(upstreamImage).toBeInstanceOf(Blob);
      expect(Array.from(new Uint8Array(await (upstreamImage as Blob).arrayBuffer()))).toEqual([4, 5, 6]);

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/json');
      const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
        data: Array<{ b64_json?: string; revised_prompt?: string }>;
      };
      expect(payload.data).toEqual([{
        b64_json: Buffer.from(png).toString('base64'),
        revised_prompt: 'make the sky warmer',
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const { label, header, images } of [
    { label: 'a single image named by the service header', header: true, images: 1 },
    { label: 'a single image named only by the form model', header: false, images: 1 },
    { label: 'several images named only by the form model', header: false, images: 2 },
  ]) {
    it(`fails Venice edits of ${label} over to a service-scoped backup with the native edit model`, async () => {
      const originalFetch = globalThis.fetch;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('{"error":"quota"}', { status: 429, headers: { 'content-type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        const provider = await plugin.createProvider({
          OPENAI_API_KEY: 'sk-main',
          OPENAI_BASE_URL: 'https://api.venice.ai/api',
          ANTSEED_ALLOWED_SERVICES: 'cover-art',
          ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"grok-imagine-image-quality"}',
          ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"cover-art":"grok-imagine-quality-edit"}',
          ANTSEED_FALLBACK_UPSTREAMS_JSON: JSON.stringify([{
            baseUrl: 'https://backup.venice.example/api',
            apiKey: 'sk-backup',
            services: ['cover-art'],
            serviceAliasMap: { 'cover-art': 'backup-generation-model' },
          }]),
        });
        const form = new FormData();
        form.append('model', 'cover-art');
        form.append('prompt', 'make the sky warmer');
        for (let index = 0; index < images; index++) {
          form.append(images > 1 ? 'image[]' : 'image', new Blob([new Uint8Array([4, 5, index])], { type: 'image/png' }), `source-${index}.png`);
        }
        const encoded = await serializeForm(form);

        const response = await provider.handleRequest({
          requestId: 'req-venice-edit-fallback',
          method: 'POST',
          path: '/v1/images/edits',
          headers: {
            'content-type': encoded.contentType,
            ...(header ? { 'x-antseed-service': 'cover-art' } : {}),
          },
          body: encoded.body,
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [url, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(url).toBe(`https://backup.venice.example/api/v1/image/${images > 1 ? 'multi-edit' : 'edit'}`);
        expect((requestInit.headers as Record<string, string>)['authorization']).toBe('Bearer sk-backup');
        const upstreamForm = await new Request(url, {
          method: 'POST',
          headers: requestInit.headers,
          body: requestInit.body,
        }).formData();
        expect(upstreamForm.get(images > 1 ? 'modelId' : 'model')).toBe('grok-imagine-quality-edit');
        expect(upstreamForm.has(images > 1 ? 'model' : 'modelId')).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        warn.mockRestore();
      }
    });
  }

  it('keeps first-prompt Venice generation on the configured generation model', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'generated-image' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-test-key',
        OPENAI_BASE_URL: 'https://api.venice.ai/api',
        ANTSEED_ALLOWED_SERVICES: 'cover-art',
        ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"grok-imagine-image-quality"}',
        ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"cover-art":"grok-imagine-quality-edit"}',
      });

      const response = await provider.handleRequest({
        requestId: 'req-venice-generation',
        method: 'POST',
        path: '/v1/images/generations',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          model: 'cover-art',
          prompt: 'a warm Venice sunset',
        })),
      });

      expect(response.statusCode).toBe(200);
      const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.venice.ai/api/v1/images/generations');
      expect(JSON.parse(new TextDecoder().decode(requestInit.body as Uint8Array))).toMatchObject({
        model: 'grok-imagine-image-quality',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects Venice edits before fetch when the generation service has no edit pairing', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-test-key',
        OPENAI_BASE_URL: 'https://api.venice.ai/api',
        ANTSEED_ALLOWED_SERVICES: 'venice-sd35',
      });
      const form = new FormData();
      form.append('model', 'venice-sd35');
      form.append('prompt', 'make it warmer');
      form.append('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'source.png');
      const encoded = await serializeForm(form);

      const response = await provider.handleRequest({
        requestId: 'req-unsupported-edit',
        method: 'POST',
        path: '/v1/images/edits',
        headers: { 'content-type': encoded.contentType },
        body: encoded.body,
      });

      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(new TextDecoder().decode(response.body)).toContain('does not have a Venice image edit model configured');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(['size', 'background', 'output_compression', 'user', 'unexpected']) (
    'rejects unsupported Venice edit field %s before fetch',
    async (field) => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        const provider = await plugin.createProvider({
          OPENAI_API_KEY: 'sk-test-key',
          OPENAI_PROVIDER_FLAVOR: 'venice',
          ANTSEED_ALLOWED_SERVICES: 'cover-art',
          ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"grok-imagine-image-quality"}',
          ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"cover-art":"qwen-edit"}',
        });
        const form = new FormData();
        form.append('model', 'cover-art');
        form.append('prompt', 'make it warmer');
        form.append(field, 'unsupported-value');
        form.append('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'source.png');
        const encoded = await serializeForm(form);

        const response = await provider.handleRequest({
          requestId: `req-unsupported-${field}`,
          method: 'POST',
          path: '/v1/images/edits',
          headers: { 'content-type': encoded.contentType },
          body: encoded.body,
        });

        expect(response.statusCode).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
          error: {
            message: `Venice image edits do not support the "${field}" field.`,
            type: 'invalid_request_error',
            param: field,
          },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  it('rejects response_format=url before sending a Venice edit upstream', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-test-key',
        OPENAI_PROVIDER_FLAVOR: 'venice',
        ANTSEED_ALLOWED_SERVICES: 'cover-art',
        ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"grok-imagine-image-quality"}',
        ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"cover-art":"qwen-edit"}',
      });
      const form = new FormData();
      form.append('model', 'cover-art');
      form.append('prompt', 'make it warmer');
      form.append('response_format', 'url');
      form.append('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'source.png');
      const encoded = await serializeForm(form);

      const response = await provider.handleRequest({
        requestId: 'req-url-format',
        method: 'POST',
        path: '/v1/images/edits',
        headers: { 'content-type': encoded.contentType },
        body: encoded.body,
      });

      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.parse(new TextDecoder().decode(response.body))).toMatchObject({
        error: {
          message: 'Venice image edits support only response_format="b64_json".',
          type: 'invalid_request_error',
          param: 'response_format',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects conflicting moderation and safe_mode fields before fetch', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-test-key',
        OPENAI_PROVIDER_FLAVOR: 'venice',
        ANTSEED_ALLOWED_SERVICES: 'grok-imagine-image-quality',
        ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"grok-imagine-image-quality":"qwen-edit"}',
      });
      const form = new FormData();
      form.append('model', 'grok-imagine-image-quality');
      form.append('prompt', 'make it warmer');
      form.append('moderation', 'low');
      form.append('safe_mode', 'true');
      form.append('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'source.png');
      const encoded = await serializeForm(form);

      const response = await provider.handleRequest({
        requestId: 'req-conflicting-moderation',
        method: 'POST',
        path: '/v1/images/edits',
        headers: { 'content-type': encoded.contentType },
        body: encoded.body,
      });

      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(new TextDecoder().decode(response.body)).toContain(
        'moderation and safe_mode cannot both be provided',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves Venice edit status and normalizes string errors for OpenAI clients', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'model overloaded' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = await plugin.createProvider({
        OPENAI_API_KEY: 'sk-test-key',
        OPENAI_PROVIDER_FLAVOR: 'venice',
        ANTSEED_ALLOWED_SERVICES: 'qwen-image-3-pro',
        ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"qwen-image-3-pro":"qwen-image-3-pro-edit"}',
      });
      const form = new FormData();
      form.append('model', 'qwen-image-3-pro');
      form.append('prompt', 'add a red umbrella');
      form.append('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'source.png');
      const encoded = await serializeForm(form);

      const response = await provider.handleRequest({
        requestId: 'req-venice-error',
        method: 'POST',
        path: '/v1/images/edits',
        headers: { 'content-type': encoded.contentType },
        body: encoded.body,
      });

      expect(response.statusCode).toBe(503);
      expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
        error: { message: 'model overloaded', type: 'upstream_error' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects edit mappings for unknown or non-image services', () => {
    expect(() => plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_PROVIDER_FLAVOR: 'venice',
      ANTSEED_ALLOWED_SERVICES: 'venice-sd35',
      ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"missing":"qwen-edit"}',
    })).toThrow('unknown service "missing"');
    expect(() => plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_PROVIDER_FLAVOR: 'venice',
      ANTSEED_ALLOWED_SERVICES: 'gpt-5.5',
      ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"gpt-5.5":"qwen-edit"}',
    })).toThrow('non-image service "gpt-5.5"');
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
