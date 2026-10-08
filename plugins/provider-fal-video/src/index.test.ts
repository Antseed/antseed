import { afterEach, expect, it, vi } from 'vitest';
import type { Provider, ProviderStreamCallbacks, SerializedHttpRequest } from '@antseed/node';
import plugin, { falAppId } from './index.js';

afterEach(() => vi.unstubAllGlobals());

const MODEL = 'fal-ai/kling-video/v2.1/standard/text-to-video';
const config = {
  FAL_VIDEO_API_KEY: 'seller-secret',
  ANTSEED_ALLOWED_SERVICES: MODEL,
  ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [MODEL]: { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } } }),
};
const json = (body: object) => Buffer.from(JSON.stringify(body));
const request = (path: string, body: object, headers: Record<string, string> = {}): SerializedHttpRequest => ({
  requestId: 'r', method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: json(body),
});
const retrieve = (body: object = { model: MODEL, request_id: 'req-1' }) =>
  request('/fal/v1/video/retrieve', body, { 'x-antseed-service': MODEL, 'x-antseed-video-download': 'video-stream-v1' });
const stream = (provider: Provider, req = retrieve(), callbacks: Partial<ProviderStreamCallbacks> = {}) =>
  provider.handleRequestStream!(req, { signal: new AbortController().signal, onResponseStart() {}, onResponseChunk() {}, ...callbacks });
const parse = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString());

it('derives fal app IDs for queue status and result URLs', () => {
  expect(falAppId(MODEL)).toBe('fal-ai/kling-video');
  expect(falAppId('fal-ai/veo3')).toBe('fal-ai/veo3');
});

it('advertises fal video services and validates seller configuration', () => {
  expect(plugin.name).toBe('fal-video');
  expect(() => plugin.createProvider({ ...config, FAL_VIDEO_API_KEY: ' ' })).toThrow('FAL_VIDEO_API_KEY');
  expect(() => plugin.createProvider({ ...config, ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{}' })).toThrow('Missing fal-video unit pricing');
  expect(() => plugin.createProvider({ ...config, ANTSEED_ALLOWED_SERVICES: 'kling' })).toThrow('Invalid fal endpoint ID');
  expect(() => plugin.createProvider({ ...config, ANTSEED_ALLOWED_SERVICES: 'fal-ai/../admin' })).toThrow('Invalid fal endpoint ID');
  const provider = plugin.createProvider(config) as Provider;
  expect(provider.serviceApiProtocols).toEqual({ [MODEL]: ['fal-video'] });
  expect(provider.serviceCapabilities?.[MODEL]).toMatchObject({ outputs: ['video'] });
});

it('submits the input to the fal queue with seller auth and hides fal URLs', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    request_id: 'req-1', queue_position: 0,
    status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-1/status',
    response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-1',
  }));
  vi.stubGlobal('fetch', fetchMock);
  const input = { prompt: 'cat', duration: '5', image_url: 'data:image/png;base64,aW1hZ2U=' };
  const response = await (plugin.createProvider(config) as Provider).handleRequest(
    request('/fal/v1/video/queue', { model: MODEL, service: MODEL, ...input }, { authorization: 'buyer-key', 'x-antseed-buyer-peer-id': 'buyer' }),
  );
  expect(response.statusCode).toBe(200);
  expect(parse(response.body)).toEqual({ model: MODEL, request_id: 'req-1', status: 'IN_QUEUE' });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(`https://queue.fal.run/${MODEL}`);
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Key seller-secret' } });
  expect(Object.keys(init.headers).some((key: string) => key.startsWith('x-antseed-'))).toBe(false);
  expect(parse(init.body)).toEqual(input);
});

it('passes fal validation errors back without accepting a job', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ detail: [{ msg: 'prompt required' }] }, { status: 422 })));
  const response = await (plugin.createProvider(config) as Provider).handleRequest(request('/fal/v1/video/queue', { model: MODEL }));
  expect(response.statusCode).toBe(422);
  expect(parse(response.body).request_id).toBeUndefined();
});

it('rejects unsupported endpoints, services, and non-streamed retrieves before calling fal', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const provider = plugin.createProvider(config) as Provider;
  expect((await provider.handleRequest(request('/fal/v1/video/cancel', { model: MODEL, request_id: 'req-1' }))).statusCode).toBe(400);
  expect((await provider.handleRequest(request('/fal/v1/video/queue', { model: 'fal-ai/other', prompt: 'cat' }))).statusCode).toBe(400);
  expect((await provider.handleRequest(retrieve())).statusCode).toBe(400);
  expect((await stream(provider, retrieve({ model: MODEL }))).statusCode).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('returns fal queue status while the job runs', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: 'IN_QUEUE', queue_position: 3, response_url: 'https://queue.fal.run/x' }, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  const response = await stream(plugin.createProvider(config) as Provider);
  expect(parse(response.body)).toEqual({ status: 'IN_QUEUE' });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://queue.fal.run/fal-ai/kling-video/requests/req-1/status');
  expect(init).toMatchObject({ redirect: 'error', headers: { authorization: 'Key seller-secret' } });
});

it('reports failed fal jobs as FAILED', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'COMPLETED', error: 'NSFW content', error_type: 'content_policy_violation' })));
  const response = await stream(plugin.createProvider(config) as Provider);
  expect(parse(response.body)).toEqual({ status: 'FAILED', error: 'NSFW content' });
});

it.each([429, 500, 503])('does not report a job as FAILED when its result fetch returns %i', async (statusCode) => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
    .mockResolvedValueOnce(Response.json({ detail: 'try again' }, { status: statusCode })));
  const response = await stream(plugin.createProvider(config) as Provider);
  expect(response.statusCode).toBe(502);
  expect(parse(response.body).status).toBeUndefined();
});

it('reports a job as FAILED when fal refuses its result', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
    .mockResolvedValueOnce(Response.json({ detail: 'invalid input' }, { status: 422 })));
  const response = await stream(plugin.createProvider(config) as Provider);
  expect(parse(response.body)).toEqual({ status: 'FAILED' });
});

it('streams the finished video from the fal media URL without the seller key', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 17).fill(7);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'COMPLETED', metrics: { inference_time: 30 } }))
    .mockResolvedValueOnce(Response.json({ video: { url: 'https://v3.fal.media/files/out.mp4', content_type: 'video/mp4' } }))
    .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }));
  vi.stubGlobal('fetch', fetchMock);
  let received = 0;
  let headers: Record<string, string> | undefined;
  const response = await stream(plugin.createProvider(config) as Provider, retrieve(), {
    onResponseStart(start) { headers = start.headers; },
    onResponseChunk(chunk) { expect(chunk.data.length).toBeLessThanOrEqual(65536); received += chunk.data.length; },
  });
  expect(response.statusCode).toBe(200);
  expect(headers).toMatchObject({ 'content-type': 'video/mp4', 'x-antseed-video-download': 'video-stream-v1' });
  expect(received).toBe(bytes.length);
  expect(fetchMock.mock.calls[1]![0]).toBe('https://queue.fal.run/fal-ai/kling-video/requests/req-1');
  const [url, init] = fetchMock.mock.calls[2]!;
  expect(url).toBe('https://v3.fal.media/files/out.mp4');
  expect(init.headers).not.toHaveProperty('authorization');
});

it('refuses non-HTTPS result URLs', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
    .mockResolvedValueOnce(Response.json({ video: { url: 'http://169.254.169.254/latest' } }));
  vi.stubGlobal('fetch', fetchMock);
  const response = await stream(plugin.createProvider(config) as Provider);
  expect(response.statusCode).toBe(502);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
