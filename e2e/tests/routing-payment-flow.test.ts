import { describe, expect, it, vi } from 'vitest';
import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
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
    const defaultRouter = defaultRouterPlugin.createProvider({ DEFAULT_ROUTER_STATS_URL: '', DEFAULT_ROUTER_SCORES_URL: '' }) as Provider;
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
});
