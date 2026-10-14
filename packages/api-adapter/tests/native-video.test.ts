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
    expect(nativeVideoFacts(req)).toEqual({ protocol: 'venice-video', action: 'create', duration: 8 });
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

  it('routes fal video with the endpoint ID as the service', () => {
    const model = 'fal-ai/kling-video/v2.1/standard/text-to-video';
    const create = request('/fal/v1/video/queue', { model, prompt: 'cat', duration: '5' });
    expect(nativeVideoRoute(create)).toEqual({ protocol: 'fal-video', action: 'create' });
    expect(detectRequestServiceApiProtocol(create)).toBe('fal-video');
    expect(requestService(create)).toBe(model);
    expect(nativeVideoFacts(create)).toEqual({ protocol: 'fal-video', action: 'create', duration: 5 });
    expect(nativeVideoFacts(request('/fal/v1/video/queue', { model, duration: 8 }))?.duration).toBe(8);
    expect(nativeVideoFacts(request('/fal/v1/video/queue', { model, duration: '6s' }))?.duration).toBe(6);
    expect(() => nativeVideoFacts(request('/fal/v1/video/queue', { model, duration: 'auto' }))).toThrow(/duration/);
    expect(nativeVideoRoute(request('/fal/v1/video/retrieve', { request_id: '764cabcf-b745-4b3e-ae38-1200304cf45b' })))
      .toEqual({ protocol: 'fal-video', action: 'retrieve', resourceId: '764cabcf-b745-4b3e-ae38-1200304cf45b' });
    expect(nativeVideoRoute(request('/fal/v1/video/retrieve', { request_id: '../x' }))?.resourceId).toBeUndefined();
    expect(nativeVideoRoute(request('/fal/v1/video/retrieve', { queue_id: 'venice-id' }))?.resourceId).toBeUndefined();
    const response = (body: object) => ({ requestId: 'request', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(nativeVideoAcceptance('fal-video', response({ request_id: 'abc-123' }))).toBe('abc-123');
    expect(nativeVideoAcceptance('fal-video', response({ queue_id: 'abc-123' }))).toBeNull();
    expect(nativeVideoAcceptance('venice-video', response({ request_id: 'abc-123' }))).toBeNull();
  });

  it('shares the Venice and fal native video protocols', () => {
    expect(NATIVE_VIDEO_PROTOCOLS).toEqual(['venice-video', 'fal-video']);
    expect(isNativeVideoProtocol('fal-video')).toBe(true);
    expect(isNativeVideoProtocol('venice-video')).toBe(true);
    expect(isNativeVideoProtocol('seedance-video')).toBe(false);
    expect(inferProviderDefaultServiceApiProtocols('venice')).toEqual([]);
  });

});
