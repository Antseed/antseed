import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provider, ProviderStreamCallbacks, SerializedHttpRequest } from '@antseed/node';
import plugin, { FAL_BALANCE_CHECK_OFF, falAppId, falEditRule, falErrorReason, falSubmitTimeoutMs, falInputParameters, falInputSchema, withEditInputs, withFrameInputs } from './index.js';

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

const V3 = 'fal-ai/kling-video/v3/pro/image-to-video';
const v3Config = {
  ...config,
  ANTSEED_ALLOWED_SERVICES: V3,
  ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [V3]: { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } } }),
};
const schema = (endpointId: string, properties: Record<string, object>) => ({
  paths: { [`/${endpointId}`]: { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } } } } },
  components: { schemas: { Input: { properties } } },
});

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

it('reads the input field names from the fal schema', () => {
  expect(falInputParameters(schema(V3, { prompt: {}, start_image_url: {}, end_image_url: {} }), V3)).toEqual(['end_image_url', 'prompt', 'start_image_url']);
  expect(falInputParameters(schema('fal-ai/other', { prompt: {} }), V3)).toBeNull();
  expect(falInputParameters(schema(V3, { Prompt: {} }), V3)).toBeNull();
  expect(falInputParameters(schema(V3, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`field_${i}`, {}]))), V3)).toBeNull();
  expect(falInputParameters(null, V3)).toBeNull();
});

it('adds the frame inputs an endpoint\'s fields take to the announced video inputs', () => {
  expect(withFrameInputs({ video: { inputs: ['first_frame'] }, supportedParameters: ['image_url', 'prompt', 'tail_image_url'] }).video?.inputs)
    .toEqual(['first_frame', 'last_frame']);
  expect(withFrameInputs({ video: { inputs: [] }, supportedParameters: ['end_image_url', 'start_image_url'] }).video?.inputs)
    .toEqual(['first_frame', 'last_frame']);
  const unknown = { supportedParameters: ['image_url', 'tail_image_url'] };
  expect(withFrameInputs(unknown)).toBe(unknown);
  const textOnly = { video: { inputs: [] }, supportedParameters: ['prompt'] };
  expect(withFrameInputs(textOnly)).toBe(textOnly);
});

it('announces last_frame for a Kling endpoint whose fal schema has tail_image_url', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(schema(V3, { prompt: {}, image_url: {}, tail_image_url: {} }))));
  const provider = plugin.createProvider({ ...v3Config, ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ [V3]: { video: { inputs: ['first_frame'] } } }) }) as Provider;
  await provider.init!();
  expect(provider.serviceCapabilities?.[V3]?.video?.inputs).toEqual(['first_frame', 'last_frame']);
});

it('advertises each endpoint\'s fal input fields and forwards the body unchanged', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json(schema(V3, { prompt: {}, start_image_url: {}, end_image_url: {} })))
    .mockResolvedValueOnce(Response.json({ credits: { current_balance: 5 } }))
    .mockResolvedValue(Response.json({ request_id: 'req-1' }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = plugin.createProvider(v3Config) as Provider;
  expect(provider.serviceCapabilities?.[V3]?.supportedParameters).toBeUndefined();
  await provider.init!();
  expect(fetchMock.mock.calls[0]![0]).toBe(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(V3)}`);
  expect(fetchMock.mock.calls[0]![1].headers).toBeUndefined();
  expect(provider.serviceCapabilities?.[V3]).toEqual({ outputs: ['video'], supportedParameters: ['end_image_url', 'prompt', 'start_image_url'] });
  const input = { prompt: 'cat', image_url: 'first', start_image_url: 'start' };
  await provider.handleRequest(request('/fal/v1/video/queue', { model: V3, ...input }));
  expect(parse(fetchMock.mock.calls[2]![1].body)).toEqual(input);
});

it('keeps configured parameters and starts without them when the fal schema is unavailable', async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  const offline = plugin.createProvider(v3Config) as Provider;
  await offline.init!();
  expect(offline.serviceCapabilities?.[V3]).toEqual({ outputs: ['video'] });
  const configured = plugin.createProvider({ ...v3Config, ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ [V3]: { supportedParameters: ['prompt', 'start_image_url'] } }) }) as Provider;
  await configured.init!();
  expect(configured.serviceCapabilities?.[V3]?.supportedParameters).toEqual(['prompt', 'start_image_url']);
  // The schema is still read for its source-video limits; configured field names win.
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('openapi'))).toHaveLength(2);
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
    .mockResolvedValueOnce(Response.json({ detail: [{ loc: ['body', 'start_image_url'], msg: 'Field required', type: 'missing' }] }, { status: 422 })));
  const response = await stream(plugin.createProvider(config) as Provider);
  expect(parse(response.body)).toEqual({
    status: 'FAILED',
    error: 'start_image_url: Field required',
  });
});

it('reports a job as FAILED without a reason when fal gives none', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
    .mockResolvedValueOnce(new Response('', { status: 422 })));
  const response = await stream(plugin.createProvider(config) as Provider);
  expect(parse(response.body)).toEqual({ status: 'FAILED', error: 'fal answered HTTP 422 with no reason' });
});

it('scales the fal submit timeout with the request size', () => {
  expect(falSubmitTimeoutMs(1000)).toBe(61_000);
  expect(falSubmitTimeoutMs(12_000_000)).toBe(60_000 + 46_000);
  expect(falSubmitTimeoutMs(1_000_000_000)).toBe(600_000);
});

it('reads readable reasons from fal error bodies', () => {
  expect(falErrorReason({ detail: 'User is locked' })).toBe('User is locked');
  expect(falErrorReason({ detail: [{ loc: ['body', 'video_url'], msg: 'too small' }, { msg: 'bad' }] })).toBe('video_url: too small; bad');
  expect(falErrorReason({ error: 'NSFW' })).toBe('NSFW');
  expect(falErrorReason({})).toBeUndefined();
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

describe('checkServiceHealth and checkUpstreamAccount', () => {
  const OTHER = 'fal-ai/wan-pro/image-to-video';
  const twoModels = {
    ...config,
    ANTSEED_ALLOWED_SERVICES: `${MODEL},${OTHER}`,
    ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({
      [MODEL]: { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } },
      [OTHER]: { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } },
    }),
  };
  const notFound = () => Response.json({ error: { type: 'not_found', message: 'Endpoint(s) not found' } }, { status: 404 });
  const models = (list: Array<[string, string]>) =>
    Response.json({ models: list.map(([endpoint_id, status]) => ({ endpoint_id, metadata: { status } })) });
  const mockFal = (modelsResponse: Response | Error, billing?: Response) => {
    const fetchMock = vi.fn(async (url: string) => {
      const response = url.includes('/account/billing') ? billing! : modelsResponse;
      if (response instanceof Error) throw response;
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const check = (cfg: Record<string, string> = twoModels) =>
    (plugin.createProvider(cfg) as Provider).checkServiceHealth!([MODEL, OTHER]);

  it('reports listed endpoints as available from fal\'s model list, sending the seller key', async () => {
    const fetchMock = mockFal(models([[MODEL, 'active'], [OTHER, 'active']]));
    expect(await check()).toEqual({ [MODEL]: { status: 'available' }, [OTHER]: { status: 'available' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(MODEL)}&endpoint_id=${encodeURIComponent(OTHER)}`);
    expect(init.headers).toEqual({ authorization: 'Key seller-secret' });
  });

  it('reports a removed endpoint as unavailable and keeps a deprecated one with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFal(models([[MODEL, 'deprecated']]));
    const results = await check();
    expect(results[MODEL]).toEqual({ status: 'available' });
    expect(results[OTHER]).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('no longer offers') });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
    vi.stubGlobal('fetch', vi.fn(async () => notFound()));
    expect((await check())[MODEL]).toMatchObject({ status: 'unavailable' });
    warn.mockRestore();
  });

  it('looks endpoints up one by one when fal rejects a lookup for one unknown endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const ids = new URL(url).searchParams.getAll('endpoint_id');
      return ids.includes(OTHER) ? notFound() : models(ids.map((id): [string, string] => [id, 'active']));
    });
    vi.stubGlobal('fetch', fetchMock);
    const results = await check();
    expect(results[MODEL]).toEqual({ status: 'available' });
    expect(results[OTHER]).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('no longer offers') });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops the one-by-one lookup at a rate limit and reports unknown', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const ids = new URL(url).searchParams.getAll('endpoint_id');
      return ids.length > 1 ? notFound() : Response.json({ error: {} }, { status: 429 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await check()).toMatchObject({ [MODEL]: { status: 'unknown' }, [OTHER]: { status: 'unknown' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports unknown for any other 404, such as a moved route', async () => {
    mockFal(Response.json({ error: { type: 'not_found', message: 'Route not found' } }, { status: 404 }));
    expect(await check()).toMatchObject({ [MODEL]: { status: 'unknown' }, [OTHER]: { status: 'unknown' } });
  });

  it('reports unknown when the model list can not be read', async () => {
    mockFal(new Error('network down'));
    expect((await check())[MODEL]).toMatchObject({ status: 'unknown' });
  });

  it('checks the balance with the seller key', async () => {
    const provider = plugin.createProvider({ ...twoModels, FAL_VIDEO_MIN_BALANCE_USD: '1' }) as Provider;
    const fetchMock = mockFal(models([]), Response.json({ credits: { current_balance: 12.5, currency: 'USD' } }));
    expect(await provider.checkUpstreamAccount!()).toEqual({ status: 'available', balanceUsd: 12.5 });
    const [billingUrl, billingInit] = fetchMock.mock.calls.find(([url]) => url.includes('billing'))!;
    expect(billingUrl).toBe('https://api.fal.ai/v1/account/billing?expand=credits');
    expect(billingInit).toMatchObject({ headers: { authorization: 'Key seller-secret' } });

    mockFal(models([]), Response.json({ credits: { current_balance: 0.5, currency: 'USD' } }));
    expect(await provider.checkUpstreamAccount!()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('$0.50') });
    expect(() => plugin.createProvider({ ...twoModels, FAL_VIDEO_MIN_BALANCE_USD: 'x' })).toThrow('FAL_VIDEO_MIN_BALANCE_USD');
  });

  it('reports an invalid seller key as unavailable', async () => {
    mockFal(models([]), Response.json({ error: { type: 'authorization_error', message: 'Invalid API key' } }, { status: 401 }));
    expect(await (plugin.createProvider(twoModels) as Provider).checkUpstreamAccount!())
      .toMatchObject({ status: 'unavailable', reason: expect.stringContaining('401') });
  });

  it('warns once at startup and stops checking when the seller key lacks billing permission', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string) => (url.includes('/account/billing')
      ? Response.json({ error: { type: 'authorization_error' } }, { status: 403 })
      : Response.json(schema(MODEL, { prompt: {} }))));
    vi.stubGlobal('fetch', fetchMock);
    const provider = plugin.createProvider(twoModels) as Provider;
    await provider.init!();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[fal-video] ${FAL_BALANCE_CHECK_OFF}`);
    for (let i = 0; i < 2; i++) {
      expect(await provider.checkUpstreamAccount!()).toMatchObject({ status: 'unknown', reason: expect.stringContaining('billing:usage:read') });
    }
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/account/billing'))).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('logs at startup that the balance check is on when the key can read billing', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/account/billing')
      ? Response.json({ credits: { current_balance: 7.25 } })
      : Response.json(schema(MODEL, { prompt: {} })))));
    await (plugin.createProvider(twoModels) as Provider).init!();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('fal balance check is on: $7.25'));
    info.mockRestore();
  });
});

describe('video-to-video endpoints', () => {
  /** Real fal input schemas (trimmed to the endpoint's input), saved 2026-10-23. */
  const fixture = (endpointId: string) => JSON.parse(readFileSync(new URL(`./fixtures/${endpointId.replaceAll('/', '_')}.json`, import.meta.url), 'utf8'));
  const RECAST = 'minimax/h3-max/recast';
  const KLING_EDIT = 'kling/v4/video-to-video/edit';
  const MOTION = 'fal-ai/kling-video/v3/standard/motion-control';
  const WAN_EDIT = 'fal-ai/wan/v2.7/edit-video';
  const editConfig = (service: string, capabilities?: object) => ({
    FAL_VIDEO_API_KEY: 'seller-secret',
    ANTSEED_ALLOWED_SERVICES: service,
    ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [service]: { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.3 }] } } }),
    ...(capabilities ? { ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ [service]: capabilities }) } : {}),
  });
  const ready = async (service: string, capabilities?: object) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => String(url).startsWith('https://fal.ai/api/openapi')
      ? Response.json(fixture(service))
      : String(url).includes('/v1/account/billing') ? Response.json({ credits: { current_balance: 5 } }) : Response.json({ request_id: 'req-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = plugin.createProvider(editConfig(service, capabilities)) as Provider;
    await provider.init!();
    return { provider, fetchMock };
  };
  const create = (service: string, body: object, requestId = 'r') => ({ ...request('/fal/v1/video/queue', { model: service, ...body }), requestId });
  it('reads required fields, the x-fal source length and resolutions from the fal schemas', () => {
    expect(falInputSchema(fixture(RECAST), RECAST)).toMatchObject({ required: ['video_url', 'reference_image_urls'], resolutions: ['768P', '1080P'] });
    // Recast states its source length only in a description, so none is read.
    expect(falInputSchema(fixture(RECAST), RECAST)).not.toHaveProperty('sourceSeconds');
    expect(falInputSchema(fixture(KLING_EDIT), KLING_EDIT)).toMatchObject({ required: ['prompt', 'video_url'], sourceSeconds: { min: 3, max: 30.05 } });
    expect(falInputSchema(fixture(MOTION), MOTION)).toMatchObject({ sourceSeconds: { min: 3, max: 30.05 } });
    expect(falEditRule(falInputSchema(fixture(RECAST), RECAST))).toEqual({ outputFollowsSource: true });
    expect(falEditRule(falInputSchema(fixture(MOTION), MOTION))).toEqual({ outputFollowsSource: true });
    expect(falEditRule(falInputSchema(fixture(KLING_EDIT), KLING_EDIT))).toEqual({ outputFollowsSource: false });
    expect(falEditRule(falInputSchema(fixture(WAN_EDIT), WAN_EDIT))).toEqual({ outputFollowsSource: false });
    expect(falEditRule(falInputSchema(schema(V3, { prompt: {}, image_url: {} }), V3))).toBeNull();
  });

  it('announces the source video and character inputs, and the durations a source-length output can have', async () => {
    const { provider } = await ready(RECAST);
    expect(provider.serviceCapabilities?.[RECAST]).toEqual({
      outputs: ['video'],
      supportedParameters: ['enable_safety_checker', 'enhance_realism', 'prompt', 'reference_image_urls', 'resolution', 'seed', 'video_url'],
      video: {
        inputs: ['video', 'reference_image'],
        requiredInputs: ['video', 'reference_image'],
        resolutions: ['768P', '1080P'],
      },
    });
    // Motion control's output is as long as its source; x-fal limits the source to 3–30.05 s.
    const motion = (await ready(MOTION)).provider.serviceCapabilities?.[MOTION]?.video;
    expect(motion).toEqual({ inputs: ['video', 'reference_image'], requiredInputs: ['video', 'reference_image'], durationsSeconds: Array.from({ length: 28 }, (_, i) => i + 3) });
    // Kling v4 takes its own `duration`, so its durations are not derived from the source.
    expect((await ready(KLING_EDIT)).provider.serviceCapabilities?.[KLING_EDIT]?.video).toEqual({ inputs: ['video', 'reference_image'], requiredInputs: ['video'], resolutions: ['720p', '1080p'] });
  });

  it('keeps video options the seller configured', async () => {
    const { provider } = await ready(RECAST, { video: { inputs: ['video'], durationsSeconds: [5, 10], resolutions: ['768P'] } });
    expect(provider.serviceCapabilities?.[RECAST]?.video).toEqual({ inputs: ['video', 'reference_image'], requiredInputs: ['video', 'reference_image'], durationsSeconds: [5, 10], resolutions: ['768P'] });
    expect(withEditInputs({ outputs: ['video'] }, null, null)).toEqual({ outputs: ['video'] });
  });

  it('drops duration before calling fal for an endpoint that takes none', async () => {
    const { provider, fetchMock } = await ready(RECAST);
    const body = { video_url: 'https://example.com/source.mp4', reference_image_urls: ['data:image/png;base64,AAAA'], resolution: '768P', duration: 12 };
    const response = await provider.handleRequest(create(RECAST, body));
    expect(response.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(`https://queue.fal.run/${RECAST}`);
    expect(parse(init.body)).toEqual({ video_url: body.video_url, reference_image_urls: body.reference_image_urls, resolution: '768P' });
  });

  it('keeps duration for an endpoint that takes one', async () => {
    const { provider, fetchMock } = await ready(WAN_EDIT);
    await provider.handleRequest(create(WAN_EDIT, { prompt: 'make it snow', video_url: 'https://example.com/source.mp4', duration: 5 }));
    expect(parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ duration: 5 });
  });
});
