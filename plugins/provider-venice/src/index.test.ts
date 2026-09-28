import { afterEach, expect, it, vi } from 'vitest';
import type { Provider, ProviderStreamCallbacks } from '@antseed/node';
import plugin from './index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const config = { VENICE_API_KEY: 'seller-secret', ANTSEED_ALLOWED_SERVICES: 'wan-2.5', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"wan-2.5":{"venice-video":{"version":1,"components":[]}}}' };
const json = (body: object) => Buffer.from(JSON.stringify(body));
const request = (path: string, body: object, headers: Record<string, string> = {}) => ({ requestId: 'r', method: 'POST', path, headers: { 'content-type': 'application/json', 'x-antseed-service': 'wan-2.5', ...headers }, body: json(body) });
const retrieve = (body: object = { model: 'evil', queue_id: 'queue-1', delete_media_on_completion: true }) => request('/api/v1/video/retrieve', body, { 'x-antseed-video-download': 'video-stream-v1' });
const stream = (provider: Provider, callbacks: Partial<ProviderStreamCallbacks> = {}, req = retrieve()) =>
  provider.handleRequestStream!(req, { signal: new AbortController().signal, onResponseStart() {}, onResponseChunk() {}, ...callbacks });

it('registers the Venice plugin with the Venice API by default and advertises streamed retrieve', async () => {
  expect(plugin.name).toBe('venice');
  expect(() => plugin.createProvider({ ...config, VENICE_API_KEY: ' ' })).toThrow(/authentication/);
  const provider = await plugin.createProvider(config);
  expect(provider.serviceApiProtocols).toEqual({ 'wan-2.5': ['venice-video'] });
  expect(provider.serviceCapabilities?.['wan-2.5']).toMatchObject({ outputs: ['video'], videoDownload: 'video-stream-v1' });
});

it.each([
  {},
  { image_url: 'https://media.example/start.png' },
  { image_url: 'data:image/png;base64,aW1hZ2U=', end_image_url: 'https://media.example/end.png' },
  { reference_image_urls: ['https://media.example/reference.png'] },
  { video_url: 'https://media.example/input.mp4' },
  { reference_video_urls: ['https://media.example/reference.mp4'] },
])('relays queue media %j byte-for-byte with seller auth', async (media) => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ model: 'wan-2.5', queue_id: 'queue-1' }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const body = Buffer.from(` ${JSON.stringify({ model: 'wan-2.5', prompt: 'cat', duration: '5s', ...media })}\n`);
  const response = await provider.handleRequest({ requestId: 'q', method: 'POST', path: '/api/v1/video/queue', headers: { 'content-type': 'application/json', authorization: 'buyer-key' }, body });
  expect(response.statusCode).toBe(200);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.venice.ai/api/v1/video/queue');
  expect(options.headers.authorization).toBe('Bearer seller-secret');
  expect(Buffer.from(options.body)).toEqual(body);
});

it('rebuilds complete bodies from the owned job and routed service', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const response = await provider.handleRequest(request('/api/v1/video/complete', { model: 'other', queue_id: 'queue-1', extra: 'x', delete_media_on_completion: false }));
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(Buffer.from(fetchMock.mock.calls[0]![1].body).toString())).toEqual({ model: 'wan-2.5', queue_id: 'queue-1' });
});

it('preserves a Venice cleanup rejection rather than claiming the media was deleted', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Request ID is invalid.' }, { status: 400 })));
  const provider = await plugin.createProvider(config);
  const response = await provider.handleRequest(request('/api/v1/video/complete', { model: 'wan-2.5', queue_id: 'queue-1' }));
  expect(response.statusCode).toBe(400);
  expect(JSON.parse(Buffer.from(response.body).toString())).toEqual({ error: 'Request ID is invalid.' });
});

it('streams a finished MP4 in bounded chunks with one upstream call', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 17).fill(7);
  const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }));
  vi.stubGlobal('fetch', fetchMock);
  let received = 0;
  let started: Record<string, string> | undefined;
  const result = await stream(await plugin.createProvider(config), {
    onResponseStart(response) { started = response.headers; },
    onResponseChunk(chunk) { expect(chunk.data.length).toBeLessThanOrEqual(65536); received += chunk.data.length; },
  });
  expect(result.statusCode).toBe(200);
  expect(started).toMatchObject({ 'content-type': 'video/mp4', 'content-length': String(bytes.length), 'x-antseed-video-download': 'video-stream-v1' });
  expect(received).toBe(bytes.length);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.venice.ai/api/v1/video/retrieve');
  expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer seller-secret' } });
  expect(JSON.parse(Buffer.from(options.body).toString())).toEqual({ model: 'wan-2.5', queue_id: 'queue-1', delete_media_on_completion: true });
});

it('returns JSON status while processing and for private models', async () => {
  for (const status of ['PROCESSING', 'COMPLETED']) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status, average_execution_time: 1, execution_duration: 1 })));
    const onResponseStart = vi.fn();
    const result = await stream(await plugin.createProvider(config), { onResponseStart });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(Buffer.from(result.body).toString()).status).toBe(status);
    expect(onResponseStart).not.toHaveBeenCalled();
  }
});

it('passes Venice JSON errors through and hides upstream exceptions', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'not found' }, { status: 404 })));
  expect((await stream(await plugin.createProvider(config))).statusCode).toBe(404);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('seller-secret')));
  const failed = await stream(await plugin.createProvider(config));
  expect(failed.statusCode).toBe(502);
  expect(Buffer.from(failed.body).toString()).not.toContain('seller-secret');
});

it('rejects unknown services, missing queue ids, and non-streamed retrieves without calling Venice', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  expect((await stream(provider, {}, { ...retrieve(), headers: { ...retrieve().headers, 'x-antseed-service': 'other' } })).statusCode).toBe(400);
  expect((await stream(provider, {}, retrieve({ model: 'wan-2.5' }))).statusCode).toBe(400);
  expect((await provider.handleRequest(retrieve())).statusCode).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('fails a truncated MP4 instead of completing it', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('video', { headers: { 'content-type': 'video/mp4', 'content-length': '6' } })));
  const done: boolean[] = [];
  await expect(stream(await plugin.createProvider(config), { onResponseChunk(chunk) { done.push(chunk.done); } })).rejects.toThrow('interrupted');
  expect(done).not.toContain(true);
});

it('cancels the upstream fetch when the buyer disconnects', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })));
  const pending = stream(await plugin.createProvider(config), { signal: controller.signal });
  controller.abort();
  expect((await pending).statusCode).toBe(504);
});

it('streams videos far above the old 64 MiB cap', async () => {
  const size = 100 * 1024 * 1024;
  const chunk = new Uint8Array(1024 * 1024).fill(1);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (sent >= size) { controller.close(); return; } controller.enqueue(chunk); sent += chunk.length; } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': String(size) } })));
  let received = 0;
  const result = await stream(await plugin.createProvider(config), { onResponseChunk(part) { received += part.data.length; } });
  expect(result.statusCode).toBe(200);
  expect(received).toBe(size);
});

it('aborts a download only after the upstream stops making progress', async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': '20' } })));
    const pending = stream(await plugin.createProvider(config)).catch(error => error);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(String(await pending)).toContain('interrupted');
  } finally { vi.useRealTimers(); }
});
