import { afterEach, expect, it, vi } from 'vitest';
import plugin from './index.js';

afterEach(() => vi.unstubAllGlobals());

const config = { GEMINI_BASE_URL: 'https://seller.example.test', GEMINI_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'video', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"video":{"veo-video":{"version":1,"components":[]}}}' };

it('registers the veo seller endpoint plugin without job management', async () => {
  expect(plugin.name).toBe('veo');
  expect(plugin.type).toBe('provider');
  expect(() => plugin.createProvider({})).toThrow(/seller-operated/);
  expect(() => plugin.createProvider({ ...config, GEMINI_API_KEY: ' ' })).toThrow(/authentication/);
  const provider = await plugin.createProvider(config);
  expect(provider.serviceApiProtocols).toEqual({ video: ['veo-video'] });
  expect(provider).not.toHaveProperty('videoAdapter');
});

it.each([
  { prompt: 'cat' },
  { prompt: 'cat', image: { bytesBase64Encoded: 'aW1hZ2U=', mimeType: 'image/png' } },
  { prompt: 'cat', image: { inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }, lastFrame: { inlineData: { data: 'ZW5k', mimeType: 'image/png' } } },
  { prompt: 'cat', referenceImages: [{ image: { bytesBase64Encoded: 'aW1hZ2U=', mimeType: 'image/png' }, referenceType: 'asset' }] },
  { prompt: 'cat', video: { inlineData: { data: 'dmlkZW8=', mimeType: 'video/mp4' } } },
])('preserves Veo media %j with seller auth and native relay safeguards', async (instance) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"name":"operations/task"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const body = Buffer.from(` ${JSON.stringify({ model: 'extension', service: 'extension', instances: [instance] })}\n`);
  const response = await provider.handleRequest({ requestId: 'veo', method: 'POST', path: '/v1beta/models/video:predictLongRunning', headers: { 'content-type': 'application/json', authorization: 'buyer-key', 'x-goog-api-key': 'buyer-key', 'x-antseed-provider': 'veo' }, body });
  expect(response.statusCode).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://seller.example.test/v1beta/models/video:predictLongRunning');
  expect(options.headers['x-goog-api-key']).toBe('key');
  expect(options.headers.authorization).toBeUndefined();
  expect(options.headers['x-runway-version']).toBeUndefined();
  expect(options.headers['x-antseed-provider']).toBeUndefined();
  expect(Buffer.from(options.body)).toEqual(body);
  expect(options.redirect).toBe('error');
});
