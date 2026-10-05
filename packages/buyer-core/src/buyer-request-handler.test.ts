import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from './buyer-request-handler.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';
import type { BuyerPeerView } from './interfaces.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';

const VIDEO_MODEL = {
  version: 1 as const,
  components: [{ unit: 'video_generations' as const, priceUsd: 4.2 }],
};

function makePeer(): BuyerPeerView {
  return {
    peerId: toPeerId('5'.repeat(40)),
    providers: ['venice'],
    providerServiceApiProtocols: { venice: { services: { 'video-model': ['venice-video'] } } },
    providerServiceUnitBillingModels: { venice: { services: { 'video-model': { 'venice-video': VIDEO_MODEL } } } },
  };
}

function makeRequest(headers: Record<string, string> = {}): SerializedHttpRequest {
  return {
    requestId: 'video-request',
    method: 'POST',
    path: '/api/v1/video/queue',
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify({ model: 'video-model', prompt: 'cat', duration: '5s' })),
  };
}

function response(statusCode: number, body: unknown): SerializedHttpResponse {
  return {
    requestId: 'video-request',
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  };
}

const PAYMENT_REQUIRED = response(402, {
  error: 'payment_required',
  minBudgetPerRequest: '10000',
  suggestedAmount: '1000000',
  reservePlan: {
    currentReserveAmount: '1000000',
    requiredCumulativeAmount: '650000',
    finalReserveAmount: '4200000',
    requestCost: '4200000',
  },
});
const ACCEPTED = response(200, { queue_id: 'new-job' });

function makeHandler(responses: SerializedHttpResponse[]) {
  const queue = [...responses];
  const sendProxyRequest = vi.fn((
    _request: SerializedHttpRequest,
    onResponse: (value: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
  ) => onResponse(queue.shift() ?? responses.at(-1)!, { streamingStart: false }));
  const handle402 = vi.fn(async () => ({ action: 'retry' as const }));
  const negotiator = {
    getOrCreatePaymentMux: vi.fn(() => ({})),
    trackRequestBillingContext: vi.fn(),
    estimateCostFromResponse: vi.fn(),
    handle402,
    applyExternalSpendingAuth: vi.fn(async () => {}),
  };
  const connection = { state: ConnectionState.Connected, send: vi.fn(), on: vi.fn(), off: vi.fn() };
  const handler = new BuyerRequestHandler({}, {
    localPeerId: toPeerId('4'.repeat(40)),
    negotiator: negotiator as never,
    verificationStorage: null,
    verificationSampler: null,
    getConnection: async () => connection as never,
    getMux: () => ({ sendProxyRequest, cancelProxyRequest: vi.fn() } as never),
    getVerificationMux: () => ({ waitForResponseAuth: vi.fn(() => new Promise(() => {})) } as never),
    registerPaymentMux: vi.fn(),
  });
  return { handler, handle402, sendProxyRequest };
}

describe('BuyerRequestHandler payment negotiation', () => {
  it.each([400, 409, 500, 503])('returns a non-payment response without negotiation (%s)', async (statusCode) => {
    const { handler, handle402, sendProxyRequest } = makeHandler([response(statusCode, { error: 'rejected' })]);

    expect((await handler.sendRequest(makePeer(), makeRequest())).statusCode).toBe(statusCode);
    expect(handle402).not.toHaveBeenCalled();
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it('handles one payment-required response and retries the request once', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([PAYMENT_REQUIRED, ACCEPTED]);

    expect((await handler.sendRequest(makePeer(), makeRequest())).statusCode).toBe(200);
    expect(handle402).toHaveBeenCalledOnce();
    expect(sendProxyRequest).toHaveBeenCalledTimes(2);
  });

  it('surfaces a repeated payment requirement after the single retry', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([PAYMENT_REQUIRED, PAYMENT_REQUIRED]);

    expect((await handler.sendRequest(makePeer(), makeRequest())).statusCode).toBe(402);
    expect(handle402).toHaveBeenCalledOnce();
    expect(sendProxyRequest).toHaveBeenCalledTimes(2);
  });

  it('does not negotiate for a client-provided spending authorization', async () => {
    const { handler, handle402 } = makeHandler([PAYMENT_REQUIRED]);

    expect((await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-spending-auth': 'client-signed' }))).statusCode).toBe(402);
    expect(handle402).not.toHaveBeenCalled();
  });
});
