import { describe, it, expect } from 'vitest';
import { nativeVideoRoute, nativeVideoAcceptance, nativeVideoFacts, requestService, detectRequestServiceApiProtocol, selectTargetProtocolForRequest, inferProviderDefaultServiceApiProtocols, isNativeVideoProtocol, NATIVE_VIDEO_PROTOCOLS, nativeVideoOptionError } from '../src/index.js';

describe('native video API contracts', () => {
  const request = (path: string, body: object = {}, method = 'POST') => ({ requestId: 'request', method, path, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });

  it.each([
    { protocol: 'seedance-video', path: '/api/v3/contents/generations/tasks', body: { model: 'seedance', content: [{ type: 'image_url', image_url: { url: 'https://media.example/image.png' }, role: 'first_frame' }], duration: 8 } },
    { protocol: 'venice-video', path: '/api/v1/video/queue', body: { model: 'video', prompt: 'Animate', image_url: 'https://media.example/image.png', duration: '8s' } },
  ])('routes $protocol image-to-video as a video create, not an image generation', ({ protocol, path, body }) => {
    const req = request(path, body);
    expect(nativeVideoRoute(req)).toMatchObject({ protocol, action: 'create' });
    expect(detectRequestServiceApiProtocol(req)).toBe(protocol);
    expect(nativeVideoFacts(req)).toMatchObject({ protocol, action: 'create', count: 1, duration: 8 });
    expect(nativeVideoRoute(req)?.referencedResourceIds).toBeUndefined();
  });

  it('recognizes native paths and never translates into chat or another video API', () => {
    expect(detectRequestServiceApiProtocol(request('/api/v3/contents/generations/tasks'))).toBe('seedance-video');
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks/task-123', {}, 'DELETE'))).toBeNull();
    expect(nativeVideoRoute(request('/v1beta/models/veo-3.1:predictLongRunning'))).toBeNull();
    expect(selectTargetProtocolForRequest('seedance-video', ['venice-video', 'openai-chat-completions'])).toBeNull();
  });

  it('rejects traversal, unsupported methods, account endpoints and malformed resources', () => {
    for (const path of ['/api/v3/contents/generations/tasks/../account', '/api/v3/contents/generations/tasks/%2e%2e', '/api/v3/contents/generations/tasks/task/extra', '/v1beta/files/file', '/v1beta/operations/job:cancel']) {
      expect(nativeVideoRoute(request(path))).toBeNull();
    }
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks', {}, 'GET'))).toBeNull();
  });

  it('extracts body models, with a service header only for follow-ups', () => {
    expect(requestService(request('/api/v3/contents/generations/tasks', { model: 'seedance-2-0' }))).toBe('seedance-2-0');
    expect(requestService(request('/api/v3/contents/generations/tasks', { model: 'seedance-2-0', service: 'extension' }))).toBe('seedance-2-0');
    expect(requestService(request('/api/v3/contents/generations/tasks', { service: 'seedance-2-0' }))).toBeUndefined();
    for (const model of ['antseed', `${'a'.repeat(40)}@seedance-2-0`, ' Seedance-2-0 ']) {
      expect(requestService(request('/api/v3/contents/generations/tasks', { model }))).toBe(model);
    }
    const followUp = request('/api/v3/contents/generations/tasks/task', {}, 'GET');
    followUp.headers = { ...followUp.headers, 'x-antseed-service': 'seedance-2-0' } as typeof followUp.headers;
    expect(requestService(followUp)).toBe('seedance-2-0');
  });

  it('requires an accepted response with a valid ID and no immediate error', () => {
    const response = (body: object, statusCode = 200) => ({ requestId: 'request', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(nativeVideoAcceptance('seedance-video', response({ id: 'task' }, 202))).toBe('task');
    expect(nativeVideoAcceptance('seedance-video', response({ id: 'task', error: {} }))).toBeNull();
    expect(nativeVideoAcceptance('seedance-video', response({ id: 'task' }, 503))).toBeNull();
    expect(nativeVideoAcceptance('seedance-video', response({ id: '../account' }))).toBeNull();
  });

  it('extracts native quantities without defaulting duration', () => {
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: 8 }))?.duration).toBe(8);
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks'))?.duration).toBeUndefined();
    expect(() => nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: 0 }))).toThrow();
  });

  it('follows the native Seedance API field shapes', () => {
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks', { model: 'seedance-2-0', duration: -1 }))?.duration).toBeUndefined();
    expect(() => nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: 'soon' }))).toThrow(/duration/);
  });

  it('describes Seedance with the same create and poll lifecycle', () => {
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks'))).toEqual({ protocol: 'seedance-video', action: 'create' });
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks/cgt-1', {}, 'GET'))).toMatchObject({ protocol: 'seedance-video', action: 'status', resourceId: 'cgt-1' });

    const response = (body: object) => ({ requestId: 'request', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(nativeVideoAcceptance('seedance-video', response({ id: 'cgt-1' }))).toBe('cgt-1');
  });

  it('reads billing quantities from each API field shape', () => {
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: 5 }))?.duration).toBe(5);
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: -1 }))?.duration).toBeUndefined();
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: 5, frames: 57 }))?.duration).toBeUndefined();
  });

  it('shares one native video protocol list', () => {
    expect(NATIVE_VIDEO_PROTOCOLS).toEqual(['seedance-video', 'venice-video']);
    expect(isNativeVideoProtocol('venice-video')).toBe(true);
    expect(isNativeVideoProtocol('openai-images')).toBe(false);
    expect(inferProviderDefaultServiceApiProtocols('seedance')).toEqual(['seedance-video']);
  });

  it('does not route the removed native video APIs', () => {
    for (const protocol of ['veo-video', 'runway-video', 'minimax-video', 'wan-video']) expect(isNativeVideoProtocol(protocol)).toBe(false);
    for (const path of ['/v1/text_to_video', '/v1/image_to_video', '/v2/video_generation', '/api/v1/services/aigc/video-generation/video-synthesis']) {
      expect(nativeVideoRoute(request(path))).toBeNull();
    }
    for (const path of ['/v1/tasks/task', '/v2/query/video_generation/task', '/api/v1/tasks/task']) {
      expect(nativeVideoRoute(request(path, {}, 'GET'))).toBeNull();
    }
  });
});

describe('Venice video API', () => {
  const request = (path: string, body: object = {}, headers: Record<string, string> = {}) => ({ requestId: 'request', method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: new TextEncoder().encode(JSON.stringify(body)) });

  it('reads the job from the body for retrieve and does not relay complete', () => {
    const queueId = '123e4567-e89b-12d3-a456-426614174000';
    expect(nativeVideoRoute(request('/api/v1/video/queue', { model: 'wan-2.5' }))).toEqual({ protocol: 'venice-video', action: 'create' });
    expect(nativeVideoRoute(request('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: queueId }))).toEqual({ protocol: 'venice-video', action: 'download', resourceId: queueId });
    expect(nativeVideoRoute(request('/api/v1/video/complete', { queue_id: queueId }))).toBeNull();
    expect(nativeVideoRoute({ method: 'POST', path: '/api/v1/video/retrieve' })).toEqual({ protocol: 'venice-video', action: 'download' });
    for (const queue_id of ['../account', 5, '', undefined]) {
      expect(nativeVideoRoute(request('/api/v1/video/retrieve', { queue_id }))?.resourceId).toBeUndefined();
    }
    expect(nativeVideoRoute({ ...request('/api/v1/video/retrieve'), method: 'GET' })).toBeNull();
    expect(nativeVideoRoute(request('/api/v1/video/quote'))).toBeNull();
    expect(detectRequestServiceApiProtocol(request('/api/v1/video/retrieve'))).toBe('venice-video');
    expect(inferProviderDefaultServiceApiProtocols('venice')).toEqual(['venice-video']);
  });

  it('uses the routed service for follow-ups and the body model for creates', () => {
    expect(requestService(request('/api/v1/video/queue', { model: 'wan-2.5' }))).toBe('wan-2.5');
    expect(requestService(request('/api/v1/video/retrieve', { model: 'other', queue_id: 'q' }, { 'x-antseed-service': 'wan-2.5' }))).toBe('wan-2.5');
  });

  it('parses Venice duration strings and accepts only a returned queue_id', () => {
    const facts = (duration: unknown) => nativeVideoFacts(request('/api/v1/video/queue', { model: 'm', duration }));
    expect(facts('5s')?.duration).toBe(5);
    expect(facts('10s')?.duration).toBe(10);
    for (const auto of ['auto', 'Auto', '-1', '1 gen']) expect(facts(auto)?.duration).toBeUndefined();
    expect(() => facts('abc')).toThrow();
    expect(nativeVideoFacts(request('/api/v1/video/retrieve', { queue_id: 'q' }))).toEqual({ protocol: 'venice-video', action: 'download', count: 0 });
    const response = (body: object, statusCode = 200) => ({ requestId: 'request', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(nativeVideoAcceptance('venice-video', response({ model: 'm', queue_id: 'q-1', download_url: 'https://x' }))).toBe('q-1');
    expect(nativeVideoAcceptance('venice-video', response({ error: 'INSUFFICIENT_BALANCE' }, 402))).toBeNull();
  });
});

describe('Seedance (BytePlus ModelArk) video API', () => {
  const request = (path: string, body: object = {}, method = 'POST') => ({ requestId: 'request', method, path, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });
  const create = (body: object) => request('/api/v3/contents/generations/tasks', { model: 'dreamina-seedance-2-0-260128', ...body });

  it('routes create and retrieve, and refuses delete and the account-wide task list', () => {
    expect(nativeVideoRoute(create({}))).toEqual({ protocol: 'seedance-video', action: 'create' });
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks/cgt-2025abc', {}, 'GET'))).toEqual({ protocol: 'seedance-video', action: 'status', resourceId: 'cgt-2025abc' });
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks/cgt-2025abc', {}, 'DELETE'))).toBeNull();
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks?page_size=500', {}, 'GET'))).toBeNull();
  });

  it('bills documented durations and needs per-generation pricing for model-chosen lengths', () => {
    expect(nativeVideoFacts(create({ duration: 12 }))?.duration).toBe(12);
    expect(nativeVideoFacts(create({ duration: -1 }))?.duration).toBeUndefined();
    expect(nativeVideoFacts(create({ frames: 57, duration: 5 }))?.duration).toBeUndefined();
    expect(nativeVideoFacts(create({}))?.duration).toBeUndefined();
    expect(nativeVideoFacts(create({ draft: true, service_tier: 'flex', priority: 9, generate_audio: false, resolution: '1080p' }))?.resolution).toBe('1080p');
  });

  it('exposes draft task references so the final video goes to the seller that owns the draft', () => {
    const final = create({ content: [{ type: 'draft_task', draft_task: { id: 'cgt-draft' } }, { type: 'text', text: 'boat' }] });
    expect(nativeVideoRoute(final)?.referencedResourceIds).toEqual(['cgt-draft']);
    expect(nativeVideoRoute(create({ content: [{ type: 'draft_task', draft_task: { id: '../x' } }] }))?.referencedResourceIds).toEqual(['']);
    expect(nativeVideoRoute(create({ content: [{ type: 'text', text: 'boat' }] }))?.referencedResourceIds).toBeUndefined();
  });
});

describe('advertised video options', () => {
  const create = (path: string, body: object) => ({ requestId: 'r', method: 'POST', path, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });
  const venice = (body: object) => create('/api/v1/video/queue', { model: 'video', prompt: 'cat', ...body });
  const options = { durationsSeconds: [5, 10], resolutions: ['720p'], aspectRatios: ['16:9'], inputs: ['first_frame' as const, 'last_frame' as const], requiredInputs: ['first_frame' as const], audio: false };
  const image = { image_url: 'https://media.example/a.png' };

  it('accepts matching creates and ignores follow-ups, auto durations and undescribed options', () => {
    expect(nativeVideoOptionError(venice({ ...image, duration: '5s', resolution: '720P', aspect_ratio: '16:9' }), options)).toBeNull();
    expect(nativeVideoOptionError(venice({ ...image, duration: 'auto' }), options)).toBeNull();
    expect(nativeVideoOptionError(venice({ duration: '7s' }), undefined)).toBeNull();
    expect(nativeVideoOptionError(create('/api/v1/video/retrieve', { model: 'video', queue_id: 'q' }), options)).toBeNull();
  });

  it.each([
    [{ ...image, duration: '7s' }, /duration; choose one of 5, 10/],
    [{ ...image, resolution: '1080p' }, /resolution/],
    [{ ...image, aspect_ratio: '9:16' }, /aspect ratio/],
    [{ ...image, video_url: 'https://media.example/a.mp4' }, /input video/],
    [{}, /Missing required video input first_frame/],
    [{ ...image, audio: true }, /audio/],
  ])('rejects %j', (body, message) => {
    expect(nativeVideoOptionError(venice(body), options)).toMatch(message);
  });

  it('reads media inputs from each native API shape', () => {
    const textOnly = { inputs: [] };
    expect(nativeVideoOptionError(create('/api/v1/video/queue', { model: 'video', prompt: 'cat', end_image_url: 'https://media.example/end.png' }), textOnly)).toMatch(/last_frame/);
    expect(nativeVideoOptionError(create('/api/v3/contents/generations/tasks', { model: 'seedance', content: [{ type: 'image_url', role: 'reference_image' }] }), textOnly)).toMatch(/reference_image/);
    expect(nativeVideoOptionError(create('/api/v3/contents/generations/tasks', { model: 'seedance', content: [{ type: 'text', text: 'cat' }] }), textOnly)).toBeNull();
  });
});
