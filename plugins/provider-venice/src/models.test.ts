import { afterEach, expect, it, vi } from 'vitest';
import plugin from './index.js';
import { veniceVideoOptionError, veniceVideoOptions } from './models.js';

afterEach(() => vi.unstubAllGlobals());

const model = (id: string, constraints: object) => ({ id, model_spec: { constraints } });

it('maps Venice model constraints to advertised video options', () => {
  expect(veniceVideoOptions(model('wan-2-7-text-to-video', { model_type: 'text-to-video', aspect_ratios: ['16:9', 'auto'], resolutions: ['720p'], durations: ['5s', 'Auto'], audio: false, audio_input: true }))).toEqual({
    durationsSeconds: [5], resolutions: ['720p'], aspectRatios: ['16:9'], inputs: ['audio'], audio: false,
  });
  expect(veniceVideoOptions(model('wan-2-7-image-to-video', { model_type: 'image-to-video', durations: ['5s'] }))).toMatchObject({ inputs: ['first_frame', 'last_frame'], requiredInputs: ['first_frame'] });
  expect(veniceVideoOptions(model('x-reference-to-video', { model_type: 'image-to-video' }))).toMatchObject({ inputs: ['reference_image'], requiredInputs: ['reference_image'] });
  expect(veniceVideoOptions(model('x-video-to-video', { model_type: 'video', video_input: true }))).toMatchObject({ inputs: ['video', 'reference_video'], requiredInputs: ['video'] });
  expect(veniceVideoOptions(model('unknown', {}))).toBeUndefined();
});

it('validates advertised Venice video options', () => {
  const request = (body: object) => ({ requestId: 'q', method: 'POST', path: '/api/v1/video/queue', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'video', prompt: 'cat', ...body })) });
  const options = { durationsSeconds: [5, 10], resolutions: ['720p'], aspectRatios: ['16:9'], inputs: ['first_frame' as const], requiredInputs: ['first_frame' as const], audio: false };
  expect(veniceVideoOptionError(request({ image_url: 'https://media.example/a.png', duration: '5s', resolution: '720P', aspect_ratio: '16:9' }), options)).toBeNull();
  expect(veniceVideoOptionError(request({ duration: '7s' }), undefined)).toBeNull();
  expect(veniceVideoOptionError(request({ image_url: 'https://media.example/a.png', duration: '7s' }), options)).toMatch(/duration/);
  expect(veniceVideoOptionError(request({ image_url: 'https://media.example/a.png', audio: true }), options)).toMatch(/audio/);
  expect(veniceVideoOptionError({ ...request({ queue_id: 'q' }), path: '/api/v1/video/retrieve' }, options)).toBeNull();
});

it('fills options from the Venice model list, rejects unsupported creates before upstream, and keeps explicit config', async () => {
  const list = { data: [model('wan-2.5', { model_type: 'text-to-video', durations: ['5s'] }), model('kling', { model_type: 'text-to-video', durations: ['5s'] })] };
  const fetchMock = vi.fn().mockResolvedValue(Response.json(list));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider({
    VENICE_API_KEY: 'seller-secret', ANTSEED_ALLOWED_SERVICES: 'wan-2.5,kling',
    ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ 'wan-2.5': { 'venice-video': { version: 1, components: [] } }, kling: { 'venice-video': { version: 1, components: [] } } }),
    ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({ kling: { video: { durationsSeconds: [10] } } }),
  });
  await provider.init!();
  expect(fetchMock.mock.calls[0]![0]).toBe('https://api.venice.ai/api/v1/models?type=video');
  expect(provider.serviceCapabilities?.['wan-2.5']).toMatchObject({ video: { durationsSeconds: [5], inputs: [] } });
  expect(provider.serviceCapabilities?.kling?.video).toEqual({ durationsSeconds: [10] });

  const response = await provider.handleRequest({ requestId: 'q', method: 'POST', path: '/api/v1/video/queue', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'wan-2.5', prompt: 'cat', duration: '10s' })) });
  expect(response.statusCode).toBe(400);
  expect(JSON.parse(Buffer.from(response.body).toString()).error.code).toBe('unsupported_video_options');
  expect(fetchMock).toHaveBeenCalledTimes(1);

  fetchMock.mockResolvedValueOnce(new Response('no', { status: 503 }));
  await expect(provider.init!()).rejects.toThrow(/503/);
});
