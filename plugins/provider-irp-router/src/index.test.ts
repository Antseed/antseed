import { describe, expect, it, vi } from 'vitest';
import type { SerializedHttpRequest } from '@antseed/node';
import { isFreeUnitBillingModel } from '@antseed/node';
import plugin, { IrpRouterProxy } from './index.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body));

function request(method: string, path: string, body?: unknown): SerializedHttpRequest {
  return { requestId: 'req-1', method, path, headers: { 'content-type': 'application/json', 'x-antseed-buyer-peer-id': 'b'.repeat(40) }, body: body === undefined ? new Uint8Array() : encode(body) };
}

const rankBody = {
  request: { messages: [{ role: 'user', content: 'hi' }] },
  routing: { cost_quality_tradeoff: 3, candidates: [{ id: 'openai:m@peer', model: 'm', pricing: { input: 1, cache_read: 1, output: 2 } }] },
};

function upstream(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } }));
}

describe('IrpRouterProxy', () => {
  it('forwards the IRP catalog and rank requests unchanged, with the API key and no AntSeed headers', async () => {
    const fetchMock = upstream(200, { object: 'list', data: [{ id: '*', object: 'model' }] });
    const proxy = new IrpRouterProxy({ baseUrl: 'https://router.example/', apiKey: 'secret', fetch: fetchMock });
    const models = await proxy.handleRequest(request('GET', '/v1/routing/models'));
    expect(models.statusCode).toBe(200);
    expect(decode(models.body).data[0].id).toBe('*');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://router.example/v1/routing/models');
    expect(init?.headers).toEqual({ accept: 'application/json, application/problem+json', authorization: 'Bearer secret' });

    await proxy.handleRequest(request('POST', '/v1/routing/rank', rankBody));
    const [rankUrl, rankInit] = fetchMock.mock.calls[1]!;
    expect(rankUrl).toBe('https://router.example/v1/routing/rank');
    expect(rankInit?.method).toBe('POST');
    expect(decode(rankInit!.body as Uint8Array)).toEqual(rankBody);
  });

  it('passes upstream problem details through and answers locally when the router is unreachable', async () => {
    const problem = { type: 'urn:irp:problem:no-scorable-candidate', title: 'No candidate', status: 422 };
    const proxy = new IrpRouterProxy({ baseUrl: 'https://router.example', fetch: upstream(422, problem, 'application/problem+json') });
    const answer = await proxy.handleRequest(request('POST', '/v1/routing/rank', rankBody));
    expect(answer.statusCode).toBe(422);
    expect(answer.headers['content-type']).toBe('application/problem+json');
    expect(decode(answer.body)).toEqual(problem);

    const down = new IrpRouterProxy({ baseUrl: 'https://router.example', fetch: vi.fn<typeof fetch>(async () => { throw new Error('ECONNREFUSED') }) });
    const unavailable = await down.handleRequest(request('GET', '/v1/routing/models'));
    expect(unavailable.statusCode).toBe(503);
    expect(decode(unavailable.body).type).toBe('urn:irp:problem:unavailable');
  });

  it('answers malformed rank requests and other paths locally, without calling the router', async () => {
    const fetchMock = upstream(200, {});
    const proxy = new IrpRouterProxy({ baseUrl: 'https://router.example', fetch: fetchMock });
    expect((await proxy.handleRequest(request('POST', '/v1/routing/rank', { routing: {} }))).statusCode).toBe(400);
    expect((await proxy.handleRequest(request('POST', '/v1/chat/completions', {}))).statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('provider-irp-router plugin', () => {
  const config = { IRP_ROUTER_BASE_URL: 'https://router.example', ANTSEED_ALLOWED_SERVICES: 'route' };

  it('advertises one irp-suggest routing service, free unless priced', () => {
    const provider = plugin.createProvider(config) as Awaited<ReturnType<typeof plugin.createProvider>>;
    expect(provider.services).toEqual(['route']);
    expect(provider.serviceApiProtocols).toEqual({ route: ['irp-suggest'] });
    expect(isFreeUnitBillingModel(provider.serviceUnitBillingModels!.route!['irp-suggest']!)).toBe(true);
    const paid = plugin.createProvider({ ...config, IRP_ROUTER_PRICE_USD: '0.002' }) as Awaited<ReturnType<typeof plugin.createProvider>>;
    expect(paid.serviceUnitBillingModels!.route!['irp-suggest']).toEqual({ version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.002 }] });
  });

  it('validates its configuration', () => {
    expect(() => plugin.createProvider({ ANTSEED_ALLOWED_SERVICES: 'route' })).toThrow('IRP_ROUTER_BASE_URL');
    expect(() => plugin.createProvider({ ...config, IRP_ROUTER_BASE_URL: 'ftp://router' })).toThrow('http(s)');
    expect(() => plugin.createProvider({ ...config, ANTSEED_ALLOWED_SERVICES: 'a,b' })).toThrow('exactly one');
    expect(() => plugin.createProvider({ ...config, IRP_ROUTER_PRICE_USD: '-1' })).toThrow('non-negative');
  });
});
