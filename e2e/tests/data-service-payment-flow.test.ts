import { describe, expect, it, vi } from 'vitest';
import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import { usePaymentNetwork } from './helpers/payment-network.js';

const DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Flights', version: '1.0.0' },
  paths: { '/search': { post: { summary: 'Search flights', responses: { '200': { description: 'ok' } } } } },
};

describe('data-service payment flow over buyer proxy', () => {
  const network = usePaymentNetwork('data-service');
  const { setupRpc, setupProxyNetwork } = network;

  it('reads the description free and bills each delivered operation as one completed request', async () => {
    await setupRpc();
    const operations: Array<{ path: string; body: string; headers: Record<string, string> }> = [];
    const json = (req: SerializedHttpRequest, statusCode: number, body: unknown): SerializedHttpResponse => ({
      requestId: req.requestId, statusCode, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)),
    });
    // A provider for one data service: the description, and one operation that refuses an unknown airport.
    const flights: Provider = {
      name: 'flights-api',
      services: ['flights'],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: { flights: ['openapi-data'] },
      serviceUnitBillingModels: { flights: { 'openapi-data': {
        version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.005 }],
      } } },
      maxConcurrency: 5,
      getCapacity: () => ({ current: 0, max: 5 }),
      async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
        // The seller sees the bare service in the path, whatever pin the buyer used.
        if (!req.path.startsWith('/v1/data/flights/')) return json(req, 404, { error: 'not found' });
        const operationPath = req.path.slice('/v1/data/flights'.length);
        if (req.method === 'GET' && operationPath === '/openapi.json') return json(req, 200, DOCUMENT);
        const body = Buffer.from(req.body).toString();
        operations.push({ path: operationPath, body, headers: req.headers });
        if (JSON.parse(body).from === 'XXX') return json(req, 400, { error: 'unknown airport' });
        return json(req, 200, { flights: [{ id: 'LY1' }] });
      },
    };
    const { port, discoveredSeller } = await setupProxyNetwork(flights);
    const base = `http://127.0.0.1:${port}/v1/data/${discoveredSeller.peerId}@flights`;
    const paymentEvents: string[] = [];
    network.buyerNode!.on('payment:required', () => paymentEvents.push('required'));
    network.buyerNode!.on('payment:signed', () => paymentEvents.push('signed'));

    // The description: free, with no payment step.
    const description = await fetch(`${base}/openapi.json`);
    expect(description.status, await description.clone().text()).toBe(200);
    expect(await description.json()).toEqual(DOCUMENT);
    expect(paymentEvents).toEqual([]);
    expect(network.buyerNode!.buyerPaymentManager?.getVerifiedCost(discoveredSeller.peerId) ?? 0n).toBe(0n);

    // The body is the operation's own; a `model` field in it names nothing on Antseed.
    const search = (from: string) => fetch(`${base}/search?limit=5`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: 'LIS', model: 'economy' }),
    });
    const bpm = network.buyerNode!.buyerPaymentManager!;
    const first = await search('TLV');
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ flights: [{ id: 'LY1' }] });
    // The buyer works out the charge itself, from the service named in the path.
    await vi.waitFor(() => expect(bpm.getVerifiedCost(discoveredSeller.peerId)).toBe(5_000n));
    // An error answer is free on both sides.
    expect((await search('XXX')).status).toBe(400);
    expect((await search('TLV')).status).toBe(200);

    await vi.waitFor(() => expect(bpm.getCumulativeAmount(discoveredSeller.peerId)).toBe(10_000n));
    expect(bpm.getVerifiedCost(discoveredSeller.peerId)).toBe(10_000n);

    // The seller receives the bare service in the path and the operation's body unchanged.
    expect(operations.map((entry) => entry.path)).toEqual(['/search?limit=5', '/search?limit=5', '/search?limit=5']);
    expect(JSON.parse(operations[0]!.body)).toEqual({ from: 'TLV', to: 'LIS', model: 'economy' });
  }, 60_000);
});
