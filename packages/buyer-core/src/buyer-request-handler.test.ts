import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from './buyer-request-handler.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';
import { PAYMENT_CODE_VIDEO_RESERVE_REQUIRED } from '@antseed/protocol/messages';
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

function jsonResponse(statusCode: number, body: unknown, headers: Record<string, string> = {}): SerializedHttpResponse {
  return {
    requestId: 'video-request',
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(body)),
  };
}

const RESERVE_REQUIRED = jsonResponse(402, {
  error: 'payment_required',
  code: PAYMENT_CODE_VIDEO_RESERVE_REQUIRED,
  estimatedRequestCost: '4200000',
  remainingLockedReserve: '900000',
});
const ACCEPTED = jsonResponse(200, { queue_id: 'new-job' });

function makeHandler(responses: SerializedHttpResponse[]) {
  const queue = [...responses];
  const order: string[] = [];
  const ensureVideoHeadroom = vi.fn(async () => { order.push('headroom'); });
  const sendProxyRequest = vi.fn((
    _request: SerializedHttpRequest,
    onResponse: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
  ) => {
    order.push('send');
    onResponse(queue.length > 1 ? queue.shift()! : queue[0]!, { streamingStart: false });
  });
  const conn = {
    state: ConnectionState.Connected,
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  const negotiator = {
    getOrCreatePaymentMux: vi.fn(() => ({})),
    trackRequestBillingContext: vi.fn(),
    ensureVideoHeadroom,
    estimateCostFromResponse: vi.fn(),
    handle402: vi.fn(async () => ({ action: 'retry' as const })),
    applyExternalSpendingAuth: vi.fn(async () => {}),
  };
  const handler = new BuyerRequestHandler({}, {
    localPeerId: toPeerId('4'.repeat(40)),
    negotiator: negotiator as any,
    verificationStorage: null,
    verificationSampler: null,
    getConnection: async () => conn as any,
    getMux: () => ({ sendProxyRequest, cancelProxyRequest: vi.fn() } as any),
    getVerificationMux: () => ({
      waitForResponseAuth: vi.fn(() => new Promise(() => {})),
    } as any),
    registerPaymentMux: vi.fn(),
  });
  return { handler, negotiator, ensureVideoHeadroom, sendProxyRequest, order };
}

describe('BuyerRequestHandler native video payment preparation', () => {
  it('does not top up for an idempotent replay of an existing job', async () => {
    const { handler, ensureVideoHeadroom, sendProxyRequest } = makeHandler([
      jsonResponse(200, { queue_id: 'existing-job' }, { 'x-antseed-idempotent-replay': 'true' }),
    ]);

    const response = await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-idempotency-key': 'retry-key' }));

    expect(response.statusCode).toBe(200);
    expect(ensureVideoHeadroom).not.toHaveBeenCalled();
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it.each([400, 409, 500, 503])('does not top up for a create the seller answers with %s', async (statusCode) => {
    const { handler, ensureVideoHeadroom, sendProxyRequest } = makeHandler([
      jsonResponse(statusCode, { error: { code: 'unsupported_video_options' } }),
    ]);

    const response = await handler.sendRequest(makePeer(), makeRequest());

    expect(response.statusCode).toBe(statusCode);
    expect(ensureVideoHeadroom).not.toHaveBeenCalled();
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it('does not top up for a create that already fits the locked reserve', async () => {
    const { handler, ensureVideoHeadroom, sendProxyRequest } = makeHandler([ACCEPTED]);

    const response = await handler.sendRequest(makePeer(), makeRequest());

    expect(response.statusCode).toBe(200);
    expect(ensureVideoHeadroom).not.toHaveBeenCalled();
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it('tops up only after the seller asks for a larger video reserve, then resends the same create', async () => {
    const { handler, negotiator, order, sendProxyRequest } = makeHandler([RESERVE_REQUIRED, ACCEPTED]);

    const response = await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-idempotency-key': 'key-1' }));

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['send', 'headroom', 'send']);
    expect(negotiator.handle402).not.toHaveBeenCalled();
    const [first, second] = sendProxyRequest.mock.calls.map(([request]) => request as SerializedHttpRequest);
    expect(second!.headers['x-antseed-idempotency-key']).toBe('key-1');
    expect(Buffer.from(second!.body).toString()).toBe(Buffer.from(first!.body).toString());
  });

  it('opens the channel first, then tops up when the retried create still needs a larger reserve', async () => {
    const { handler, negotiator, order } = makeHandler([
      jsonResponse(402, { error: 'payment_required', minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
      RESERVE_REQUIRED,
      ACCEPTED,
    ]);

    const response = await handler.sendRequest(makePeer(), makeRequest());

    expect(response.statusCode).toBe(200);
    expect(negotiator.handle402).toHaveBeenCalledOnce();
    expect(order).toEqual(['send', 'send', 'headroom', 'send']);
  });

  it('does not top up for a replay returned after the channel was opened', async () => {
    const { handler, ensureVideoHeadroom } = makeHandler([
      jsonResponse(402, { error: 'payment_required', minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
      jsonResponse(200, { queue_id: 'existing-job' }, { 'x-antseed-idempotent-replay': 'true' }),
    ]);

    const response = await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-idempotency-key': 'retry-key' }));

    expect(response.statusCode).toBe(200);
    expect(ensureVideoHeadroom).not.toHaveBeenCalled();
  });

  it('tops up at most once per create and surfaces a repeated reserve demand', async () => {
    const { handler, ensureVideoHeadroom, sendProxyRequest } = makeHandler([RESERVE_REQUIRED]);

    const response = await handler.sendRequest(makePeer(), makeRequest());

    expect(response.statusCode).toBe(402);
    expect(ensureVideoHeadroom).toHaveBeenCalledOnce();
    expect(sendProxyRequest).toHaveBeenCalledTimes(2);
  });

  it('does not resend the create when the top-up fails', async () => {
    const { handler, ensureVideoHeadroom, sendProxyRequest } = makeHandler([RESERVE_REQUIRED, ACCEPTED]);
    ensureVideoHeadroom.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'buyer-reserve-topup-timeout' }));

    await expect(handler.sendRequest(makePeer(), makeRequest())).rejects.toMatchObject({ code: 'buyer-reserve-topup-timeout' });
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it('never tops up for a client that brings its own spending auth', async () => {
    const { handler, ensureVideoHeadroom, negotiator } = makeHandler([RESERVE_REQUIRED]);

    const response = await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-spending-auth': 'client-signed' }));

    expect(response.statusCode).toBe(402);
    expect(ensureVideoHeadroom).not.toHaveBeenCalled();
    expect(negotiator.handle402).not.toHaveBeenCalled();
  });
});
