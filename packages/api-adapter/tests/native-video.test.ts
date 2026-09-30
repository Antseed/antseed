import { describe, it, expect } from 'vitest';
import {
  nativeVideoRoute,
  nativeVideoAcceptance,
  nativeVideoFacts,
  requestService,
  detectRequestServiceApiProtocol,
  selectTargetProtocolForRequest,
  inferProviderDefaultServiceApiProtocols,
  detectNativeVideoProtocol,
  isNativeVideoProtocol,
  NATIVE_VIDEO_PROTOCOLS,
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
    expect(nativeVideoRoute(request('/api/v1/video/retrieve', { queue_id: 'task-123' }))).toEqual({ protocol: 'venice-video', action: 'retrieve', resourceId: 'task-123' });
    expect(nativeVideoRoute(request('/api/v1/video/complete', { queue_id: 'task-123' }))).toBeNull();
    expect(nativeVideoRoute(request('/v1beta/models/veo-3.1:predictLongRunning'))).toBeNull();
    expect(detectNativeVideoProtocol('/api/v1/video/retrieve?download=1')).toBe('venice-video');
    expect(detectNativeVideoProtocol('/API/V1/VIDEO/QUEUE')).toBeNull();
    expect(selectTargetProtocolForRequest('venice-video', ['openai-chat-completions'])).toBeNull();
  });

  it('rejects malformed and unsupported video routes', () => {
    expect(nativeVideoRoute(request('/api/v1/video/retrieve'))).toEqual({ protocol: 'venice-video', action: 'retrieve' });
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
    expect(inferProviderDefaultServiceApiProtocols('venice')).toEqual([]);
  });

});
