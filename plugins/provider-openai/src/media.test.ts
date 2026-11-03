import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin from './index.js';
import { veniceSpeechOptions } from './speech.js';

async function serializeForm(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const response = new Response(form);
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? '',
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers each upstream call with `response()`; pass several to answer calls in order. */
function mockFetch(...responses: Array<() => Response>) {
  let call = 0;
  const fetchMock = vi.fn().mockImplementation(async () => responses[Math.min(call++, responses.length - 1)]!());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function upstreamForm(fetchMock: ReturnType<typeof vi.fn>, call = 0): Promise<{ url: string; form: FormData; init: RequestInit }> {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return { url, init, form: await new Request(url, { method: 'POST', headers: init.headers, body: init.body }).formData() };
}

const veniceEditConfig = {
  OPENAI_API_KEY: 'sk-test-key',
  OPENAI_BASE_URL: 'https://api.venice.ai/api',
  ANTSEED_ALLOWED_SERVICES: 'nano-banana-pro',
  ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"nano-banana-pro":"nano-banana-pro-edit"}',
};

describe('Venice multi-image edits', () => {
  it('sends several images to /image/multi-edit with modelId and wraps the result', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const fetchMock = mockFetch(() => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }));
    const provider = await plugin.createProvider(veniceEditConfig);
    const form = new FormData();
    form.append('model', 'nano-banana-pro');
    form.append('prompt', 'put the cat from the second image on the sofa');
    form.append('image[]', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'sofa.png');
    form.append('image[]', new Blob([new Uint8Array([2])], { type: 'image/png' }), 'cat.png');
    const encoded = await serializeForm(form);

    const response = await provider.handleRequest({
      requestId: 'req-multi',
      method: 'POST',
      path: '/v1/images/edits',
      headers: { 'content-type': encoded.contentType },
      body: encoded.body,
    });

    const { url, form: sent } = await upstreamForm(fetchMock);
    expect(url).toBe('https://api.venice.ai/api/v1/image/multi-edit');
    expect(sent.get('modelId')).toBe('nano-banana-pro-edit');
    expect(sent.has('model')).toBe(false);
    const images = sent.getAll('images') as Blob[];
    expect(await Promise.all(images.map(async (image) => Array.from(new Uint8Array(await image.arrayBuffer()))))).toEqual([[1], [2]]);
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(new TextDecoder().decode(response.body)) as { created: number; data: Array<{ b64_json: string }> };
    expect(payload.data).toEqual([{ b64_json: Buffer.from(png).toString('base64') }]);
    expect(typeof payload.created).toBe('number');
  });

  it('keeps the form order of images sent under both field names, so the base stays first', async () => {
    const fetchMock = mockFetch(() => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } }));
    const provider = await plugin.createProvider(veniceEditConfig);
    const form = new FormData();
    form.append('model', 'nano-banana-pro');
    form.append('prompt', 'put the cat on the sofa');
    form.append('image[]', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'sofa.png');
    form.append('image', new Blob([new Uint8Array([2])], { type: 'image/png' }), 'cat.png');
    const encoded = await serializeForm(form);

    await provider.handleRequest({
      requestId: 'req-mixed',
      method: 'POST',
      path: '/v1/images/edits',
      headers: { 'content-type': encoded.contentType },
      body: encoded.body,
    });

    const { form: sent } = await upstreamForm(fetchMock);
    const images = sent.getAll('images') as Blob[];
    expect(await Promise.all(images.map(async (image) => Array.from(new Uint8Array(await image.arrayBuffer()))))).toEqual([[1], [2]]);
  });

  it('sends a single image with quality to /image/multi-edit, which is the Venice edit that takes quality', async () => {
    const fetchMock = mockFetch(() => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const provider = await plugin.createProvider(veniceEditConfig);
    const form = new FormData();
    form.append('model', 'nano-banana-pro');
    form.append('prompt', 'make it night');
    form.append('quality', 'low');
    form.append('image', new Blob([new Uint8Array([7])], { type: 'image/png' }), 'source.png');
    const encoded = await serializeForm(form);

    await provider.handleRequest({
      requestId: 'req-quality',
      method: 'POST',
      path: '/v1/images/edits',
      headers: { 'content-type': encoded.contentType },
      body: encoded.body,
    });

    const { url, form: sent } = await upstreamForm(fetchMock);
    expect(url).toBe('https://api.venice.ai/api/v1/image/multi-edit');
    expect(sent.get('quality')).toBe('low');
    expect(sent.getAll('images')).toHaveLength(1);
  });

  it('keeps Venice errors as errors, which bill no images', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: 'Invalid request parameters' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const provider = await plugin.createProvider(veniceEditConfig);
    const form = new FormData();
    form.append('model', 'nano-banana-pro');
    form.append('prompt', 'x');
    form.append('image', new Blob([new Uint8Array([7])], { type: 'image/png' }), 'source.png');
    const encoded = await serializeForm(form);

    const response = await provider.handleRequest({
      requestId: 'req-error',
      method: 'POST',
      path: '/v1/images/edits',
      headers: { 'content-type': encoded.contentType },
      body: encoded.body,
    });

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(new TextDecoder().decode(response.body)) as { data?: unknown; error: { message: string } };
    expect(payload.data).toBeUndefined();
    expect(payload.error.message).toBe('Invalid request parameters');
  });

  it('advertises the image parameter that buyer routing requires of an edit route', async () => {
    const provider = await plugin.createProvider(veniceEditConfig);
    expect(provider.serviceCapabilities?.['nano-banana-pro']?.supportedParameters).toEqual(['image', 'moderation']);
    expect(provider.serviceCapabilities?.['nano-banana-pro']?.inputs).toEqual(['text', 'image']);
  });
});

/** A Venice seller whose `cover-art` service generates with one model and edits with another. */
const coverArtConfig = {
  OPENAI_API_KEY: 'sk-test-key',
  OPENAI_BASE_URL: 'https://api.venice.ai/api',
  ANTSEED_ALLOWED_SERVICES: 'cover-art',
  ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"cover-art":"grok-imagine-image-quality"}',
  ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"cover-art":"grok-imagine-quality-edit"}',
};

function imageEditForm(model: string, fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', 'make it warmer');
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'source.png');
  return form;
}

async function sendImageEdit(
  provider: Awaited<ReturnType<typeof plugin.createProvider>>,
  form: FormData,
  headers: Record<string, string> = {},
) {
  const encoded = await serializeForm(form);
  return provider.handleRequest({
    requestId: 'req-venice-edit',
    method: 'POST',
    path: '/v1/images/edits',
    headers: { 'content-type': encoded.contentType, ...headers },
    body: encoded.body,
  });
}

const neverCalled = () => new Response('unexpected', { status: 500 });

describe('Venice image edits', () => {
  it('translates OpenAI multipart edits to the configured Venice native model', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fetchMock = mockFetch(() => new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'x-venice-enhanced-prompt': 'make%20the%20sky%20warmer' },
    }));
    const provider = await plugin.createProvider(coverArtConfig);
    const form = new FormData();
    form.append('model', 'cover-art');
    form.append('prompt', 'make the sky warmer');
    form.append('n', '1');
    form.append('response_format', 'b64_json');
    form.append('moderation', 'low');
    form.append('resolution', '1K');
    form.append('image', new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }), 'source.png');

    const response = await sendImageEdit(provider, form, { 'x-antseed-service': 'cover-art' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, form: sent } = await upstreamForm(fetchMock);
    expect(url).toBe('https://api.venice.ai/api/v1/image/edit');
    expect(sent.get('model')).toBe('grok-imagine-quality-edit');
    expect(sent.get('prompt')).toBe('make the sky warmer');
    expect(sent.get('safe_mode')).toBe('false');
    expect(sent.get('resolution')).toBe('1K');
    expect(sent.has('quality')).toBe(false);
    expect(sent.has('n')).toBe(false);
    expect(sent.has('response_format')).toBe(false);
    expect(sent.has('moderation')).toBe(false);
    const upstreamImage = sent.get('image');
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
  });

  for (const { label, header, images } of [
    { label: 'a single image named by the service header', header: true, images: 1 },
    { label: 'a single image named only by the form model', header: false, images: 1 },
    { label: 'several images named only by the form model', header: false, images: 2 },
  ]) {
    it(`fails edits of ${label} over to a service-scoped backup with the native edit model`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const fetchMock = mockFetch(
          () => new Response('{"error":"quota"}', { status: 429, headers: { 'content-type': 'application/json' } }),
          () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }),
        );
        const provider = await plugin.createProvider({
          ...coverArtConfig,
          OPENAI_API_KEY: 'sk-main',
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

        const response = await sendImageEdit(provider, form, header ? { 'x-antseed-service': 'cover-art' } : {});

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const { url, init, form: sent } = await upstreamForm(fetchMock, 1);
        expect(url).toBe(`https://backup.venice.example/api/v1/image/${images > 1 ? 'multi-edit' : 'edit'}`);
        expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-backup');
        expect(sent.get(images > 1 ? 'modelId' : 'model')).toBe('grok-imagine-quality-edit');
        expect(sent.has(images > 1 ? 'model' : 'modelId')).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });
  }

  it('keeps first-prompt Venice generation on the configured generation model', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({ data: [{ b64_json: 'generated-image' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = await plugin.createProvider(coverArtConfig);

    const response = await provider.handleRequest({
      requestId: 'req-venice-generation',
      method: 'POST',
      path: '/v1/images/generations',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'cover-art', prompt: 'a warm Venice sunset' })),
    });

    expect(response.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.venice.ai/api/v1/images/generations');
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toMatchObject({
      model: 'grok-imagine-image-quality',
    });
  });

  it('rejects Venice edits before fetch when the generation service has no edit pairing', async () => {
    const fetchMock = mockFetch(neverCalled);
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_BASE_URL: 'https://api.venice.ai/api',
      ANTSEED_ALLOWED_SERVICES: 'venice-sd35',
    });

    const response = await sendImageEdit(provider, imageEditForm('venice-sd35'));

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(response.body)).toContain('does not have a Venice image edit model configured');
  });

  it.each(['size', 'background', 'output_compression', 'user', 'unexpected'])(
    'rejects unsupported Venice edit field %s before fetch',
    async (field) => {
      const fetchMock = mockFetch(neverCalled);
      const provider = await plugin.createProvider(coverArtConfig);

      const response = await sendImageEdit(provider, imageEditForm('cover-art', { [field]: 'unsupported-value' }));

      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
        error: {
          message: `Venice image edits do not support the "${field}" field.`,
          type: 'invalid_request_error',
          param: field,
        },
      });
    },
  );

  it('rejects response_format=url before sending a Venice edit upstream', async () => {
    const fetchMock = mockFetch(neverCalled);
    const provider = await plugin.createProvider(coverArtConfig);

    const response = await sendImageEdit(provider, imageEditForm('cover-art', { response_format: 'url' }));

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(new TextDecoder().decode(response.body))).toMatchObject({
      error: {
        message: 'Venice image edits support only response_format="b64_json".',
        type: 'invalid_request_error',
        param: 'response_format',
      },
    });
  });

  it('rejects conflicting moderation and safe_mode fields before fetch', async () => {
    const fetchMock = mockFetch(neverCalled);
    const provider = await plugin.createProvider(coverArtConfig);

    const response = await sendImageEdit(provider, imageEditForm('cover-art', { moderation: 'low', safe_mode: 'true' }));

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(response.body)).toContain('moderation and safe_mode cannot both be provided');
  });

  it('preserves Venice edit status and normalizes string errors for OpenAI clients', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: 'model overloaded' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = await plugin.createProvider(coverArtConfig);

    const response = await sendImageEdit(provider, imageEditForm('cover-art'));

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
      error: { message: 'model overloaded', type: 'upstream_error' },
    });
  });
});

const kokoro = {
  id: 'tts-kokoro',
  type: 'tts',
  model_spec: {
    pricing: { input: { usd: 3.5 } },
    default_format: 'mp3',
    supported_formats: ['mp3', 'wav'],
    supports_custom_voice_id: false,
    voices: ['af_sky', 'am_adam'],
  },
};

describe('speech services', () => {
  it('advertises TTS models as openai-audio-speech with text in and audio out', async () => {
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_BASE_URL: 'https://api.openai.com',
      ANTSEED_ALLOWED_SERVICES: 'gpt-4o-mini-tts,tts-1,gpt-4o',
    });
    expect(provider.serviceApiProtocols).toEqual({
      'gpt-4o-mini-tts': ['openai-audio-speech'],
      'tts-1': ['openai-audio-speech'],
      'gpt-4o': ['openai-chat-completions'],
    });
    expect(provider.serviceCapabilities?.['tts-1']).toEqual({ inputs: ['text'], outputs: ['audio'] });
  });

  it('announces the voices Venice lists for each speech model at init', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({ data: [kokoro] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_BASE_URL: 'https://api.venice.ai/api',
      ANTSEED_ALLOWED_SERVICES: 'kokoro,tts-xai-v1',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"kokoro":"tts-kokoro"}',
      ANTSEED_SERVICE_CAPABILITIES_JSON: '{"tts-xai-v1":{"speech":{"voices":["eve"]}}}',
    });
    await provider.init?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.venice.ai/api/v1/models?type=tts');
    expect(provider.serviceCapabilities?.kokoro).toEqual({
      inputs: ['text'],
      outputs: ['audio'],
      speech: { voices: ['af_sky', 'am_adam'], formats: ['mp3', 'wav'], customVoices: false },
    });
    // The seller's own list wins.
    expect(provider.serviceCapabilities?.['tts-xai-v1']?.speech).toEqual({ voices: ['eve'] });
  });

  it('relays speech JSON untouched by body injection and returns the audio bytes', async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
    const fetchMock = mockFetch(() => new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const provider = await plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_BASE_URL: 'https://api.venice.ai/api',
      ANTSEED_ALLOWED_SERVICES: 'tts-kokoro',
      OPENAI_BODY_INJECT_JSON: '{"venice_parameters":{"include_venice_system_prompt":false}}',
    });

    const response = await provider.handleRequest({
      requestId: 'req-tts',
      method: 'POST',
      path: '/v1/audio/speech',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'tts-kokoro', service: 'tts-kokoro', input: 'Hello.', voice: 'af_sky' })),
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.venice.ai/api/v1/audio/speech');
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual({ model: 'tts-kokoro', input: 'Hello.', voice: 'af_sky' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(Array.from(response.body)).toEqual(Array.from(audio));
  });

  it('reads speech options from a Venice model entry', () => {
    expect(veniceSpeechOptions(kokoro)).toEqual({ voices: ['af_sky', 'am_adam'], formats: ['mp3', 'wav'], customVoices: false });
    expect(veniceSpeechOptions({ model_spec: { voices: [] } })).toBeNull();
    expect(veniceSpeechOptions(null)).toBeNull();
  });
});
