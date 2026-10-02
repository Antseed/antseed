import { afterEach, expect, it, vi } from 'vitest';
import type { Provider, ProviderStreamCallbacks, SerializedHttpRequest } from '@antseed/node';
import plugin from './index.js';

afterEach(() => vi.unstubAllGlobals());

const config = {
  VENICE_VIDEO_API_KEY: 'seller-secret',
  ANTSEED_ALLOWED_SERVICES: 'wan-2.5',
  ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ 'wan-2.5': { 'venice-video': { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.1 }] } } }),
};
const json = (body: object) => Buffer.from(JSON.stringify(body));
const request = (path: string, body: object, headers: Record<string, string> = {}): SerializedHttpRequest => ({
  requestId: 'r', method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: json(body),
});
const retrieve = (body: object = { model: 'other', queue_id: 'queue-1', delete_media_on_completion: true }) =>
  request('/api/v1/video/retrieve', body, { 'x-antseed-service': 'wan-2.5', 'x-antseed-video-download': 'video-stream-v1' });
const stream = (provider: Provider, req = retrieve(), callbacks: Partial<ProviderStreamCallbacks> = {}) =>
  provider.handleRequestStream!(req, { signal: new AbortController().signal, onResponseStart() {}, onResponseChunk() {}, ...callbacks });

it('advertises Venice video services and requires seller configuration', () => {
  expect(plugin.name).toBe('venice-video');
  expect(() => plugin.createProvider({ ...config, VENICE_VIDEO_API_KEY: ' ' })).toThrow('VENICE_VIDEO_API_KEY');
  expect(() => plugin.createProvider({ ...config, ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{}' })).toThrow('Missing venice-video unit pricing');
  const provider = plugin.createProvider(config) as Provider;
  expect(provider.serviceApiProtocols).toEqual({ 'wan-2.5': ['venice-video'] });
  expect(provider.serviceCapabilities?.['wan-2.5']).toMatchObject({ outputs: ['video'] });
});

it('relays queue bodies without the AntSeed service field, with seller auth and without AntSeed headers', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ model: 'wan-2.5', queue_id: 'queue-1' }));
  vi.stubGlobal('fetch', fetchMock);
  const fields = { model: 'wan-2.5', prompt: 'cat', image_url: 'data:image/png;base64,aW1hZ2U=' };
  const body = Buffer.from(JSON.stringify({ ...fields, service: 'wan-2.5' }));
  const response = await (plugin.createProvider(config) as Provider).handleRequest({
    ...request('/api/v1/video/queue?api_key=buyer', {}, { authorization: 'buyer-key', 'x-antseed-buyer-peer-id': 'buyer' }), body,
  });
  expect(response.statusCode).toBe(200);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.venice.ai/api/v1/video/queue');
  expect(init.headers).toMatchObject({ authorization: 'Bearer seller-secret' });
  expect(Object.keys(init.headers).some(key => key.startsWith('x-antseed-'))).toBe(false);
  expect(JSON.parse(Buffer.from(init.body).toString())).toEqual(fields);
});

it('rejects unsupported endpoints, services, and non-streamed retrieves before calling Venice', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const provider = plugin.createProvider(config) as Provider;
  expect((await provider.handleRequest(request('/api/v1/video/complete', { model: 'wan-2.5', queue_id: 'queue-1' }))).statusCode).toBe(400);
  expect((await provider.handleRequest(request('/api/v1/video/queue', { model: 'other', prompt: 'cat' }))).statusCode).toBe(400);
  expect((await provider.handleRequest(retrieve())).statusCode).toBe(400);
  expect((await stream(provider, retrieve({ model: 'wan-2.5' }))).statusCode).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rebuilds retrieve requests and returns Venice JSON status', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: 'PROCESSING' }));
  vi.stubGlobal('fetch', fetchMock);
  const response = await stream(plugin.createProvider(config) as Provider);
  expect(JSON.parse(Buffer.from(response.body).toString())).toEqual({ status: 'PROCESSING' });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.venice.ai/api/v1/video/retrieve');
  expect(init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer seller-secret' } });
  expect(JSON.parse(Buffer.from(init.body).toString())).toEqual({ model: 'wan-2.5', queue_id: 'queue-1', delete_media_on_completion: true });
});

it('streams finished MP4s in bounded chunks', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 17).fill(7);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } })));
  let received = 0;
  let headers: Record<string, string> | undefined;
  const response = await stream(plugin.createProvider(config) as Provider, retrieve(), {
    onResponseStart(start) { headers = start.headers; },
    onResponseChunk(chunk) { expect(chunk.data.length).toBeLessThanOrEqual(65536); received += chunk.data.length; },
  });
  expect(response.statusCode).toBe(200);
  expect(headers).toMatchObject({ 'content-type': 'video/mp4', 'x-antseed-video-download': 'video-stream-v1' });
  expect(received).toBe(bytes.length);
});

it('keeps private-model download URLs on the seller and streams the file on retrieve', async () => {
  const bytes = new Uint8Array(70_000).fill(5);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ model: 'wan-2.5', queue_id: 'queue-1', download_url: 'https://files.venice.ai/v/queue-1?sig=abc' }))
    .mockResolvedValueOnce(Response.json({ status: 'COMPLETED', average_execution_time: 1, execution_duration: 1 }))
    .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = plugin.createProvider(config) as Provider;

  const created = await provider.handleRequest(request('/api/v1/video/queue', { model: 'wan-2.5', prompt: 'cat' }));
  expect(JSON.parse(Buffer.from(created.body).toString())).toEqual({ model: 'wan-2.5', queue_id: 'queue-1' });

  let received = 0;
  const response = await stream(provider, retrieve(), { onResponseChunk(chunk) { received += chunk.data.length; } });
  expect(response.headers).toMatchObject({ 'content-type': 'video/mp4' });
  expect(received).toBe(bytes.length);
  const [url, init] = fetchMock.mock.calls[2]!;
  expect(url).toBe('https://files.venice.ai/v/queue-1?sig=abc');
  expect(init.headers).not.toHaveProperty('authorization');
});
