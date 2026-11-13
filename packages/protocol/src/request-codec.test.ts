import { describe, it, expect } from 'vitest';
import {
  encodeHttpRequest,
  decodeHttpRequest,
  encodeHttpResponse,
  encodeHttpResponsePrefix,
  decodeHttpResponse,
  encodeHttpResponseChunk,
  decodeHttpResponseChunk,
  encodeHttpRequestChunk,
  decodeHttpRequestChunk,
} from './request-codec.js';

describe('http payload codec', () => {
  it('round-trips a request with headers, unicode path, and body', () => {
    const request = {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/messages?q=café',
      headers: { 'Content-Type': 'application/json', 'x-antseed-provider': 'anthropic' },
      body: new TextEncoder().encode('{"model":"m","messages":[]}'),
    };
    const decoded = decodeHttpRequest(encodeHttpRequest(request));
    expect(decoded).toEqual(request);
  });

  it('round-trips a response', () => {
    const response = {
      requestId: 'req-2',
      statusCode: 402,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"error":"payment_required"}'),
    };
    expect(decodeHttpResponse(encodeHttpResponse(response))).toEqual(response);
  });

  it('encodes a response prefix followed by body bytes', () => {
    const response = {
      requestId: 'req-prefix',
      statusCode: 200,
      headers: { 'content-type': 'video/mp4' },
      body: new Uint8Array([1, 2, 3]),
    };
    const prefix = encodeHttpResponsePrefix(response, response.body.length);
    expect(new Uint8Array([...prefix, ...response.body])).toEqual(encodeHttpResponse(response));
    expect(() => encodeHttpResponsePrefix(response, 2 ** 32)).toThrow(RangeError);
  });

  it('round-trips response and request chunks', () => {
    const chunk = { requestId: 'req-3', done: false, data: new TextEncoder().encode('data: x\n\n') };
    expect(decodeHttpResponseChunk(encodeHttpResponseChunk(chunk))).toEqual(chunk);
    const done = { requestId: 'req-3', done: true, data: new Uint8Array(0) };
    expect(decodeHttpRequestChunk(encodeHttpRequestChunk(done))).toEqual(done);
  });
});
