import { describe, it, expect } from 'vitest';
import { nativeVideoRoute, nativeVideoAcceptance, nativeVideoFacts, nativeVideoResourceKey, requestService, detectRequestServiceApiProtocol, selectTargetProtocolForRequest, inferProviderDefaultServiceApiProtocols, isNativeVideoProtocol, NATIVE_VIDEO_PROTOCOLS } from '../src/index.js';
import { veoDownloadPath } from '../src/index.js';

describe('native video API contracts', () => {
  const request = (path: string, body: object = {}, method = 'POST') => ({ requestId: 'request', method, path, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });

  it('routes downloads by the owned operation, not the upstream file URL', () => {
    const path = veoDownloadPath('models/veo/operations/task', 0);
    const download = request(path, {}, 'GET');
    expect(nativeVideoRoute(download)).toEqual({ protocol: 'veo-video', action: 'download', resourceId: 'models/veo/operations/task', resultIndex: 0 });
    expect(detectRequestServiceApiProtocol(download)).toBe('veo-video');
    expect(nativeVideoFacts(download)).toEqual({ protocol: 'veo-video', action: 'download', count: 0 });
    expect(nativeVideoRoute(request(path))).toBeNull();
    for (const operation of ['../files/key', 'operations/%2e%2e', 'https://evil.test']) expect(() => veoDownloadPath(operation, 0)).toThrow();
    expect(() => veoDownloadPath('operations/task', -1)).toThrow();
  });

  it('recognizes native paths and never translates into chat or another video API', () => {
    expect(detectRequestServiceApiProtocol(request('/v1/text_to_video'))).toBe('runway-video');
    expect(nativeVideoRoute(request('/v1/tasks/task-123', {}, 'DELETE'))?.action).toBe('cancel');
    expect(nativeVideoRoute(request('/v1beta/models/veo-3.1:predictLongRunning'))?.model).toBe('veo-3.1');
    expect(nativeVideoRoute(request('/v1beta/models/veo-3.1/operations/job', {}, 'GET'))?.resourceId).toBe('models/veo-3.1/operations/job');
    expect(selectTargetProtocolForRequest('runway-video', ['veo-video', 'openai-chat-completions'])).toBeNull();
  });

  it('rejects traversal, unsupported methods, account endpoints and malformed resources', () => {
    for (const path of ['/v1/tasks/../account', '/v1/tasks/%2e%2e', '/v1/tasks', '/v1beta/files/file', '/v1beta/operations/job:cancel']) {
      expect(nativeVideoRoute(request(path))).toBeNull();
    }
    expect(nativeVideoRoute(request('/v1/text_to_video', {}, 'GET'))).toBeNull();
  });

  it('extracts body and path models, with a service header only for follow-ups', () => {
    expect(requestService(request('/v1/text_to_video', { model: 'gen4.5' }))).toBe('gen4.5');
    expect(requestService(request('/v1/text_to_video', { model: 'gen4.5', service: 'extension' }))).toBe('gen4.5');
    expect(requestService(request('/v1/text_to_video', { service: 'gen4.5' }))).toBeUndefined();
    for (const model of ['antseed', `${'a'.repeat(40)}@gen4.5`, ' Gen4.5 ']) {
      expect(requestService(request('/v1/text_to_video', { model }))).toBe(model);
    }
    expect(requestService(request('/v1beta/models/veo:predictLongRunning', { model: 'wrong' }))).toBe('veo');
    expect(requestService(request('/v1beta/models/veo:predictLongRunning', { model: 'wrong', service: 'extension' }))).toBe('veo');
    const followUp = request('/v1/tasks/task', {}, 'GET');
    followUp.headers = { ...followUp.headers, 'x-antseed-service': 'gen4.5' } as typeof followUp.headers;
    expect(requestService(followUp)).toBe('gen4.5');
  });

  it('requires an accepted response with a valid ID and no immediate error', () => {
    const response = (body: object, statusCode = 200) => ({ requestId: 'request', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(nativeVideoAcceptance('runway-video', response({ id: 'task' }, 202))).toBe('task');
    expect(nativeVideoAcceptance('veo-video', response({ name: 'models/veo/operations/job' }))).toBe('models/veo/operations/job');
    expect(nativeVideoAcceptance('veo-video', response({ name: 'operations/job', error: {} }))).toBeNull();
    expect(nativeVideoAcceptance('runway-video', response({ id: 'task' }, 503))).toBeNull();
    expect(nativeVideoAcceptance('runway-video', response({ id: '../account' }))).toBeNull();
  });

  it('extracts native quantities without defaulting duration', () => {
    expect(nativeVideoFacts(request('/v1/text_to_video', { duration: 8 }))?.duration).toBe(8);
    expect(nativeVideoFacts(request('/v1beta/models/veo:predictLongRunning', { parameters: { durationSeconds: 8, sampleCount: 2 } }))?.count).toBe(2);
    expect(nativeVideoFacts(request('/v1/text_to_video'))?.duration).toBeUndefined();
    expect(() => nativeVideoFacts(request('/v1/text_to_video', { duration: -1 }))).toThrow();
  });

  it('follows the native Runway and Gemini API field shapes', () => {
    const veo = (parameters: object) => nativeVideoFacts(request('/v1beta/models/veo:predictLongRunning', { instances: [{ prompt: 'cat' }], parameters }));
    expect(veo({ durationSeconds: '6', numberOfVideos: 1 })).toMatchObject({ count: 1, duration: 6 });
    expect(veo({ durationSeconds: 8, numberOfVideos: 2 })).toMatchObject({ count: 2, duration: 8 });
    expect(() => veo({ numberOfVideos: 2, sampleCount: 1 })).toThrow(/disagree/);
    expect(() => veo({ durationSeconds: '6.5' })).toThrow(/duration/);
    expect(nativeVideoFacts(request('/v1/text_to_video', { model: 'seedance2', duration: 'auto' }))?.duration).toBeUndefined();
    expect(() => nativeVideoFacts(request('/v1/text_to_video', { duration: 'soon' }))).toThrow(/duration/);
  });

  it('describes MiniMax, Wan and Seedance with the same create, poll and cancel lifecycle', () => {
    expect(nativeVideoRoute(request('/v2/video_generation'))).toEqual({ protocol: 'minimax-video', action: 'create' });
    expect(nativeVideoRoute(request('/v2/query/video_generation/424010985738629', {}, 'GET'))).toMatchObject({ protocol: 'minimax-video', action: 'status', resourceId: '424010985738629' });
    expect(nativeVideoRoute(request('/v2/video_generation/424010985738629', {}, 'DELETE'))).toMatchObject({ protocol: 'minimax-video', action: 'cancel' });
    expect(nativeVideoRoute(request('/v2/video_generation/424010985738629', {}, 'GET'))).toBeNull();
    expect(nativeVideoRoute(request('/api/v1/services/aigc/video-generation/video-synthesis'))).toEqual({ protocol: 'wan-video', action: 'create' });
    expect(nativeVideoRoute(request('/api/v1/tasks/0385dc79-5ff8', {}, 'GET'))).toMatchObject({ protocol: 'wan-video', action: 'status' });
    expect(nativeVideoRoute(request('/api/v1/tasks/0385dc79-5ff8', {}, 'DELETE'))).toBeNull();
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks'))).toEqual({ protocol: 'seedance-video', action: 'create' });
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks/cgt-1', {}, 'DELETE'))).toMatchObject({ protocol: 'seedance-video', action: 'cancel', resourceId: 'cgt-1' });

    const response = (body: object) => ({ requestId: 'request', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(nativeVideoAcceptance('minimax-video', response({ task_id: '424010985738629' }))).toBe('424010985738629');
    expect(nativeVideoAcceptance('wan-video', response({ output: { task_id: 'task', task_status: 'PENDING' } }))).toBe('task');
    expect(nativeVideoAcceptance('wan-video', response({ output: { task_id: 'task', task_status: 'FAILED' } }))).toBeNull();
    expect(nativeVideoAcceptance('seedance-video', response({ id: 'cgt-1' }))).toBe('cgt-1');
    expect(nativeVideoResourceKey('veo-video', 'models/veo/operations/job')).toBe('operations/job');
    expect(nativeVideoResourceKey('seedance-video', 'cgt-1')).toBe('cgt-1');
  });

  it('reads billing quantities from each API field shape', () => {
    expect(nativeVideoFacts(request('/v2/video_generation', { model: 'MiniMax-H3', duration: 5, resolution: '2K' }))).toMatchObject({ count: 1, duration: 5, resolution: '2K' });
    expect(nativeVideoFacts(request('/api/v1/services/aigc/video-generation/video-synthesis', { parameters: { duration: 10, resolution: '720P' } }))).toMatchObject({ duration: 10, resolution: '720P' });
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: 5 }))?.duration).toBe(5);
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: -1 }))?.duration).toBeUndefined();
    expect(nativeVideoFacts(request('/api/v3/contents/generations/tasks', { duration: 5, frames: 57 }))?.duration).toBeUndefined();
  });

  it('shares one native video protocol list', () => {
    expect(NATIVE_VIDEO_PROTOCOLS).toEqual(['runway-video', 'veo-video', 'minimax-video', 'wan-video', 'seedance-video', 'venice-video']);
    expect(isNativeVideoProtocol('wan-video')).toBe(true);
    expect(isNativeVideoProtocol('openai-images')).toBe(false);
    expect(inferProviderDefaultServiceApiProtocols('seedance')).toEqual(['seedance-video']);
    expect(detectRequestServiceApiProtocol(request('/v2/query/video_generation/1'))).toBe('minimax-video');
  });
});

describe('Venice video API', () => {
  const request = (path: string, body: object = {}, headers: Record<string, string> = {}) => ({ requestId: 'request', method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: new TextEncoder().encode(JSON.stringify(body)) });

  it('reads the job from the body for retrieve and complete', () => {
    const queueId = '123e4567-e89b-12d3-a456-426614174000';
    expect(nativeVideoRoute(request('/api/v1/video/queue', { model: 'wan-2.5' }))).toEqual({ protocol: 'venice-video', action: 'create' });
    expect(nativeVideoRoute(request('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: queueId }))).toEqual({ protocol: 'venice-video', action: 'download', resourceId: queueId });
    expect(nativeVideoRoute(request('/api/v1/video/complete', { queue_id: queueId }))).toEqual({ protocol: 'venice-video', action: 'cancel', resourceId: queueId });
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

  it('routes create, retrieve and cancel/delete, and refuses the account-wide task list', () => {
    expect(nativeVideoRoute(create({}))).toEqual({ protocol: 'seedance-video', action: 'create' });
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks/cgt-2025abc', {}, 'GET'))).toEqual({ protocol: 'seedance-video', action: 'status', resourceId: 'cgt-2025abc' });
    expect(nativeVideoRoute(request('/api/v3/contents/generations/tasks/cgt-2025abc', {}, 'DELETE'))).toEqual({ protocol: 'seedance-video', action: 'cancel', resourceId: 'cgt-2025abc' });
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
