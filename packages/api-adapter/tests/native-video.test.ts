import { describe, it, expect } from 'vitest';
import {
  nativeVideoRoute,
  nativeVideoAcceptance,
  nativeVideoFacts,
  requestService,
  detectRequestServiceApiProtocol,
  selectTargetProtocolForRequest,
  inferProviderDefaultServiceApiProtocols,
  isNativeVideoProtocol,
  NATIVE_VIDEO_PROTOCOLS,
  nativeVideoOptionError,
} from '../src/index.js';

describe('native video API contracts', () => {
  const request = (path: string, body: object = {}, method = 'POST') => ({
    requestId: 'request',
    method,
    path,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  });

  it('routes Venice image-to-video as a video create', () => {
    const req = request('/api/v1/video/queue', { model: 'video', image_url: 'https://media.example/image.png', duration: '8s' });
    expect(nativeVideoRoute(req)).toEqual({ protocol: 'venice-video', action: 'create' });
    expect(detectRequestServiceApiProtocol(req)).toBe('venice-video');
    expect(nativeVideoFacts(req)).toEqual({ protocol: 'venice-video', action: 'create', count: 1, duration: 8 });
  });

  it('recognizes native paths without translating them into chat', () => {
    expect(nativeVideoRoute(request('/api/v1/video/queue'))).toEqual({ protocol: 'venice-video', action: 'create' });
    expect(nativeVideoRoute(request('/api/v1/video/retrieve', { queue_id: 'task-123' }))).toEqual({ protocol: 'venice-video', action: 'download', resourceId: 'task-123' });
    expect(nativeVideoRoute(request('/api/v1/video/complete', { queue_id: 'task-123' }))).toBeNull();
    expect(nativeVideoRoute(request('/v1beta/models/veo-3.1:predictLongRunning'))).toBeNull();
    expect(selectTargetProtocolForRequest('venice-video', ['openai-chat-completions'])).toBeNull();
  });

  it('rejects malformed and unsupported video routes', () => {
    expect(nativeVideoRoute(request('/api/v1/video/retrieve'))).toEqual({ protocol: 'venice-video', action: 'download' });
    expect(nativeVideoRoute(request('/api/v1/video/retrieve/../account'))).toBeNull();
    expect(nativeVideoRoute(request('/api/v1/video/quote'))).toBeNull();
    expect(nativeVideoRoute(request('/api/v1/video/queue', {}, 'GET'))).toBeNull();
    expect(nativeVideoRoute(request('/api/v1/video/retrieve', { queue_id: '../account' }))?.resourceId).toBeUndefined();
  });

  it('extracts Venice models and routed services', () => {
    expect(requestService(request('/api/v1/video/queue', { model: 'wan-2.5', service: 'extension' }))).toBe('wan-2.5');
    const followUp = request('/api/v1/video/retrieve', { model: 'other', queue_id: 'task' });
    followUp.headers = { ...followUp.headers, 'x-antseed-service': 'wan-2.5' };
    expect(requestService(followUp)).toBe('wan-2.5');
  });

  it('requires an accepted response with a valid queue id', () => {
    const response = (body: object, statusCode = 200) => ({ requestId: 'request', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(nativeVideoAcceptance('venice-video', response({ queue_id: 'task' }, 202))).toBe('task');
    expect(nativeVideoAcceptance('venice-video', response({ queue_id: 'task', error: {} }))).toBeNull();
    expect(nativeVideoAcceptance('venice-video', response({ queue_id: 'task' }, 503))).toBeNull();
    expect(nativeVideoAcceptance('venice-video', response({ queue_id: '../account' }))).toBeNull();
  });

  it('parses Venice durations and does not invent a duration', () => {
    expect(nativeVideoFacts(request('/api/v1/video/queue', { model: 'video', duration: '8s' }))?.duration).toBe(8);
    expect(nativeVideoFacts(request('/api/v1/video/queue', { model: 'video', duration: 'auto' }))?.duration).toBeUndefined();
    expect(() => nativeVideoFacts(request('/api/v1/video/queue', { model: 'video', duration: 'soon' }))).toThrow(/duration/);
  });

  it('shares only the Venice native video protocol', () => {
    expect(NATIVE_VIDEO_PROTOCOLS).toEqual(['venice-video']);
    expect(isNativeVideoProtocol('venice-video')).toBe(true);
    expect(isNativeVideoProtocol('seedance-video')).toBe(false);
    expect(inferProviderDefaultServiceApiProtocols('venice')).toEqual(['venice-video']);
  });

  it('validates advertised Venice video options', () => {
    const create = (body: object) => request('/api/v1/video/queue', { model: 'video', prompt: 'cat', ...body });
    const options = { durationsSeconds: [5, 10], resolutions: ['720p'], aspectRatios: ['16:9'], inputs: ['first_frame' as const], requiredInputs: ['first_frame' as const], audio: false };
    expect(nativeVideoOptionError(create({ image_url: 'https://media.example/a.png', duration: '5s', resolution: '720P', aspect_ratio: '16:9' }), options)).toBeNull();
    expect(nativeVideoOptionError(create({ duration: '7s' }), undefined)).toBeNull();
    expect(nativeVideoOptionError(create({ image_url: 'https://media.example/a.png', duration: '7s' }), options)).toMatch(/duration/);
    expect(nativeVideoOptionError(create({ image_url: 'https://media.example/a.png', audio: true }), options)).toMatch(/audio/);
    expect(nativeVideoOptionError(request('/api/v1/video/retrieve', { model: 'video', queue_id: 'q' }), options)).toBeNull();
  });
});
