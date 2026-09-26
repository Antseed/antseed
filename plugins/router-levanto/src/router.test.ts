import { describe, expect, it, vi } from 'vitest';
import type { PeerInfo, RouteRecommendation, RoutingCatalogV1, RoutingPreferenceSchema, RouteSelectionContext, SerializedHttpRequest } from '@antseed/node';
import { completedRequestPrice } from '@antseed/node';
import { LevantoRoutingAdapter } from './router.js';

const emptySchema: RoutingPreferenceSchema = { type: 'object', properties: {}, additionalProperties: false };
function createRoutingCatalog(models: RoutingCatalogV1['models'], preferencesSchema = emptySchema, options: { title?: string } = {}): RoutingCatalogV1 {
  const content = { version: 1 as const, preferencesSchema, ...options, models };
  return { ...content, revision: `rev-${JSON.stringify(content).length}-${models.length}` };
}

const sellerId = 'a'.repeat(40);
const inferenceId = 'b'.repeat(40);
const offer = { provider: 'levanto', service: 'levanto-route', serviceApiProtocol: 'levanto-routing' as const, unitModel: { version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd: 0.001 }] } };
function providers(priceMicroUsdc = '1000'): NonNullable<PeerInfo['metadata']>['providers'] {
  return [{ provider: offer.provider, services: [offer.service], defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, maxConcurrency: 1, currentLoad: 0,
    serviceApiProtocols: { [offer.service]: [offer.serviceApiProtocol] },
    serviceUnitBillingModels: { [offer.service]: { [offer.serviceApiProtocol]: { version: 1, components: [{ unit: 'completed_requests', priceUsd: Number(priceMicroUsdc) / 1_000_000 }] } } },
  }];
}
const peer = { peerId: sellerId, metadata: { version: 12, peerId: sellerId, providers: providers() } } as PeerInfo;
const recommendation: RouteRecommendation = { serviceId: 'model-a', peerId: inferenceId, provider: 'openai' };
const result = {
  v: 1, router: 'levanto', ranked: [{ model: 'model-a', peer: inferenceId, provider: 'openai',
    estimate: { costUsd: 0.1, inputTokens: 4, cachedInputTokens: 0, outputTokens: 10 },
    price: { inUsdPerM: 1, outUsdPerM: 2, cachedInUsdPerM: 0 } }],
};

function request(text = 'Help me', model = 'levanto-auto'): SerializedHttpRequest {
  return { requestId: 'inference', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model, messages: [{ role: 'user', content: text }], stream: true })) };
}

function setup() {
  const accepted = vi.fn(() => true);
  const sendRequest = vi.fn<RouteSelectionContext['sendRequest']>(async (_peer, request, options) => {
    const payload = JSON.parse(new TextDecoder().decode(request.body));
    const response = { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ ...result, catalogRevision: payload.catalogRevision })) };
    if (!options.acceptResponse?.(response)) throw new Error('Not accepted');
    return response;
  });
  const context: RouteSelectionContext = {
    routingService: { peerId: sellerId, provider: 'levanto', serviceId: 'levanto-route' },
    signal: new AbortController().signal, conversationKey: 'chat-1',
    candidates: [{ ...recommendation, peerId: inferenceId, provider: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }],
    acceptRecommendations: accepted, sendRequest,
  };
  return { adapter: new LevantoRoutingAdapter(), context, accepted, sendRequest };
}

describe('Levanto buyer adapter', () => {
  it('invalidates a same-turn cached recommendation when the catalog or exact candidates change', async () => {
    const state = setup();
    state.context.catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }]);
    await state.adapter.selectRoute(request(), [peer], state.context);
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(1);
    state.context.catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }, { provider: 'openai', serviceId: 'model-b' }]);
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
    state.context.candidates.push({ ...state.context.candidates[0]!, serviceId: 'model-b' });
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(3);
  });

  it('sends exact constraints in v1 even when no catalog is advertised', async () => {
    const state = setup();
    await state.adapter.selectRoute(request(), [peer], state.context);
    const payload = JSON.parse(new TextDecoder().decode(state.sendRequest.mock.calls[0]![1].body));
    expect(payload.v).toBe(1);
    expect(payload.constraints.allowedCandidates).toEqual([{ peerId: inferenceId, provider: 'openai', serviceId: 'model-a' }]);
    expect(payload.catalogRevision).toBeUndefined();
  });

  it('sends v1 exact allowed candidates and the plugin catalog revision', async () => {
    const state = setup();
    const catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }]);
    state.context.catalog = catalog;
    state.context.candidates = [...state.context.candidates, { ...state.context.candidates[0]!, provider: 'excluded' }];
    state.sendRequest.mockImplementation(async (_peer, request, options) => {
      const payload = JSON.parse(new TextDecoder().decode(request.body));
      expect(payload).toMatchObject({ v: 1, catalogRevision: catalog.revision,
        constraints: { allowedCandidates: [{ peerId: inferenceId, provider: 'openai', serviceId: 'model-a' }] } });
      const response = { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        ...result, catalogRevision: catalog.revision,
      })) };
      if (!options.acceptResponse?.(response)) throw new Error('Not accepted');
      return response;
    });
    expect(await state.adapter.selectRoute(request(), [peer], state.context)).toEqual([{ ...recommendation, provider: 'openai' }]);
    state.context.candidates = [{ ...state.context.candidates[0]!, serviceId: 'model-b' }];
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('No eligible');
    expect(state.sendRequest).toHaveBeenCalledTimes(1);
  });
  it('catalog errors and unsupported-only catalogs fail before purchasing a recommendation', async () => {
    const state = setup();
    state.context.catalog = createRoutingCatalog([]);
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('No eligible');
    state.context.catalog = { ...createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }]), revision: '' };
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('Invalid routing catalog');
    expect(state.sendRequest).not.toHaveBeenCalled();
  });
  it('fetches the catalog from the router HTTP API for the exact service', async () => {
    const catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }], undefined, { title: 'Auto Router' });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      return parsed.searchParams.get('service') === 'levanto-route' ? Response.json(catalog) : new Response('{}', { status: 404 });
    });
    const adapter = new LevantoRoutingAdapter({ routingPeerUrl: 'http://router.test:9000/', fetchImpl: fetchImpl as typeof fetch });
    const target = { peerId: sellerId, provider: 'levanto', serviceId: 'levanto-route' };
    expect(await adapter.getCatalog(target, [peer], AbortSignal.timeout(1000))).toEqual(catalog);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://router.test:9000/_antseed/route/catalog?provider=levanto&service=levanto-route');
    expect(await adapter.getCatalog({ ...target, serviceId: 'other' }, [peer], AbortSignal.timeout(1000))).toBeUndefined();
    fetchImpl.mockResolvedValueOnce(Response.json({ ...catalog, models: [{ provider: 'openai' }] }));
    await expect(adapter.getCatalog(target, [peer], AbortSignal.timeout(1000))).rejects.toThrow('Invalid routing catalog');
    fetchImpl.mockResolvedValueOnce(new Response('down', { status: 503 }));
    await expect(adapter.getCatalog(target, [peer], AbortSignal.timeout(1000))).rejects.toThrow('503');
  });
  it.each([undefined, '203.0.113.5:6882', '[2001:db8::1]:6882'])('does not derive a catalog URL from the announced address %s', async (publicAddress) => {
    const fetchImpl = vi.fn();
    const adapter = new LevantoRoutingAdapter({ fetchImpl: fetchImpl as typeof fetch });
    expect(await adapter.getCatalog({ peerId: sellerId, provider: 'levanto', serviceId: 'levanto-route' }, [{ ...peer, publicAddress }], AbortSignal.timeout(1000))).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['Help through Responses', [{ role: 'user', content: [{ type: 'input_text', text: 'Help through Responses' }] }]])('routes Responses input without altering the downstream request', async (input) => {
    const state = setup();
    const responseRequest = { ...request(), path: '/v1/responses', body: new TextEncoder().encode(JSON.stringify({ model: 'antseed', input })) };
    const before = structuredClone(responseRequest);
    expect(await state.adapter.selectRoute(responseRequest, [peer], state.context)).toEqual([recommendation]);
    expect(JSON.parse(new TextDecoder().decode(state.sendRequest.mock.calls[0]![1].body)).inputMessage).toBe('Help through Responses');
    expect(responseRequest).toEqual(before);
  });
  it('translates Levanto rankings and requires host acceptance before payment', async () => {
    const state = setup();
    expect(await state.adapter.selectRoute(request(), [peer], state.context)).toEqual([recommendation]);
    expect(state.accepted).toHaveBeenCalledWith([recommendation]);
    const [, serviceRequest, options] = state.sendRequest.mock.calls[0]!;
    expect(serviceRequest.path).toBe('/_antseed/levanto-route');
    expect(serviceRequest.requestId).not.toBe('inference');
    expect(options.unitBilling).toEqual(offer);
    expect(options.maxFeeMicroUsdc).toBe('1000');
    expect(JSON.parse(new TextDecoder().decode(serviceRequest.body))).toMatchObject({
      v: 1, preferences: {}, inputMessage: 'Help me', service: 'levanto-route', constraints: { allowedPeerIds: [inferenceId] },
    });
  });

  it('declines concrete models and rejects missing user text before a paid request', async () => {
    const state = setup();
    expect(await state.adapter.selectRoute(request('Help', 'model-a'), [peer], state.context)).toBeNull();
    await expect(state.adapter.selectRoute(request(''), [peer], state.context)).rejects.toThrow('user text');
    expect(state.sendRequest).not.toHaveBeenCalled();
  });

  it('rejects malformed successful responses before accepting recommendations', async () => {
    const state = setup();
    state.sendRequest.mockImplementation(async (_peer, serviceRequest, options) => {
      const response = { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode('{}') };
      options.acceptResponse!(response);
      return response;
    });
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('Invalid Levanto routing response');
    expect(state.accepted).not.toHaveBeenCalled();
  });

  it('reuses unchanged text, reroutes changed text, and does not cache unidentified conversations', async () => {
    const state = setup();
    await state.adapter.selectRoute(request(), [peer], state.context);
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(1);
    await state.adapter.selectRoute(request('New turn'), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
    state.context.conversationKey = null;
    await state.adapter.selectRoute(request(), [peer], state.context);
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(4);
  });

  it('revalidates cached routes and rejects ineligible paid recommendations', async () => {
    const state = setup();
    await state.adapter.selectRoute(request(), [peer], state.context);
    state.accepted.mockReturnValue(false);
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('Not accepted');
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('requires an advertised billing offer and respects cancellation', async () => {
    const state = setup();
    await expect(state.adapter.selectRoute(request(), [{ ...peer, metadata: undefined }], state.context)).rejects.toThrow('compatible');
    state.context.signal = AbortSignal.abort();
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow();
    expect(state.sendRequest).not.toHaveBeenCalled();
  });

  it('uses the selected advertised price without a separate fee setting', async () => {
    const state = setup();
    expect(await state.adapter.selectRoute(request('Hello', 'model-a'), [peer], state.context)).toBeNull();
    expect(state.sendRequest).not.toHaveBeenCalled();
    for (const price of ['0', '2500']) {
      const pricedState = setup();
      const pricedPeer = { ...peer, metadata: { ...peer.metadata!, providers: providers(price) } };
      await pricedState.adapter.selectRoute(request(), [pricedPeer], pricedState.context);
      const options = pricedState.sendRequest.mock.calls.at(-1)![2];
      expect(completedRequestPrice(options.unitBilling!.unitModel).toString()).toBe(price);
      expect(options.maxFeeMicroUsdc).toBe(price);
    }
  });

  it('resolves the exact provider and service using the advertised protocol', async () => {
    const state = setup();
    const provider = { ...providers()[0]!, provider: 'custom-provider', services: ['custom-route'],
      serviceApiProtocols: { 'custom-route': ['levanto-routing' as const] },
      serviceUnitBillingModels: { 'custom-route': providers()[0]!.serviceUnitBillingModels!['levanto-route']! },
    };
    const customPeer = { ...peer, metadata: { ...peer.metadata!, providers: [provider] } };
    state.context.routingService = { peerId: sellerId, provider: provider.provider, serviceId: 'custom-route' };
    await state.adapter.selectRoute(request(), [customPeer], state.context);
    expect(state.sendRequest.mock.calls[0]![2].unitBilling).toMatchObject({ provider: provider.provider, service: 'custom-route' });
    expect(JSON.parse(new TextDecoder().decode(state.sendRequest.mock.calls[0]![1].body)).service).toBe('custom-route');
    state.context.routingService.serviceId = 'missing-route';
    await expect(state.adapter.selectRoute(request(), [customPeer], state.context)).rejects.toThrow('compatible');
    expect(state.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('uses live enum preferences and invalidates an unchanged-turn decision', async () => {
    const state = setup();
    const advertised = peer;
    state.context.catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }], {
      type: 'object', additionalProperties: false, properties: { strategy: { type: 'string', enum: ['balanced', 'fast'], default: 'balanced' } },
    });
    await state.adapter.selectRoute(request(), [advertised], state.context);
    state.context.preferences = { strategy: 'fast' };
    await state.adapter.selectRoute(request(), [advertised], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(new TextDecoder().decode(state.sendRequest.mock.calls[1]![1].body));
    expect(payload.preferences).toEqual({ strategy: 'fast' });
    expect(payload.cqt).toBeUndefined();
    state.context.preferences = { strategy: 'unknown' };
    await expect(state.adapter.selectRoute(request(), [advertised], state.context)).rejects.toThrow('enum');
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a changed schema before any routing call', async () => {
    const state = setup();
    state.context.preferencesSchemaHash = 'old';
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('schema changed');
    expect(state.sendRequest).not.toHaveBeenCalled();
  });

  it('does not replace the selected routing peer with a cheaper peer', async () => {
    const state = setup();
    const cheaper = { ...peer, peerId: 'c'.repeat(40), metadata: { ...peer.metadata!, providers: providers('0') } } as PeerInfo;
    await state.adapter.selectRoute(request(), [cheaper, peer], state.context);
    expect(state.sendRequest.mock.calls[0]![0].peerId).toBe(sellerId);
    await expect(state.adapter.selectRoute(request('Next turn'), [cheaper], state.context)).rejects.toThrow('compatible');
    state.context.routingService = undefined;
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('Select a Levanto');
  });

  it('filters mixed rankings by exact eligible model/peer without changing their order', async () => {
    const state = setup();
    state.context.candidates = [...state.context.candidates, { ...state.context.candidates[0]!, serviceId: 'model-b' }];
    state.sendRequest.mockImplementation(async (_peer, serviceRequest, options) => {
      const entry = result.ranked[0]!;
      const body = { ...result, ranked: [
        { ...entry, peer: 'c'.repeat(40) }, { ...entry, model: 'too-expensive', price: {} },
        { ...entry, model: 'model-b' }, { ...entry, inference: { reasoningEffort: 'unsupported' } }, entry,
      ] };
      const response = { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
      if (!options.acceptResponse?.(response)) throw new Error('Not accepted');
      return response;
    });
    expect(await state.adapter.selectRoute(request(), [peer], state.context)).toEqual([
      { serviceId: 'model-b', peerId: inferenceId, provider: 'openai' }, recommendation,
    ]);
  });

  it('sends observed cache estimates on a fresh decision, not another call for a tool continuation', async () => {
    const state = setup();
    await state.adapter.selectRoute(request(), [peer], state.context);
    state.adapter.observations.record({ conversationKey: 'chat-1', requestId: 'completed', peerId: inferenceId, provider: 'openai', serviceId: 'model-a', inputTokens: 100, cachedInputTokens: 80 });
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(1);
    await state.adapter.selectRoute(request('More details please'), [peer], state.context);
    const payload = JSON.parse(new TextDecoder().decode(state.sendRequest.mock.calls[1]![1].body));
    expect(payload.expectedCachedTokens).toEqual([{ model: 'model-a', peer: inferenceId, tokens: payload.promptTokens }]);
  });
});
