import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provider, ProviderStreamCallbacks, SerializedHttpRequest } from '@antseed/node';
import plugin, { ALIBABA_DEFAULT_BASE_URL, SUPPORTED_PARAMETERS, alibabaErrorReason, alibabaRequestProblem, alibabaTaskBody } from './index.js';

afterEach(() => vi.unstubAllGlobals());

const SERVICE = 'wan3.0-video';
const pricing = { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } };
const config = {
  ALIBABA_VIDEO_API_KEY: 'seller-secret',
  ANTSEED_ALLOWED_SERVICES: SERVICE,
  ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [SERVICE]: pricing }),
};
const provider = (overrides: Record<string, string> = {}) => plugin.createProvider({ ...config, ...overrides }) as Provider;
const json = (body: object) => Buffer.from(JSON.stringify(body));
const request = (path: string, body: object, headers: Record<string, string> = {}): SerializedHttpRequest => ({
  requestId: 'r', method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: json(body),
});
const create = (body: object = { model: SERVICE, prompt: 'an ant', duration: 5, resolution: '720p' }) => request('/fal/v1/video/queue', body);
const retrieve = () => request('/fal/v1/video/retrieve', { model: SERVICE, request_id: 'task-1' }, { 'x-antseed-service': SERVICE, 'x-antseed-video-download': 'video-stream-v1' });
const stream = (p: Provider, req = retrieve(), callbacks: Partial<ProviderStreamCallbacks> = {}) =>
  p.handleRequestStream!(req, { signal: new AbortController().signal, onResponseStart() {}, onResponseChunk() {}, ...callbacks });
const parse = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString());
const task = (output: object) => new Response(JSON.stringify({ output }), { status: 200 });

describe('alibaba-video config', () => {
  it('requires a key, services and pricing', () => {
    expect(() => plugin.createProvider({ ...config, ALIBABA_VIDEO_API_KEY: '' })).toThrow('ALIBABA_VIDEO_API_KEY');
    expect(() => plugin.createProvider({ ...config, ANTSEED_ALLOWED_SERVICES: '' })).toThrow('ANTSEED_ALLOWED_SERVICES');
    expect(() => plugin.createProvider({ ...config, ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{}' })).toThrow('unit pricing');
    expect(() => plugin.createProvider({ ...config, ALIBABA_VIDEO_BASE_URL: 'https://user:pass@example.com' })).toThrow('without credentials');
  });

  it('announces the queue protocol, video output and supported fields', () => {
    const p = provider();
    expect(p.serviceApiProtocols?.[SERVICE]).toEqual(['fal-video']);
    expect(p.serviceCapabilities?.[SERVICE]).toMatchObject({ outputs: ['video'], supportedParameters: SUPPORTED_PARAMETERS });
  });

  it('keeps the seller\'s configured capabilities', () => {
    const p = provider({ ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ [SERVICE]: { supportedParameters: ['prompt', 'duration'], video: { resolutions: ['720p'] } } }) });
    expect(p.serviceCapabilities?.[SERVICE]).toMatchObject({ supportedParameters: ['prompt', 'duration'], video: { resolutions: ['720p'] } });
  });
});

describe('alibabaRequestProblem', () => {
  it('requires a duration', () => {
    expect(alibabaRequestProblem({ prompt: 'x' })).toContain('duration is required');
    expect(alibabaRequestProblem({ prompt: 'x', duration: null })).toContain('duration is required');
    expect(alibabaRequestProblem({ prompt: 'x', duration: 5 })).toBeNull();
  });

  it.each(['video_url', 'audio_url', 'reference_video_urls'])('refuses %s', (field) => {
    expect(alibabaRequestProblem({ prompt: 'x', duration: 5, [field]: 'https://example.com/a' })).toContain(field);
  });
});

describe('alibabaTaskBody', () => {
  it('translates a text request', () => {
    expect(alibabaTaskBody('wan3.0-video', { prompt: 'an ant', duration: '5s', resolution: '720p', aspect_ratio: '16:9', audio: false, seed: 7, enable_prompt_expansion: false })).toEqual({
      model: 'wan3.0-video',
      input: { prompt: 'an ant' },
      parameters: { duration: 5, resolution: '720P', ratio: '16:9', audio: false, seed: 7, prompt_extend: false },
    });
  });

  it('translates frames and reference images to media', () => {
    expect(alibabaTaskBody('m', { start_image_url: 'https://a/1.png', end_image_url: 'https://a/2.png', duration: 5 }).input).toEqual({
      media: [{ type: 'first_frame', url: 'https://a/1.png' }, { type: 'last_frame', url: 'https://a/2.png' }],
    });
    expect(alibabaTaskBody('m', { image_url: 'data:image/png;base64,AAAA', duration: 5 }).input).toEqual({
      media: [{ type: 'first_frame', url: 'data:image/png;base64,AAAA' }],
    });
    expect(alibabaTaskBody('m', { prompt: 'x', reference_image_urls: ['https://a/1.png', 7], duration: 5 }).input).toEqual({
      prompt: 'x',
      media: [{ type: 'reference_image', url: 'https://a/1.png' }],
    });
  });

  it('never forwards fields it does not translate', () => {
    expect(alibabaTaskBody('m', { prompt: 'x', duration: 5, watermark: true, callback_url: 'https://a' })).toEqual({
      model: 'm', input: { prompt: 'x' }, parameters: { duration: 5 },
    });
  });
});

describe('alibabaErrorReason', () => {
  it('prefers the message, then the code', () => {
    expect(alibabaErrorReason({ code: 'InvalidParameter', message: 'bad ratio' })).toBe('bad ratio');
    expect(alibabaErrorReason({ code: 'Arrearage' })).toBe('Arrearage');
    expect(alibabaErrorReason(null)).toBeUndefined();
  });
});

describe('create', () => {
  it('submits an async task and returns its ID', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output: { task_id: 'task-1', task_status: 'PENDING' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await provider().handleRequest(create());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ALIBABA_DEFAULT_BASE_URL}/api/v1/services/aigc/video-generation/video-synthesis`);
    expect(init.headers).toMatchObject({ authorization: 'Bearer seller-secret', 'x-dashscope-async': 'enable' });
    expect(JSON.parse(init.body as string)).toEqual({ model: SERVICE, input: { prompt: 'an ant' }, parameters: { duration: 5, resolution: '720P' } });
    expect(response.statusCode).toBe(200);
    expect(parse(response.body)).toEqual({ model: SERVICE, request_id: 'task-1', status: 'IN_QUEUE' });
  });

  it('sends the upstream model of an aliased service', async () => {
    const alias = 'video/wan-3.0';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output: { task_id: 'task-1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = provider({
      ANTSEED_ALLOWED_SERVICES: alias,
      ANTSEED_SERVICE_ALIAS_MAP_JSON: JSON.stringify({ [alias]: SERVICE }),
      ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [alias]: pricing }),
    });
    const response = await p.handleRequest(create({ model: alias, prompt: 'x', duration: 5 }));
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe(SERVICE);
    expect(parse(response.body).model).toBe(alias);
  });

  it('passes a refusal on with its reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'InvalidParameter', message: 'bad ratio' }), { status: 400 })));
    const response = await provider().handleRequest(create());
    expect(response.statusCode).toBe(400);
    expect(parse(response.body).error).toEqual({ code: 'alibaba_request_rejected', message: 'bad ratio' });
  });

  it('answers 502 on a server error or network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    expect((await provider().handleRequest(create())).statusCode).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect((await provider().handleRequest(create())).statusCode).toBe(502);
  });

  it('refuses before payment and without calling upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const p = provider();
    expect(p.checkRequest?.(create({ model: SERVICE, prompt: 'x' }))).toMatchObject({ statusCode: 422, code: 'invalid_video_request' });
    expect(p.checkRequest?.(create())).toBeNull();
    expect((await p.handleRequest(create({ model: SERVICE, prompt: 'x', duration: 5, video_url: 'https://a/v.mp4' }))).statusCode).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown service', async () => {
    expect((await provider().handleRequest(create({ model: 'other', prompt: 'x', duration: 5 }))).statusCode).toBe(400);
  });
});

describe('retrieve', () => {
  it.each([['PENDING', 'IN_QUEUE'], ['RUNNING', 'IN_PROGRESS']])('maps %s to %s', async (upstream, status) => {
    vi.stubGlobal('fetch', vi.fn(async () => task({ task_status: upstream })));
    const response = await stream(provider());
    expect(parse(response.body)).toEqual({ status });
  });

  it.each(['FAILED', 'CANCELED'])('reports %s as FAILED with the reason', async (upstream) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => task({ task_status: upstream, code: 'DataInspectionFailed', message: 'blocked' })));
    const response = await stream(provider());
    expect(response.statusCode).toBe(200);
    expect(parse(response.body)).toEqual({ status: 'FAILED', error: 'blocked' });
  });

  it('keeps the job open on a temporary upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));
    const response = await stream(provider());
    expect(response.statusCode).toBe(502);
    expect(parse(response.body).status).not.toBe('FAILED');
  });

  it('answers 404 for a job Model Studio no longer knows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => task({ task_status: 'UNKNOWN' })));
    expect((await stream(provider())).statusCode).toBe(404);
  });

  it('streams the finished video without sending the seller key to the result URL', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.includes('/api/v1/tasks/task-1')
      ? task({ task_status: 'SUCCEEDED', video_url: 'https://result.example/video.mp4' })
      : new Response(Buffer.from('mp4-bytes'), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '9' } }));
    vi.stubGlobal('fetch', fetchMock);
    const chunks: Uint8Array[] = [];
    const response = await stream(provider(), retrieve(), { onResponseChunk(chunk) { if (chunk.data.length > 0) chunks.push(chunk.data); } });
    expect(response.statusCode).toBe(200);
    expect(Buffer.concat(chunks).toString()).toBe('mp4-bytes');
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({ authorization: 'Bearer seller-secret' });
    expect(fetchMock.mock.calls[1]![0]).toBe('https://result.example/video.mp4');
    expect(JSON.stringify(fetchMock.mock.calls[1]![1]?.headers)).not.toContain('seller-secret');
  });

  it('limits concurrent downloads', async () => {
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/api/v1/tasks/')
      ? task({ task_status: 'SUCCEEDED', video_url: 'https://result.example/video.mp4' })
      : new Response(new ReadableStream({ async pull(controller) { await blocked; controller.close(); } }), { status: 200, headers: { 'content-type': 'video/mp4' } })));
    const p = provider();
    const opened = () => new Promise<void>(resolve => { started.push(resolve); });
    const first = opened();
    const second = opened();
    const callbacks = { onResponseStart() { started.shift()?.(); } };
    const downloads = [stream(p, retrieve(), callbacks), stream(p, retrieve(), callbacks)];
    await Promise.all([first, second]);
    const busy = await stream(p);
    expect(busy.statusCode).toBe(429);
    expect(parse(busy.body).error.code).toBe('video_download_busy');
    release();
    await Promise.all(downloads);
  });

  it('refuses a result that is not https', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => task({ task_status: 'SUCCEEDED', video_url: 'http://result.example/video.mp4' })));
    expect((await stream(provider())).statusCode).toBe(502);
  });

  it('requires a streaming download', async () => {
    const req = request('/fal/v1/video/retrieve', { model: SERVICE, request_id: 'task-1' }, { 'x-antseed-service': SERVICE });
    expect((await stream(provider(), req)).statusCode).toBe(400);
  });
});

describe('checkUpstreamAccount', () => {
  it('reports a rejected key as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    expect(await provider().checkUpstreamAccount!()).toMatchObject({ status: 'unavailable' });
  });

  it('reports a working key as available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await provider().checkUpstreamAccount!()).toEqual({ status: 'available' });
  });

  it('never counts an unclear answer against the seller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    expect((await provider().checkUpstreamAccount!()).status).toBe('unknown');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect((await provider().checkUpstreamAccount!()).status).toBe('unknown');
  });
});
