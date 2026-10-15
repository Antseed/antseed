import { describe, expect, it, vi } from 'vitest';
import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import { MockOpenAIChatProvider } from './helpers/mock-openai-provider.js';
import { usePaymentNetwork } from './helpers/payment-network.js';
import defaultRouterPlugin from '../../plugins/provider-default-router/src/index.js';

describe('model-routing payment flow over buyer proxy', () => {
  const network = usePaymentNetwork('routing');
  const { setupRpc, setupProxyNetwork } = network;

  it('bills a model-routing rank as one completed request through the same payment flow', async () => {
    await setupRpc();
    let rankCalls = 0;
    const routing: Provider = {
      name: 'alpha',
      services: ['alpha-route'],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: { 'alpha-route': ['model-routing'] },
      serviceUnitBillingModels: { 'alpha-route': { 'model-routing': {
        version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }],
      } } },
      maxConcurrency: 5,
      getCapacity: () => ({ current: 0, max: 5 }),
      async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
        rankCalls++;
        const { routing: { candidates }, request } = JSON.parse(Buffer.from(req.body).toString());
        if (request.messages[0].content === 'bad') {
          return { requestId: req.requestId, statusCode: 200, headers: {}, body: Buffer.from('not a ranking') };
        }
        return { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ id: 'rank-1', object: 'routing.ranking', created: 1, router: { id: 'alpha', version: '1' },
            ranked: [{ candidate_id: candidates[0].id }] })) };
      },
    };
    const { discoveredSeller } = await setupProxyNetwork(routing);

    const rank = (text = 'hi') => network.buyerNode!.sendRequest(discoveredSeller, {
      requestId: crypto.randomUUID(), method: 'POST', path: '/v1/routing/rank',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ request: { messages: [{ role: 'user', content: text }] },
        routing: { candidates: [{ id: 'm@b', model: 'm', pricing: { input: 1, cache_read: 1, output: 1 } }] } })),
    });

    // First call negotiates (402 -> reserve -> retry). A malformed answer costs nothing on
    // either side, so it cannot leave the seller waiting for a payment that never comes.
    expect((await rank()).statusCode).toBe(200);
    expect((await rank('bad')).statusCode).toBe(200);
    expect((await rank()).statusCode).toBe(200);
    expect(rankCalls).toBe(3);
    const bpm = network.buyerNode!.buyerPaymentManager!;
    await vi.waitFor(() => expect(bpm.getCumulativeAmount(discoveredSeller.peerId)).toBe(2_000n));
    expect(bpm.getVerifiedCost(discoveredSeller.peerId)).toBe(2_000n);
  }, 30_000);

  it('serves default-router rankings without opening a payment channel', async () => {
    await setupRpc();
    const defaultRouter = defaultRouterPlugin.createProvider({ DEFAULT_ROUTER_SCORES_URL: '' }) as Provider;
    const { discoveredSeller } = await setupProxyNetwork(defaultRouter);
    const paymentEvents: string[] = [];
    network.buyerNode!.on('payment:required', () => paymentEvents.push('required'));
    network.buyerNode!.on('payment:signed', () => paymentEvents.push('signed'));

    const response = await network.buyerNode!.sendRequest(discoveredSeller, {
      requestId: crypto.randomUUID(), method: 'POST', path: '/v1/routing/rank',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ request: { messages: [{ role: 'user', content: 'hi' }] },
        routing: { candidates: [
          { id: 'paid@a', model: 'gpt-5.5', pricing: { input: 1, cache_read: 1, output: 1 } },
          { id: 'free@b', model: 'glm-4.7-flash', pricing: { input: 0, cache_read: 0, output: 0 } },
        ] } })),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(Buffer.from(response.body).toString()).ranked).toEqual([{ candidate_id: 'free@b', expected_cost_usd: 0 }]);
    expect(paymentEvents).toEqual([]);
    expect(network.rpcCallLog.some((call) => call.method === 'eth_sendRawTransaction')).toBe(false);
    expect(network.buyerNode!.buyerPaymentManager?.getVerifiedCost(discoveredSeller.peerId)).toBe(0n);
  }, 30_000);

  it('routes a buyer-proxy chat through the default router to a free model it never listed, sending only free candidates', async () => {
    await setupRpc();
    const defaultRouter = defaultRouterPlugin.createProvider({ DEFAULT_ROUTER_SCORES_URL: '' }) as Provider;
    const paidChat = new MockOpenAIChatProvider();
    const freeBackend = new MockOpenAIChatProvider();
    const freeChat: Provider = {
      name: 'free-chat',
      services: ['unlisted-free-model-7b'],
      serviceApiProtocols: { 'unlisted-free-model-7b': ['openai-chat-completions'] },
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      maxConcurrency: 5,
      getCapacity: () => ({ current: 0, max: 5 }),
      handleRequest: (req) => freeBackend.handleRequest(req),
    };
    const rankedModels: string[][] = [];
    const routeRequest = defaultRouter.handleRequest.bind(defaultRouter);
    defaultRouter.handleRequest = async (req) => {
      if (req.method === 'POST') rankedModels.push(JSON.parse(Buffer.from(req.body).toString()).routing.candidates.map((candidate: { model: string }) => candidate.model));
      return routeRequest(req);
    };
    const { port, discoveredSeller } = await setupProxyNetwork(defaultRouter, [paidChat, freeChat]);
    const base = `http://127.0.0.1:${port}`;

    const routerModels = await network.buyerNode!.sendRequest(discoveredSeller, {
      requestId: crypto.randomUUID(), method: 'GET', path: '/v1/routing/models', headers: {}, body: new Uint8Array(),
    });
    expect(JSON.parse(Buffer.from(routerModels.body).toString()).data)
      .toEqual([{ id: '*', object: 'model', max_pricing: { input: 0, cache_read: 0, output: 0 } }]);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: `${discoveredSeller.peerId}@default-router`, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as any).choices[0].message.content).toBe('Hello from OpenAI mock!');
    expect(rankedModels).toEqual([['unlisted-free-model-7b']]);
    expect(freeBackend.requestCount).toBe(1);
    expect(paidChat.requestCount).toBe(0);
    expect(JSON.parse(Buffer.from(freeBackend.lastRequest!.body).toString()).model).toBe('unlisted-free-model-7b');
    expect(network.rpcCallLog.some((call) => call.method === 'eth_sendRawTransaction')).toBe(false);
  }, 60_000);
});
