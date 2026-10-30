import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, ProviderStreamCallbacks, SerializedHttpRequest } from '@antseed/node';
import plugin, { VENICE_MAX_BODY_BYTES, veniceAcceptsEndFrame, isVeniceEditModel, veniceEditCapabilities, veniceInputParameters, veniceReferenceImages, terminalRetrieveFailure } from './index.js';

afterEach(() => vi.unstubAllGlobals());

const config = {
  VENICE_VIDEO_API_KEY: 'seller-secret',
  ANTSEED_ALLOWED_SERVICES: 'wan-2.5',
  ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ 'wan-2.5': { 'venice-video': { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.1 }] } } }),
};
const json = (body: object) => Buffer.from(JSON.stringify(body));

/** Inline MP4 source whose video track plays `ms` milliseconds. */
const sourceMp4 = (ms: number) => {
  const box = (type: string, ...children: Buffer[]) => {
    const head = Buffer.alloc(8);
    head.write(type, 4, 'latin1');
    const out = Buffer.concat([head, ...children]);
    out.writeUInt32BE(out.length);
    return out;
  };
  const u32 = (...values: number[]) => Buffer.concat(values.map(value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }));
  // mvhd and mdhd: version/flags, times, timescale 1000, duration. One sample of `ms`.
  const header = u32(0, 0, 0, 1000, ms);
  const mp4 = Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
    box('moov', box('mvhd', header), box('trak', box('mdia', box('mdhd', header), box('hdlr', u32(0, 0), Buffer.from('vide'), u32(0, 0, 0), Buffer.alloc(1)),
      box('minf', box('stbl', box('stts', u32(0, 1, 1, ms)), box('stsz', u32(0, 0, 1))))))),
    box('mdat', Buffer.alloc(64)),
  ]);
  return `data:video/mp4;base64,${mp4.toString('base64')}`;
};
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

const veniceModel = (id: string, constraints: Record<string, unknown>) => ({ id, model_spec: { constraints } });

it('derives each model\'s queue fields from Venice constraints and the announced frames', () => {
  const imageToVideo = veniceModel('seedance', { model_type: 'image-to-video', resolutions: ['720p'], aspect_ratios: [], audio_configurable: true });
  expect(veniceInputParameters(imageToVideo)).toEqual(['audio', 'duration', 'image_url', 'prompt', 'resolution']);
  expect(veniceInputParameters(imageToVideo, ['first_frame', 'last_frame'])).toEqual(['audio', 'duration', 'end_image_url', 'image_url', 'prompt', 'resolution']);
  expect(veniceInputParameters(veniceModel('wan', { model_type: 'text-to-video', resolutions: ['720p'], aspect_ratios: ['16:9'], audio_configurable: false }), []))
    .toEqual(['aspect_ratio', 'duration', 'prompt', 'resolution']);
  expect(veniceInputParameters(undefined)).toBeNull();
});

it('announces queue fields from the Venice model list and keeps configured ones', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [
    veniceModel('wan-2.5', { model_type: 'image-to-video', resolutions: ['720p'], aspect_ratios: [], audio_configurable: false }),
  ] }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = plugin.createProvider({ ...config, ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ 'wan-2.5': { video: { inputs: ['first_frame', 'last_frame'] } } }) }) as Provider;
  await provider.init!();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.venice.ai/api/v1/models?type=video');
  expect(init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer seller-secret' } });
  expect(provider.serviceCapabilities?.['wan-2.5']?.supportedParameters).toEqual(['duration', 'end_image_url', 'image_url', 'prompt', 'resolution']);

  fetchMock.mockClear();
  const configured = plugin.createProvider({ ...config, ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ 'wan-2.5': { supportedParameters: ['prompt'] } }) }) as Provider;
  await configured.init!();
  // The free model list is still read (video-to-video rules come from it), but no model is probed.
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://api.venice.ai/api/v1/models?type=video']);
  expect(configured.serviceCapabilities?.['wan-2.5']?.supportedParameters).toEqual(['prompt']);
});

const invalid = (details: Record<string, unknown>) => Response.json({ error: 'Invalid request parameters', details: { _errors: [], duration: { _errors: ['Invalid enum value'] }, ...details } }, { status: 400 });

it('asks Venice for free whether a model takes a last frame', async () => {
  const fetchMock = vi.fn().mockResolvedValue(invalid({}));
  vi.stubGlobal('fetch', fetchMock);
  expect(await veniceAcceptsEndFrame('https://api.venice.ai', 'seller-secret', 'seedance')).toBe(true);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.venice.ai/api/v1/video/queue');
  expect(JSON.parse(init.body)).toMatchObject({ model: 'seedance', prompt: '', duration: '999s' });

  fetchMock.mockResolvedValue(invalid({ end_image_url: { _errors: ['This model does not support end_image_url'] } }));
  expect(await veniceAcceptsEndFrame('https://api.venice.ai', 'k', 'wan-2.6')).toBe(false);
  fetchMock.mockResolvedValue(Response.json({ queue_id: 'started' }));
  expect(await veniceAcceptsEndFrame('https://api.venice.ai', 'k', 'm')).toBeNull();
  fetchMock.mockResolvedValue(Response.json({ error: 'Invalid request parameters', details: { prompt: { _errors: ['required'] } } }, { status: 400 }));
  expect(await veniceAcceptsEndFrame('https://api.venice.ai', 'k', 'm')).toBeNull();
  fetchMock.mockResolvedValue(Response.json({ error: 'Too many requests' }, { status: 429 }));
  expect(await veniceAcceptsEndFrame('https://api.venice.ai', 'k', 'm')).toBeNull();
});

it('announces end_image_url for image-to-video models Venice says take a last frame, unless frames are configured', async () => {
  const models = Response.json({ data: [veniceModel('wan-2.5', { model_type: 'image-to-video', resolutions: [], aspect_ratios: [], audio_configurable: false })] });
  const fetchMock = vi.fn().mockResolvedValueOnce(models.clone()).mockResolvedValueOnce(invalid({}));
  vi.stubGlobal('fetch', fetchMock);
  const provider = plugin.createProvider(config) as Provider;
  await provider.init!();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(provider.serviceCapabilities?.['wan-2.5']?.supportedParameters).toEqual(['duration', 'end_image_url', 'image_url', 'prompt']);

  fetchMock.mockReset().mockResolvedValueOnce(models.clone()).mockResolvedValueOnce(invalid({ end_image_url: { _errors: ['This model does not support end_image_url'] } }));
  const firstOnly = plugin.createProvider(config) as Provider;
  await firstOnly.init!();
  expect(firstOnly.serviceCapabilities?.['wan-2.5']?.supportedParameters).toEqual(['duration', 'image_url', 'prompt']);

  fetchMock.mockReset().mockResolvedValueOnce(models.clone());
  const configured = plugin.createProvider({ ...config, ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ 'wan-2.5': { video: { inputs: ['first_frame'] } } }) }) as Provider;
  await configured.init!();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(configured.serviceCapabilities?.['wan-2.5']?.supportedParameters).toEqual(['duration', 'image_url', 'prompt']);
});

it('starts without queue fields when the Venice model list is unavailable or lacks the model', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const offline = plugin.createProvider(config) as Provider;
  await offline.init!();
  expect(offline.serviceCapabilities?.['wan-2.5']).toEqual({ outputs: ['video'] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })));
  const missing = plugin.createProvider(config) as Provider;
  await missing.init!();
  expect(missing.serviceCapabilities?.['wan-2.5']).toEqual({ outputs: ['video'] });
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

it('keeps private-model download URLs across a seller restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'venice-video-'));
  try {
    const bytes = new Uint8Array(1_000).fill(5);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ model: 'wan-2.5', queue_id: 'queue-1', download_url: 'https://files.venice.ai/v/queue-1?sig=abc' }))
      .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }));
    vi.stubGlobal('fetch', fetchMock);
    await (plugin.createProvider({ ...config, ANTSEED_DATA_DIR: dataDir }) as Provider)
      .handleRequest(request('/api/v1/video/queue', { model: 'wan-2.5', prompt: 'cat' }));

    const restarted = plugin.createProvider({ ...config, ANTSEED_DATA_DIR: dataDir }) as Provider;
    const response = await stream(restarted);

    expect(response.headers).toMatchObject({ 'content-type': 'video/mp4' });
    expect(fetchMock.mock.calls[2]![0]).toBe('https://files.venice.ai/v/queue-1?sig=abc');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('checkServiceHealth and checkUpstreamAccount', () => {
  const twoModels = { ...config, ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({
    'wan-2.5': { 'venice-video': { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.1 }] } },
    'kling-2': { 'venice-video': { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.1 }] } },
  }), ANTSEED_ALLOWED_SERVICES: 'wan-2.5,kling-2' };
  const account = (data: object, status = 200) => Response.json({ data }, { status });
  const models = (ids: string[]) => Response.json({ data: ids.map(id => ({ id, model_spec: { offline: false } })) });
  const mockVenice = (accountResponse: Response | Error, modelsResponse: Response | Error = models(['wan-2.5', 'kling-2'])) => {
    const fetchMock = vi.fn(async (url: string) => {
      const response = url.includes('/api_keys/rate_limits') ? accountResponse : modelsResponse;
      if (response instanceof Error) throw response;
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const provider = (cfg: Record<string, string> = twoModels) => plugin.createProvider(cfg) as Provider;
  const check = (cfg?: Record<string, string>) => provider(cfg).checkServiceHealth!(['wan-2.5', 'kling-2']);
  const checkAccount = (cfg?: Record<string, string>) => provider(cfg).checkUpstreamAccount!();
  const funded = { accessPermitted: true, balances: { USD: 3, DIEM: 1.5, BUNDLED_CREDITS: 0 } };

  it('reads the key and total balance from the free account endpoint', async () => {
    const fetchMock = mockVenice(account(funded));
    expect(await checkAccount()).toEqual({ status: 'available', balanceUsd: 4.5 });
    const [accountUrl, accountInit] = fetchMock.mock.calls[0]!;
    expect(accountUrl).toBe('https://api.venice.ai/api/v1/api_keys/rate_limits');
    expect(accountInit).toMatchObject({ headers: { authorization: 'Bearer seller-secret' } });
    expect(accountInit?.method).toBeUndefined();
  });

  it('reports an empty balance or one at the configured minimum as unavailable', async () => {
    mockVenice(account({ accessPermitted: true, balances: { USD: 0, DIEM: 0 } }));
    expect(await checkAccount()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('$0.00') });
    mockVenice(account(funded));
    expect(await checkAccount({ ...twoModels, VENICE_VIDEO_MIN_BALANCE_USD: '5' })).toMatchObject({ status: 'unavailable' });
    expect(() => plugin.createProvider({ ...twoModels, VENICE_VIDEO_MIN_BALANCE_USD: '-1' })).toThrow('VENICE_VIDEO_MIN_BALANCE_USD');
  });

  it('reports a rejected key or blocked API access as unavailable', async () => {
    mockVenice(Response.json({ error: 'Authentication failed' }, { status: 401 }));
    expect(await checkAccount()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('HTTP 401') });
    mockVenice(account({ ...funded, accessPermitted: false }));
    expect(await checkAccount()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('not permitted') });
  });

  it('checks each model against Venice\'s public model list, without the key', async () => {
    const fetchMock = mockVenice(account(funded), models(['wan-2.5']));
    expect(await check()).toEqual({
      'wan-2.5': { status: 'available' },
      'kling-2': { status: 'unavailable', reason: 'Venice no longer offers this model' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.venice.ai/api/v1/models?type=video');
    expect(init?.headers).toBeUndefined();
  });

  it('reports unknown when the model list can not be read', async () => {
    for (const response of [new Error('network down'), Response.json({}, { status: 503 }), Response.json({ data: [] })]) {
      mockVenice(account(funded), response);
      expect((await check())['wan-2.5']).toMatchObject({ status: 'unknown' });
    }
  });

  it('reports unknown when the account can not be read', async () => {
    mockVenice(new Error('network down'));
    expect(await checkAccount()).toMatchObject({ status: 'unknown' });
    mockVenice(Response.json({}, { status: 500 }));
    expect(await checkAccount()).toMatchObject({ status: 'unknown' });
  });
});

describe('video-to-video models', () => {
  // Constraints as Venice's model list gives them (2026-10-23).
  const RECAST = veniceModel('minimax-h3-max-recast', { model_type: 'video', aspect_ratios: [], resolutions: ['768P', '1080P'], durations: ['Auto'], audio_configurable: false, video_input: true });
  const MOTION = veniceModel('kling-v3-standard-motion-control', { model_type: 'video', aspect_ratios: [], resolutions: [], durations: ['Auto'], audio_configurable: false, video_input: true });
  const WAN = veniceModel('wan-2-7-video-to-video', { model_type: 'video', aspect_ratios: [], resolutions: ['1080p', '720p'], durations: ['Auto'], audio_configurable: false, video_input: true });
  const GROK = veniceModel('grok-imagine-video-to-video-private', { model_type: 'video', aspect_ratios: [], resolutions: ['480p', '720p'], durations: ['5s', '10s', '15s'], video_input: true });
  const TEXT = veniceModel('wan-2.5-preview-text-to-video', { model_type: 'text-to-video', aspect_ratios: ['16:9'], resolutions: ['720p'], durations: ['5s'] });
  // Venice's validation answers to an empty `reference_image_urls` (captured 2026-10-23).
  const referenceAnswer = (model: string) => Response.json({ error: 'Invalid request parameters', details: {
    _errors: [], duration: { _errors: ['duration must not exceed 300 seconds for upscale models'] },
    ...(model === 'minimax-h3-max-recast' ? { reference_image_urls: { _errors: ['At least one reference is required for this model (reference_image_urls, reference_video_urls, image_references, or video_references when supported)'] } } : {}),
    ...(model.includes('motion-control') || model.startsWith('wan-') ? { reference_image_urls: { _errors: ['This model does not support reference images'] } } : {}),
  } }, { status: 400 });
  const editConfig = (service: string, capabilities?: object) => ({
    VENICE_VIDEO_API_KEY: 'seller-secret',
    ANTSEED_ALLOWED_SERVICES: service,
    ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [service]: { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.4 }] } } }),
    ...(capabilities ? { ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ [service]: capabilities }) } : {}),
  });
  const ready = async (model: { id: string }, capabilities?: object) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/models?type=video')) return Response.json({ data: [RECAST, MOTION, WAN, GROK, TEXT] });
      if (String(url).endsWith('/api/v1/video/queue')) {
        const body = JSON.parse(String(init?.body));
        return body.duration === '999s' ? referenceAnswer(body.model) : Response.json({ model: body.model, queue_id: 'queue-1' });
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = plugin.createProvider(editConfig(model.id, capabilities)) as Provider;
    await provider.init!();
    return { provider, fetchMock };
  };
  const create = (model: string, body: object, requestId = 'r') => ({ ...request('/api/v1/video/queue', { model, ...body }), requestId });
  const parse = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString());
  it('detects video-to-video models from Venice constraints', () => {
    expect(isVeniceEditModel(RECAST)).toBe(true);
    expect(isVeniceEditModel(GROK)).toBe(true);
    expect(isVeniceEditModel(TEXT)).toBe(false);
    expect(isVeniceEditModel(undefined)).toBe(false);
  });

  it('asks Venice for free whether a model takes reference images', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => referenceAnswer(JSON.parse(String(init.body)).model));
    vi.stubGlobal('fetch', fetchMock);
    expect(await veniceReferenceImages('https://api.venice.ai', 'k', 'minimax-h3-max-recast')).toBe('required');
    expect(await veniceReferenceImages('https://api.venice.ai', 'k', 'kling-v3-standard-motion-control')).toBe('none');
    expect(await veniceReferenceImages('https://api.venice.ai', 'k', 'happyhorse-1-0-video-to-video')).toBe('optional');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ model: 'minimax-h3-max-recast', prompt: '', duration: '999s', reference_image_urls: [] });
    fetchMock.mockResolvedValue(Response.json({ queue_id: 'started' }));
    expect(await veniceReferenceImages('https://api.venice.ai', 'k', 'm')).toBeNull();
  });

  it('announces the source video, the image and the reference images Venice says a model takes', async () => {
    const recast = (await ready(RECAST)).provider.serviceCapabilities?.['minimax-h3-max-recast'];
    expect(recast).toEqual({
      outputs: ['video'],
      supportedParameters: ['duration', 'image_url', 'prompt', 'reference_image_urls', 'resolution', 'video_url'],
      video: { inputs: ['video', 'reference_image'], requiredInputs: ['video', 'reference_image'], resolutions: ['768P', '1080P'] },
    });
    // Every video-to-video model takes `image_url` (motion control's character); no model name decides it.
    const motion = (await ready(MOTION)).provider.serviceCapabilities?.['kling-v3-standard-motion-control'];
    expect(motion?.supportedParameters).toEqual(['duration', 'image_url', 'prompt', 'video_url']);
    expect(motion?.video).toEqual({ inputs: ['video', 'reference_image'], requiredInputs: ['video'] });
    const wan = (await ready(WAN)).provider.serviceCapabilities?.['wan-2-7-video-to-video'];
    expect(wan?.supportedParameters).toEqual(['duration', 'image_url', 'prompt', 'resolution', 'video_url']);
    expect(wan?.video).toEqual({ inputs: ['video', 'reference_image'], requiredInputs: ['video'], resolutions: ['1080p', '720p'] });
    expect(veniceEditCapabilities({ video: { inputs: ['video'], requiredInputs: ['video'], durationsSeconds: [5], resolutions: ['768P'] } }, RECAST, 'required').video)
      .toEqual({ inputs: ['video', 'reference_image'], requiredInputs: ['video'], durationsSeconds: [5], resolutions: ['768P'] });
  });

  it('forwards a create as sent', async () => {
    const { provider, fetchMock } = await ready(RECAST);
    const body = { video_url: sourceMp4(10_400), reference_image_urls: ['data:image/png;base64,AAAA'], resolution: '768P', duration: '10s' };
    const response = await provider.handleRequest(create('minimax-h3-max-recast', body));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({ model: 'minimax-h3-max-recast', ...body });
  });

  it('refuses an edit Venice bills for the whole source unless duration is the measured source length', async () => {
    const { provider, fetchMock } = await ready(WAN);
    const calls = fetchMock.mock.calls.length;
    const refused = async (body: object) => {
      const response = await provider.handleRequest(create(WAN.id, { prompt: 'snow', ...body }));
      expect(response.statusCode).toBe(422);
      return parse(response.body).error;
    };
    expect(await refused({ video_url: sourceMp4(12_400), duration: '3s' })).toMatchObject({ code: 'invalid_video_duration', message: expect.stringContaining(': 12') });
    expect((await refused({ video_url: 'https://example.com/source.mp4', duration: '12s' })).message).toContain('inline');
    expect(fetchMock.mock.calls.length).toBe(calls);
    // Grok sets its own duration (5s/10s/15s), so its source length is not checked.
    const grok = await ready(GROK);
    expect((await grok.provider.handleRequest(create(GROK.id, { prompt: 'snow', video_url: 'https://example.com/source.mp4', duration: '5s' }))).statusCode).toBe(200);
  });

  it('turns Venice\'s HTML 413 into JSON', async () => {
    const provider = plugin.createProvider(editConfig(RECAST.id)) as Provider;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html><title>413 Request Entity Too Large</title></html>', { status: 413, headers: { 'content-type': 'text/html' } })));
    const response = await provider.handleRequest(create('minimax-h3-max-recast', { duration: '10s' }));
    expect(response.statusCode).toBe(413);
    expect(parse(response.body).error).toMatchObject({ code: 'request_too_large', message: expect.stringContaining(`${VENICE_MAX_BODY_BYTES / 1_000_000} MB`) });
  });

  it('turns Venice\'s JSON refusal of a rejected job into FAILED', () => {
    expect(terminalRetrieveFailure(400, Buffer.from(JSON.stringify({ message: 'No person detected', status: 400 })))).toBe('No person detected');
    expect(terminalRetrieveFailure(422, Buffer.from(JSON.stringify({ error: { message: 'bad source' } })))).toBe('bad source');
    expect(terminalRetrieveFailure(422, Buffer.from('{}'))).toBe('Venice answered HTTP 422 with no reason');
    expect(terminalRetrieveFailure(429, Buffer.from(JSON.stringify({ message: 'slow down' })))).toBeNull();
    expect(terminalRetrieveFailure(500, Buffer.from(JSON.stringify({ message: 'oops' })))).toBeNull();
    expect(terminalRetrieveFailure(400, Buffer.from('<html>'))).toBeNull();
  });
});
