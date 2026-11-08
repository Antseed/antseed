import { describe, expect, it } from 'vitest';
import { announcedProviderId } from '../src/discovery/provider-id.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../src/types/http.js';

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function controlProvider(name: string): Provider {
  return {
    name,
    services: ['qwen'],
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 1,
    getCapacity: () => ({ current: 0, max: 1 }),
    handleRequest: async (req: SerializedHttpRequest) => ({ requestId: req.requestId, statusCode: 200, headers: {}, body: new Uint8Array() }),
    handleControlRequest: async (req: SerializedHttpRequest) => ({ requestId: req.requestId, statusCode: 200, headers: {}, body: enc({ pool: name }) }),
  } as unknown as Provider;
}

function assignRequest(provider?: string): SerializedHttpRequest {
  return {
    requestId: 'assign-1',
    method: 'POST',
    path: '/_antseed/provider/colony-pool/assign',
    headers: { 'content-type': 'application/json', ...(provider ? { 'x-antseed-provider': provider } : {}) },
    body: enc({ model: 'qwen' }),
  };
}

const identity = { privateKey: new Uint8Array(32).fill(7) };

describe('provider control routes', () => {
  const handler = new SellerRequestHandler({
    identity,
    announceProviderIds: true,
    providers: [controlProvider('pool-a'), controlProvider('pool-b')],
    sellerPaymentManager: null,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit: () => true,
  } as never);
  const control = (request: SerializedHttpRequest) =>
    (handler as unknown as { _handleProviderControl(r: SerializedHttpRequest, buyer: string): Promise<{ statusCode: number; body: Uint8Array }> })
      ._handleProviderControl(request, 'b'.repeat(40));
  const pool = async (request: SerializedHttpRequest) => JSON.parse(new TextDecoder().decode((await control(request)).body)).pool;

  it('go to the provider the buyer routes the service to', async () => {
    expect(await pool(assignRequest('pool-b'))).toBe('pool-b');
    expect(await pool(assignRequest('POOL-A'))).toBe('pool-a');
  });

  it('go to the provider named by the ID the seller announces for it', async () => {
    expect(await pool(assignRequest(announcedProviderId(identity.privateKey, 'pool-b')))).toBe('pool-b');
  });

  it('go to the first provider offering the service when none is named', async () => {
    expect(await pool(assignRequest())).toBe('pool-a');
  });

  it('are refused for a named provider without control routes for the service', async () => {
    expect((await control(assignRequest('openai'))).statusCode).toBe(404);
  });
});
