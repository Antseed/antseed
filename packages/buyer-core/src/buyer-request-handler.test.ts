import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler, stripPeerControlledResponseHeaders } from './buyer-request-handler.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';
import type { BuyerPeerView, ResponseAuthContext, StoredResponseAuth } from './interfaces.js';
import { hashRequest } from './response-auth.js';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from '@antseed/protocol/messages';
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
  code: 'one_off_channel_required',
  minBudgetPerRequest: '10000',
  suggestedAmount: '1000000',
  oneOffPlan: {
    openingReserveAmount: '1000000',
    requiredCumulativeAmount: '650000',
    requestCost: '4200000',
  },
});
const ACCEPTED = response(200, { queue_id: 'new-job' });

function makeHandler(responses: SerializedHttpResponse[], freeTierDelegationsHeader?: () => string | null) {
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
    bpm: { clearRequestBilling: vi.fn(), markRequestCovered: vi.fn(), releaseRequestCoverage: vi.fn() },
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
    getMux: () => ({ sendProxyRequest, cancelProxyRequest: vi.fn(), activeRequestCount: () => 2 } as never),
    getVerificationMux: () => ({ waitForResponseAuth: vi.fn(() => new Promise(() => {})) } as never),
    registerPaymentMux: vi.fn(),
    ...(freeTierDelegationsHeader ? { freeTierDelegationsHeader } : {}),
  });
  return { handler, handle402, sendProxyRequest, negotiator };
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

  const catchUp = (required: string, accepted: string) => response(402, {
    error: 'payment_required',
    minBudgetPerRequest: '10000',
    suggestedAmount: '1000000',
    requiredCumulativeAmount: required,
    currentAcceptedCumulative: accepted,
    reserveMaxAmount: '1000000',
  });

  it('keeps catching up while the seller catch-up gap shrinks', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([
      catchUp('500000', '100000'), catchUp('500000', '400000'), ACCEPTED,
    ]);

    expect((await handler.sendRequest(makePeer(), makeRequest())).statusCode).toBe(200);
    expect(handle402).toHaveBeenCalledTimes(2);
    // Counts the in-flight requests to the seller, including this one.
    expect(handle402).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), 3, undefined);
    expect(sendProxyRequest).toHaveBeenCalledTimes(3);
  });

  it('returns a buyer error instead of the seller 402 when catch-up stays short', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([
      catchUp('500000', '100000'), catchUp('500000', '300000'), catchUp('500000', '450000'),
    ]);

    const result = await handler.sendRequest(makePeer(), makeRequest());
    expect(result.statusCode).toBe(409);
    const body = Buffer.from(result.body).toString();
    expect(JSON.parse(body)).toMatchObject({ error: { type: 'payment_negotiation_failed' } });
    expect(body).not.toContain('requiredCumulativeAmount');
    expect(handle402).toHaveBeenCalledTimes(2);
    expect(sendProxyRequest).toHaveBeenCalledTimes(3);
  });

  it('returns the buyer error without repeating a catch-up whose gap did not shrink', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([
      catchUp('500000', '100000'), catchUp('600000', '100000'),
    ]);

    const result = await handler.sendRequest(makePeer(), makeRequest());
    expect(result.statusCode).toBe(409);
    expect(Buffer.from(result.body).toString()).not.toContain('requiredCumulativeAmount');
    expect(handle402).toHaveBeenCalledOnce();
    expect(sendProxyRequest).toHaveBeenCalledTimes(2);
  });

  it('does not negotiate for a client-provided spending authorization', async () => {
    const { handler, handle402 } = makeHandler([PAYMENT_REQUIRED]);

    expect((await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-spending-auth': 'client-signed' }))).statusCode).toBe(402);
    expect(handle402).not.toHaveBeenCalled();
  });
});

describe('BuyerRequestHandler free allowance on a priced service', () => {
  const chatPeer = (): BuyerPeerView => ({
    peerId: toPeerId('5'.repeat(40)),
    providers: ['openai'],
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
  } as BuyerPeerView);
  const chatRequest = (): SerializedHttpRequest => ({
    requestId: 'chat-request',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model: 'k3', messages: [] })),
  });

  it('expects no charge for a response the seller covered from the allowance', async () => {
    const covered = { ...response(200, { ok: true }), headers: { 'content-type': 'application/json', 'X-Antseed-Free-Tier': 'covered' } };
    const { handler, negotiator } = makeHandler([covered]);
    expect((await handler.sendRequest(chatPeer(), chatRequest())).statusCode).toBe(200);
    expect(negotiator.estimateCostFromResponse).not.toHaveBeenCalled();
    expect(negotiator.bpm.releaseRequestCoverage).toHaveBeenCalledWith(chatPeer().peerId, 'chat-request');
    expect(negotiator.bpm.releaseRequestCoverage.mock.invocationCallOrder[0])
      .toBeLessThan(negotiator.bpm.markRequestCovered.mock.invocationCallOrder[0]!);
    expect(negotiator.bpm.markRequestCovered).toHaveBeenCalledWith(chatPeer().peerId, 'chat-request');
  });

  it('expects the listed price for any other paid response', async () => {
    const { handler, negotiator } = makeHandler([response(200, { ok: true })]);
    await handler.sendRequest(chatPeer(), chatRequest());
    expect(negotiator.estimateCostFromResponse).toHaveBeenCalledOnce();
  });
});

describe('BuyerRequestHandler free-tier delegations', () => {
  it('sends the node’s own delegations and drops any copy a client set', async () => {
    const { handler, sendProxyRequest } = makeHandler([ACCEPTED], () => 'node-delegations');
    await handler.sendRequest(makePeer(), makeRequest({ 'X-Antseed-Free-Tier-Delegations': 'client-copy' }));
    const sent = sendProxyRequest.mock.calls[0]![0].headers;
    expect(Object.entries(sent).filter(([name]) => name.toLowerCase() === 'x-antseed-free-tier-delegations'))
      .toEqual([['x-antseed-free-tier-delegations', 'node-delegations']]);
  });

  it('sends no delegations header when the node has none', async () => {
    const { handler, sendProxyRequest } = makeHandler([ACCEPTED], () => null);
    await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-free-tier-delegations': 'client-copy' }));
    expect(Object.keys(sendProxyRequest.mock.calls[0]![0].headers)).not.toContain('x-antseed-free-tier-delegations');
  });
});

describe('BuyerRequestHandler response receipts', () => {
  it('attributes a receipt to the peer the request went to, not the peer the receipt names', async () => {
    const request = makeRequest();
    const other = toPeerId('6'.repeat(40));
    const receipt = {
      version: 1 as const,
      requestId: request.requestId,
      buyerPeerId: '4'.repeat(40),
      sellerPeerId: other,
      advertisedService: 'other-model',
      provider: 'venice',
      statusCode: 200,
      requestHash: hashRequest(request),
      responseHash: 'f'.repeat(64),
      responseStartedAt: 1,
      responseCompletedAt: 2,
      signature: '00',
    };
    const inserted: Array<{ record: StoredResponseAuth; context?: ResponseAuthContext }> = [];
    const connection = { state: ConnectionState.Connected, send: vi.fn(), on: vi.fn(), off: vi.fn() };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: toPeerId('4'.repeat(40)),
      negotiator: { getOrCreatePaymentMux: vi.fn(() => ({})), trackRequestBillingContext: vi.fn(), estimateCostFromResponse: vi.fn() } as never,
      verificationStorage: { insertResponseAuth: (record, context) => { inserted.push({ record, context }); } },
      verificationSampler: null,
      getConnection: async () => connection as never,
      getMux: () => ({
        sendProxyRequest: (_req: SerializedHttpRequest, onResponse: (value: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void) =>
          onResponse(ACCEPTED, { streamingStart: false }),
        cancelProxyRequest: vi.fn(),
      } as never),
      getVerificationMux: () => ({ waitForResponseAuth: vi.fn(async () => receipt) } as never),
      registerPaymentMux: vi.fn(),
    });

    const peer = { ...makePeer(), capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1] };
    await handler.sendRequest(peer, request);
    await vi.waitFor(() => expect(inserted).toHaveLength(1));

    expect(inserted[0]!.record.verified).toBe(false);
    expect(inserted[0]!.record.verificationError).toBe('response_hash_mismatch');
    // The stored receipt keeps what the seller claimed; the context says who actually answered.
    expect(inserted[0]!.record.sellerPeerId).toBe(other);
    expect(inserted[0]!.context).toEqual({ sellerPeerId: peer.peerId, requestedService: 'video-model' });
  });
});

describe('stripPeerControlledResponseHeaders', () => {
  it('drops a seller copy of every buyer-only header, in any letter case', () => {
    const response = {
      requestId: 'r',
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'X-Antseed-Video-Price-Usdc': '1', 'x-antseed-video-job-retired': '1', 'X-Antseed-Video-Delivered': '1', 'X-AntSeed-Fault-Attribution': 'buyer' },
      body: new Uint8Array(),
    };
    expect(stripPeerControlledResponseHeaders(response).headers).toEqual({ 'content-type': 'application/json' });
  });
});
