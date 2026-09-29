import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeVideoProvider, type NativeVideoProviderOptions } from './native-video-provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('seller-operated native video relays', () => {
  {
    const name = 'seedance';
    const protocol = 'seedance-video';
    const options: NativeVideoProviderOptions = {
      name: 'custom-video-seller', protocol,
      relay: { baseUrl: 'https://seller.example.test', authHeaderName: 'x-seller-key', authHeaderValue: 'seller-secret', extraHeaders: { 'x-seller-version': 'custom-v1' } },
    };
    const config = {
      ANTSEED_ALLOWED_SERVICES: 'video-model',
      ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ 'video-model': { [protocol]: { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.5 }] } } }),
    };

    it(`${name} requires an explicit seller endpoint and pricing`, () => {
      expect(() => createNativeVideoProvider({ ...options, relay: { ...options.relay, baseUrl: '' } }, config)).toThrow(/seller-operated/);
      expect(() => createNativeVideoProvider({ ...options, relay: { ...options.relay, authHeaderValue: '' } }, config)).toThrow(/authentication/);
      expect(() => createNativeVideoProvider(options, { ...config, ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{}' })).toThrow(/pricing/);
      const provider = createNativeVideoProvider(options, config);
      expect(provider.serviceApiProtocols).toEqual({ 'video-model': [protocol] });
      expect(provider.name).toBe('custom-video-seller');
    });

    it(`${name} preserves native payloads and injects seller auth without exposing account endpoints`, async () => {
      const body = { model: 'video-model', service: { extension: true }, content: [{ type: 'text', text: '猫' }], duration: 8, custom: [1, null, 'value'] };
      const acceptance = { id: 'task' };
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(acceptance), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);
      const provider = createNativeVideoProvider(options, config);
      const request = { requestId: 'request', method: 'POST', path: '/api/v3/contents/generations/tasks', headers: { 'content-type': 'application/json', authorization: 'buyer-key', 'x-goog-api-key': 'buyer-key', 'x-antseed-buyer-peer-id': 'a'.repeat(40), 'x-antseed-provider': name }, body: new TextEncoder().encode(` \n${JSON.stringify(body, null, 2)}\n`) };
      const result = await provider.handleRequest(request);
      expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual(acceptance);
      const [url, fetchOptions] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`https://seller.example.test${request.path}`);
      expect(JSON.parse(Buffer.from(fetchOptions.body).toString())).toEqual(body);
      expect(Buffer.from(fetchOptions.body)).toEqual(Buffer.from(request.body));
      expect(fetchOptions.headers['x-antseed-buyer-peer-id']).toBe('a'.repeat(40));
      expect(fetchOptions.headers['x-antseed-provider']).toBeUndefined();
      expect(fetchOptions.headers['x-seller-key']).toBe('seller-secret');
      expect(fetchOptions.headers['x-seller-version']).toBe('custom-v1');
      expect(fetchOptions.headers['authorization']).toBeUndefined();
      expect(fetchOptions.headers['x-goog-api-key']).toBeUndefined();
      expect(fetchOptions.redirect).toBe('error');
      expect((await provider.handleRequest({ ...request, path: '/v1/account' })).statusCode).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(`${name} validates the exact native model rather than extension fields`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const provider = createNativeVideoProvider(options, config);
      for (const model of ['VIDEO-MODEL', ' video-model ', 'unavailable']) {
        const request = { requestId: 'request', method: 'POST', path: '/api/v3/contents/generations/tasks', headers: { 'content-type': 'application/json', 'x-antseed-service': 'video-model' }, body: Buffer.from(JSON.stringify({ model, service: 'video-model' })) };
        expect((await provider.handleRequest(request)).statusCode).toBe(400);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('does not retry an uncertain upstream submission', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection reset'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createNativeVideoProvider({ name: 'custom-video-seller', protocol: 'seedance-video', relay: { baseUrl: 'https://seller.example.test', authHeaderName: 'x-seller-key', authHeaderValue: 'key' } }, { ANTSEED_ALLOWED_SERVICES: 'model', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"model":{"seedance-video":{"version":1,"components":[]}}}' });
    await provider.handleRequest({ requestId: 'request', method: 'POST', path: '/api/v3/contents/generations/tasks', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"model":"model"}') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects creates outside the advertised model options before contacting upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = createNativeVideoProvider({ name: 'custom-video-seller', protocol: 'seedance-video', relay: { baseUrl: 'https://seller.example.test', authHeaderName: 'x-seller-key', authHeaderValue: 'key' } }, {
      ANTSEED_ALLOWED_SERVICES: 'model',
      ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"model":{"seedance-video":{"version":1,"components":[]}}}',
      ANTSEED_SERVICE_CAPABILITIES_JSON: '{"model":{"video":{"durationsSeconds":[5],"inputs":[]}}}',
    });
    for (const body of [{ model: 'model', duration: 10 }, { model: 'model', content: [{ type: 'image_url', role: 'first_frame' }] }]) {
      const response = await provider.handleRequest({ requestId: 'request', method: 'POST', path: '/api/v3/contents/generations/tasks', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(Buffer.from(response.body).toString()).error.code).toBe('unsupported_video_options');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
