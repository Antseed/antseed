import { describe, expect, it } from 'vitest';
import { detectRequestServiceApiProtocol, selectTargetProtocolForRequest } from '../src/detect.js';
import { dataServiceDelivered, dataServiceRoute, withDataService } from '../src/data-service.js';
import { requestService } from '../src/native-video.js';

const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('data service requests', () => {
  it('detects /v1/data/<service>/ as openapi-data', () => {
    expect(detectRequestServiceApiProtocol({ path: '/v1/data/flights/search', headers: {} })).toBe('openapi-data');
    expect(detectRequestServiceApiProtocol({ path: '/v1/data/flights/openapi.json', headers: {} })).toBe('openapi-data');
    expect(detectRequestServiceApiProtocol({ path: '/v1/database', headers: {} })).toBeNull();
  });

  it('serves data only on data services, never through a chat fallback', () => {
    expect(selectTargetProtocolForRequest('openapi-data', ['openapi-data'])).toEqual({ targetProtocol: 'openapi-data', requiresTransform: false });
    expect(selectTargetProtocolForRequest('openapi-data', ['openai-chat-completions'])).toBeNull();
    expect(selectTargetProtocolForRequest('openai-chat-completions', ['openapi-data'])).toBeNull();
  });

  it('names the service in the path and keeps the operation path unchanged', () => {
    expect(dataServiceRoute({ method: 'POST', path: '/v1/data/flights/api/v1/search?limit=5' }))
      .toEqual({ protocol: 'openapi-data', service: 'flights', action: 'call', operationPath: '/api/v1/search?limit=5' });
    expect(dataServiceRoute({ method: 'GET', path: '/v1/data/chain%20state/blocks/latest' }))
      .toEqual({ protocol: 'openapi-data', service: 'chain state', action: 'call', operationPath: '/blocks/latest' });
    expect(dataServiceRoute({ method: 'POST', path: '/v1/data/' })).toBeNull();
    expect(dataServiceRoute({ method: 'POST', path: '/v1/data/%E0%A4%A/x' })).toBeNull();
    expect(dataServiceRoute({ method: 'POST', path: '/v1/chat/completions' })).toBeNull();
  });

  it('treats a GET of the service or its openapi.json as the free description', () => {
    expect(dataServiceRoute({ method: 'GET', path: '/v1/data/flights/openapi.json' })?.action).toBe('describe');
    expect(dataServiceRoute({ method: 'GET', path: '/v1/data/flights' })?.action).toBe('describe');
    expect(dataServiceRoute({ method: 'GET', path: '/v1/data/flights/' })?.action).toBe('describe');
    // Only a GET reads the description: a POST to the same path is an operation.
    expect(dataServiceRoute({ method: 'POST', path: '/v1/data/flights/openapi.json' })?.action).toBe('call');
  });

  it('reads the requested service from the path, ignoring any model in the body', () => {
    const request = {
      requestId: 'r', method: 'POST', path: '/v1/data/flights/search',
      headers: { 'content-type': 'application/json' }, body: body({ model: 'something-else', from: 'TLV' }),
    };
    expect(requestService(request)).toBe('flights');
  });

  it('renames the service in the path without touching the operation', () => {
    expect(withDataService({ method: 'POST', path: '/v1/data/alias/search?q=1' }, 'flights')?.path).toBe('/v1/data/flights/search?q=1');
    expect(withDataService({ method: 'GET', path: '/v1/data/alias' }, 'flights')?.path).toBe('/v1/data/flights');
    expect(withDataService({ method: 'POST', path: '/v1/chat/completions' }, 'flights')).toBeNull();
  });

  it('counts a 2xx answer with a body as delivered and nothing else', () => {
    expect(dataServiceDelivered({ statusCode: 200, body: body({ rows: [] }) })).toBe(true);
    expect(dataServiceDelivered({ statusCode: 204, body: new Uint8Array() })).toBe(false);
    expect(dataServiceDelivered({ statusCode: 400, body: body({ error: 'bad input' }) })).toBe(false);
    expect(dataServiceDelivered({ statusCode: 502, body: body({ error: 'upstream' }) })).toBe(false);
  });
});
