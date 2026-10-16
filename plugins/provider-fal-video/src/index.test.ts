import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provider, ProviderStreamCallbacks, SerializedHttpRequest } from '@antseed/node';
import plugin, { falAppId, falInputParameters, withFrameInputs } from './index.js';

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
  expect(parse(fetchMock.mock.calls[1]![1].body)).toEqual(input);
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
  expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('checks the balance with the optional billing key', async () => {
    const withBilling = { ...twoModels, FAL_VIDEO_BILLING_API_KEY: 'billing-secret', FAL_VIDEO_MIN_BALANCE_USD: '1' };
    const checkAccount = () => (plugin.createProvider(withBilling) as Provider).checkUpstreamAccount!();
    expect((plugin.createProvider(twoModels) as Provider).checkUpstreamAccount).toBeUndefined();
    const fetchMock = mockFal(models([]), Response.json({ credits: { current_balance: 12.5, currency: 'USD' } }));
    expect(await checkAccount()).toEqual({ status: 'available', balanceUsd: 12.5 });
    const [billingUrl, billingInit] = fetchMock.mock.calls.find(([url]) => url.includes('billing'))!;
    expect(billingUrl).toBe('https://api.fal.ai/v1/account/billing?expand=credits');
    expect(billingInit).toMatchObject({ headers: { authorization: 'Key billing-secret' } });

    mockFal(models([]), Response.json({ credits: { current_balance: 0.5, currency: 'USD' } }));
    expect(await checkAccount()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('$0.50') });
  });

  it('reports unknown and warns once when the billing key lacks permission', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = plugin.createProvider({ ...twoModels, FAL_VIDEO_BILLING_API_KEY: 'run-only' }) as Provider;
    for (let i = 0; i < 2; i++) {
      mockFal(models([]), Response.json({ error: {} }, { status: 403 }));
      expect(await provider.checkUpstreamAccount!()).toMatchObject({ status: 'unknown', reason: expect.stringContaining('billing:usage:read') });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => plugin.createProvider({ ...twoModels, FAL_VIDEO_MIN_BALANCE_USD: 'x' })).toThrow('FAL_VIDEO_MIN_BALANCE_USD');
    warn.mockRestore();
  });
});
