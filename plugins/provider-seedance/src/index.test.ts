import { afterEach, expect, it, vi } from 'vitest';
import plugin from './index.js';

afterEach(() => vi.unstubAllGlobals());

const config = { ARK_BASE_URL: 'https://seller.example.test', ARK_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'video', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"video":{"seedance-video":{"version":1,"components":[]}}}' };

it('registers the seedance seller endpoint plugin', async () => {
  expect(plugin.name).toBe('seedance');
  expect(() => plugin.createProvider({ ...config, ARK_BASE_URL: 'ftp://seller.example.test' })).toThrow(/base URL/);
  expect(() => plugin.createProvider({ ...config, ARK_API_KEY: ' ' })).toThrow(/authentication/);
  const provider = await plugin.createProvider(config);
  expect(provider.serviceApiProtocols).toEqual({ video: ['seedance-video'] });
});

it.each([
  [{ type: 'text', text: 'A cat' }],
  [{ type: 'image_url', image_url: { url: 'https://media.example/start.png' }, role: 'first_frame' }],
  [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' }, role: 'first_frame' }, { type: 'image_url', image_url: { url: 'https://media.example/end.png' }, role: 'last_frame' }],
  [{ type: 'image_url', image_url: { url: 'https://media.example/reference.png' }, role: 'reference_image' }],
  [{ type: 'video_url', video_url: { url: 'https://media.example/input.mp4' }, role: 'reference_video' }],
].map(content => ({ content })))('relays native Seedance media $content byte-for-byte with seller auth', async ({ content }) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"id": "task"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const body = Buffer.from(` ${JSON.stringify({ model: 'video', duration: 5, content })}\n`);
  const response = await provider.handleRequest({ requestId: 'seedance', method: 'POST', path: '/api/v3/contents/generations/tasks', headers: { 'content-type': 'application/json', authorization: 'buyer-key', 'x-antseed-provider': 'seedance' }, body });
  expect(response.statusCode).toBe(200);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://seller.example.test/api/v3/contents/generations/tasks');
  expect(options.headers.authorization).toBe('Bearer key');
  expect(options.headers['x-antseed-provider']).toBeUndefined();
  expect(Buffer.from(options.body)).toEqual(body);
  expect(options.redirect).toBe('error');
});

it('defaults to the BytePlus ModelArk endpoint', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"id": "cgt-1"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const { ARK_BASE_URL: _url, ...rest } = config;
  const provider = await plugin.createProvider(rest);
  await provider.handleRequest({ requestId: 's', method: 'POST', path: '/api/v3/contents/generations/tasks', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"model":"video"}') });
  expect(fetchMock.mock.calls[0]![0]).toBe('https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks');
});
