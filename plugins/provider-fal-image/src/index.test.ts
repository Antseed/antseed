import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provider, SerializedHttpRequest } from '@antseed/node';
import plugin, { falImageInput, falImageSchema } from './index.js';

afterEach(() => vi.unstubAllGlobals());

const MODEL = 'openai/gpt-image-2';
const EDIT = 'openai/gpt-image-2/edit';
const config = {
  FAL_IMAGE_API_KEY: 'seller-secret',
  ANTSEED_ALLOWED_SERVICES: MODEL,
  ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [MODEL]: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.2 }] } } }),
  ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: JSON.stringify({ [MODEL]: EDIT }),
};
const generation = (body: object, headers: Record<string, string> = {}): SerializedHttpRequest => ({
  requestId: 'r', method: 'POST', path: '/v1/images/generations', headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)),
});
const parse = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString());
const schema = (endpointId: string, properties: Record<string, object>) => ({
  paths: { [`/${endpointId}`]: { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } } } } },
  components: { schemas: { Input: { properties } } },
});
const GPT_IMAGE_FIELDS = {
  prompt: {}, num_images: {}, quality: {}, background: {}, output_format: {}, output_compression: {}, sync_mode: {}, enable_safety_checker: {},
  image_size: { anyOf: [{ $ref: '#/components/schemas/ImageSize' }, { enum: ['square_hd', 'landscape_4_3', 'auto'] }] },
};

/** A provider whose init read the given fal schemas; fal's other calls answer `fal`. */
async function provider(schemas: Record<string, Record<string, object>>, fal: (url: string, init?: RequestInit) => Response, overrides: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const endpoint = new URL(url).searchParams.get('endpoint_id');
    if (url.startsWith('https://fal.ai/api/openapi/')) return schemas[endpoint!] ? Response.json(schema(endpoint!, schemas[endpoint!]!)) : new Response('', { status: 404 });
    if (url.startsWith('https://api.fal.ai/v1/account/billing')) return new Response('', { status: 403 });
    return fal(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const created = plugin.createProvider({ ...config, ...overrides }) as Provider;
  await created.init!();
  return { provider: created, fetchMock };
}

describe('configuration', () => {
  it('validates services, pricing and edit endpoints', () => {
    expect(() => plugin.createProvider({ ...config, FAL_IMAGE_API_KEY: ' ' })).toThrow('FAL_IMAGE_API_KEY');
    expect(() => plugin.createProvider({ ...config, ANTSEED_ALLOWED_SERVICES: 'gpt-image-2' })).toThrow('Invalid fal endpoint ID');
    expect(() => plugin.createProvider({ ...config, ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{}' })).toThrow('Missing openai-images unit pricing');
    expect(() => plugin.createProvider({ ...config, ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: JSON.stringify({ 'fal-ai/other': EDIT }) })).toThrow('unknown service');
    expect(() => plugin.createProvider({ ...config, ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: JSON.stringify({ [MODEL]: '../edit' }) })).toThrow('Invalid fal edit endpoint');
    expect(() => plugin.createProvider({ ...config, ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"a":"b"}' })).toThrow('fal endpoint IDs');
  });

  it('announces OpenAI images with the fields the fal schema takes', async () => {
    const { provider: created } = await provider({ [MODEL]: GPT_IMAGE_FIELDS, [EDIT]: { ...GPT_IMAGE_FIELDS, image_urls: {} } }, () => new Response(''));
    expect(created.serviceApiProtocols).toEqual({ [MODEL]: ['openai-images'] });
    expect(created.serviceCapabilities?.[MODEL]).toEqual({
      inputs: ['text', 'image'],
      outputs: ['image'],
      supportedParameters: ['background', 'enable_safety_checker', 'image', 'moderation', 'n', 'output_compression', 'output_format', 'quality', 'response_format', 'size'],
    });
  });
});

describe('falImageInput', () => {
  const gptImage = falImageSchema(schema(MODEL, GPT_IMAGE_FIELDS), MODEL);

  it('maps n and size to fal fields and asks for inline images', () => {
    expect(falImageInput({ model: MODEL, prompt: ' a cat ', n: 2, size: '1536x1024', quality: 'high', background: 'transparent' }, gptImage)).toEqual({
      prompt: 'a cat', num_images: 2, image_size: { width: 1536, height: 1024 }, quality: 'high', background: 'transparent', sync_mode: true,
    });
    expect(falImageInput({ prompt: 'a cat', size: 'square_hd', response_format: 'url' }, gptImage)).toEqual({ prompt: 'a cat', image_size: 'square_hd' });
    expect(falImageInput({ prompt: 'a cat', size: 'auto' }, gptImage)).toMatchObject({ image_size: 'auto' });
  });

  it('refuses fal fields that would change what the request is billed for', () => {
    for (const field of ['image_size', 'num_images', 'max_images', 'sync_mode', 'image_urls']) {
      expect(() => falImageInput({ prompt: 'x', [field]: 1 }, gptImage)).toThrow(field);
    }
    expect(() => falImageInput({ prompt: 'x', enable_web_search: true }, gptImage)).toThrow('Unsupported field');
  });

  it('refuses priced options the endpoint does not take', () => {
    const flux = falImageSchema(schema('fal-ai/flux-2-pro', { prompt: {}, seed: {}, image_size: { anyOf: [{ enum: ['square_hd'] }] } }), 'fal-ai/flux-2-pro');
    expect(() => falImageInput({ prompt: 'x', n: 2 }, flux)).toThrow('one image per request');
    expect(() => falImageInput({ prompt: 'x', resolution: '4K' }, flux)).toThrow('resolution');
    expect(() => falImageInput({ prompt: 'x', quality: 'high' }, flux)).toThrow('quality');
    expect(() => falImageInput({ prompt: 'x', size: 'huge' }, flux)).toThrow('Unsupported size');
    expect(falImageInput({ prompt: 'x', quality: 'auto', seed: 7 }, flux)).toEqual({ prompt: 'x', seed: 7 });
  });

  it('sends every mapped field when the schema is unknown', () => {
    expect(falImageInput({ prompt: 'x', n: 3, resolution: '2K', moderation: 'low' }, null)).toEqual({
      prompt: 'x', num_images: 3, resolution: '2K', enable_safety_checker: false, sync_mode: true,
    });
    expect(() => falImageInput({ prompt: '' }, null)).toThrow('prompt');
    expect(() => falImageInput({ prompt: 'x', n: 0 }, null)).toThrow('n must be');
  });
});

describe('requests', () => {
  it('generates through fal and answers in OpenAI form', async () => {
    const { provider: created, fetchMock } = await provider({ [MODEL]: GPT_IMAGE_FIELDS }, () => Response.json({
      images: [{ url: 'data:image/png;base64,aW1hZ2Ux' }, { url: 'data:image/png;base64,aW1hZ2Uy' }],
    }));
    const response = await created.handleRequest(generation({ model: MODEL, prompt: 'cat', n: 2 }));
    expect(response.statusCode).toBe(200);
    expect(parse(response.body).data).toEqual([{ b64_json: 'aW1hZ2Ux' }, { b64_json: 'aW1hZ2Uy' }]);
    const [url, init] = fetchMock.mock.calls.find(([target]) => target === `https://fal.run/${MODEL}`)!;
    expect(url).toBe(`https://fal.run/${MODEL}`);
    expect(init?.headers).toMatchObject({ authorization: 'Key seller-secret' });
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: 'cat', num_images: 2, sync_mode: true });
  });

  it('downloads a fal image URL without the seller key, or returns it when asked', async () => {
    const { provider: created, fetchMock } = await provider({}, (url) => url === 'https://v3.fal.media/out.png'
      ? new Response(Buffer.from('png-bytes'))
      : Response.json({ images: [{ url: 'https://v3.fal.media/out.png' }] }));
    const inline = await created.handleRequest(generation({ model: MODEL, prompt: 'cat' }));
    expect(parse(inline.body).data).toEqual([{ b64_json: Buffer.from('png-bytes').toString('base64') }]);
    const download = fetchMock.mock.calls.find(([target]) => target === 'https://v3.fal.media/out.png')!;
    expect(download[1]?.headers).toBeUndefined();
    const linked = await created.handleRequest(generation({ model: MODEL, prompt: 'cat', response_format: 'url' }));
    expect(parse(linked.body).data).toEqual([{ url: 'https://v3.fal.media/out.png' }]);
  });

  it('passes on fal rejections and refuses mismatched or unknown models', async () => {
    const { provider: created } = await provider({}, () => Response.json({ detail: [{ loc: ['body', 'prompt'], msg: 'too long' }] }, { status: 422 }));
    const rejected = await created.handleRequest(generation({ model: MODEL, prompt: 'cat' }));
    expect(rejected.statusCode).toBe(422);
    expect(parse(rejected.body).error.message).toBe('prompt: too long');
    const mismatch = await created.handleRequest(generation({ model: MODEL, prompt: 'cat' }, { 'x-antseed-service': 'fal-ai/other' }));
    expect(mismatch.statusCode).toBe(400);
    const unknown = await created.handleRequest(generation({ model: 'fal-ai/other', prompt: 'cat' }));
    expect(parse(unknown.body).error.param).toBe('model');
  });

  it('sends edit images to the edit endpoint as data URLs', async () => {
    const { provider: created, fetchMock } = await provider({ [EDIT]: { ...GPT_IMAGE_FIELDS, image_urls: {}, mask_url: {} } }, () => Response.json({ images: [{ url: 'data:image/png;base64,ZWRpdGVk' }] }));
    const form = new FormData();
    form.append('model', MODEL);
    form.append('prompt', 'add a hat');
    form.append('image[]', new Blob([Buffer.from('one')], { type: 'image/png' }), 'a.png');
    form.append('image[]', new Blob([Buffer.from('two')], { type: 'image/jpeg' }), 'b.jpg');
    const encoded = new Response(form);
    const response = await created.handleRequest({
      requestId: 'r', method: 'POST', path: '/v1/images/edits',
      headers: { 'content-type': encoded.headers.get('content-type')! }, body: new Uint8Array(await encoded.arrayBuffer()),
    });
    expect(response.statusCode).toBe(200);
    expect(parse(response.body).data).toEqual([{ b64_json: 'ZWRpdGVk' }]);
    const call = fetchMock.mock.calls.find(([target]) => target === `https://fal.run/${EDIT}`)!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      prompt: 'add a hat', sync_mode: true,
      image_urls: [`data:image/png;base64,${Buffer.from('one').toString('base64')}`, `data:image/jpeg;base64,${Buffer.from('two').toString('base64')}`],
    });
  });

  it('refuses edits for a service without an edit endpoint', async () => {
    const { provider: created } = await provider({}, () => Response.json({}), { ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{}' });
    const form = new FormData();
    form.append('model', MODEL);
    form.append('prompt', 'add a hat');
    form.append('image', new Blob([Buffer.from('one')], { type: 'image/png' }), 'a.png');
    const encoded = new Response(form);
    const response = await created.handleRequest({
      requestId: 'r', method: 'POST', path: '/v1/images/edits',
      headers: { 'content-type': encoded.headers.get('content-type')! }, body: new Uint8Array(await encoded.arrayBuffer()),
    });
    expect(response.statusCode).toBe(400);
    expect(parse(response.body).error.message).toContain('does not support image edits');
  });
});

it('marks a service unavailable when fal drops its edit endpoint', async () => {
  const { provider: created } = await provider({}, (url) => url.startsWith('https://api.fal.ai/v1/models?')
    ? (new URL(url).searchParams.getAll('endpoint_id').length > 1
      ? Response.json({ error: { message: 'Endpoint(s) not found' } }, { status: 404 })
      : new URL(url).searchParams.get('endpoint_id') === MODEL
        ? Response.json({ models: [{ endpoint_id: MODEL, metadata: { status: 'active' } }] })
        : Response.json({ error: { message: 'Endpoint(s) not found' } }, { status: 404 }))
    : new Response(''));
  expect(await created.checkServiceHealth!([MODEL])).toEqual({ [MODEL]: { status: 'unavailable', reason: `fal no longer offers ${EDIT}` } });
});
