import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler, stripPeerControlledResponseHeaders } from '../src/buyer-request-handler.js';
import { ConnectionState } from '../src/types/connection.js';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '../src/types/http.js';
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from '../src/types/http.js';
import type { PeerInfo } from '../src/types/peer.js';

describe('explicit completed-request buyer requests', () => {
  const offer = { provider: 'levanto', service: 'levanto-route', serviceApiProtocol: 'levanto-routing' as const, unitModel: { version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd: 0.001 }] } };
  const peer = { peerId: 'a'.repeat(40) } as PeerInfo;
  const request = {
    requestId: 'fixed', method: 'POST', path: '/_antseed/route',
    headers: { 'x-antseed-provider': offer.provider },
    body: new TextEncoder().encode(JSON.stringify({ service: offer.service, v: 1, cqt: 5, inputMessage: 'Help', promptTokens: 1, expectedCachedTokens: [], constraints: {} })),
  };
  const validResponse = { v: 1, router: 'levanto', ranked: [{ model: 'model-a', peer: 'b'.repeat(40), estimate: { costUsd: 0.01, inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 }, price: { inUsdPerM: 1, outUsdPerM: 2, cachedInUsdPerM: 0 } }] };
  function setup(responses = [{ statusCode: 200, body: validResponse as unknown }], enabled = true) {
    const bpm = { trackUnitRequest: vi.fn(), bindUnitRequestChannel: vi.fn(), observeUnitResponse: vi.fn(), authorizeUnitResponse: vi.fn(async () => {}) };
    const negotiator = { bpm, getOrCreatePaymentMux: vi.fn(() => ({})), negotiateUnitBillingPayment: vi.fn(async () => true), handle402: vi.fn(), estimateCostFromResponse: vi.fn(), trackRequestService: vi.fn(), trackRequestBillingContext: vi.fn() };
    const mux = { cancelProxyRequest: vi.fn(), sendProxyRequest: vi.fn((req, onResponse) => {
      const response = responses.shift()!;
      onResponse({ requestId: req.requestId, statusCode: response.statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(response.body)) }, { streamingStart: false });
    }) };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: 'b'.repeat(40), negotiator: enabled ? negotiator as any : null,
      verificationStorage: null, verificationSampler: null,
      getConnection: async () => ({ state: ConnectionState.Open }) as any, getMux: () => mux as any,
      getVerificationMux: () => ({} as any), registerPaymentMux: vi.fn(),
    });
    const acceptResponse = vi.fn((response: SerializedHttpResponse) => JSON.stringify(JSON.parse(new TextDecoder().decode(response.body))) === JSON.stringify(validResponse));
    return { handler, bpm, negotiator, mux, acceptResponse, send: (signal?: AbortSignal) => handler.sendRequest(peer, request, undefined, { unitBilling: offer, signal, acceptResponse }) };
  }
  it('validates delivery and authorizes without token estimates', async () => {
    const harness = setup();
    expect((await harness.send()).statusCode).toBe(200);
    expect(harness.bpm.observeUnitResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', true);
    expect(harness.bpm.authorizeUnitResponse).toHaveBeenCalledOnce();
    expect(harness.negotiator.estimateCostFromResponse).not.toHaveBeenCalled();
  });
  it('adds service identity headers without sending a unit price', async () => {
    const harness = setup();
    await harness.handler.sendRequest(peer, { ...request, headers: { 'content-type': 'application/json' } }, undefined, { unitBilling: offer, acceptResponse: harness.acceptResponse });
    expect(harness.mux.sendProxyRequest.mock.calls[0]![0].headers).toMatchObject({
      'x-antseed-provider': offer.provider,
    });
    expect(harness.mux.sendProxyRequest.mock.calls[0]![0].headers).not.toHaveProperty('x-antseed-unit-price');
    expect(harness.mux.sendProxyRequest.mock.calls[0]![0].headers).not.toHaveProperty('x-antseed-service-contract');
  });
  it('rejects conflicting agreement headers before execution', async () => {
    const harness = setup();
    await expect(harness.handler.sendRequest(peer, { ...request, headers: { 'X-Antseed-Provider': 'wrong-provider' } }, undefined, { unitBilling: offer, acceptResponse: harness.acceptResponse })).rejects.toThrow('agreed offer');
    expect(harness.mux.sendProxyRequest).not.toHaveBeenCalled();
  });
  it('executes a non-Levanto contract through the same request and payment path', async () => {
    const state = setup([{ statusCode: 200, body: { summary: 'Done' } }]);
    const summaryOffer = { provider: 'summarizer', service: 'summary', serviceApiProtocol: 'typesafe-systemone' as const, unitModel: { version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd: 0.001 }] } };
    const response = await state.handler.sendRequest(peer, {
      ...request, path: '/summary',
      headers: { 'content-type': 'application/json', 'x-antseed-provider': summaryOffer.provider },
      body: new TextEncoder().encode(JSON.stringify({ service: 'summary', text: 'Hello' })),
    }, undefined, {
      unitBilling: summaryOffer,
      acceptResponse: response => JSON.parse(new TextDecoder().decode(response.body)).summary === 'Done',
    });
    expect(response.statusCode).toBe(200);
    expect(state.bpm.trackUnitRequest).toHaveBeenCalledWith(peer.peerId, 'fixed', summaryOffer);
    expect(state.bpm.authorizeUnitResponse).toHaveBeenCalledOnce();
  });
  it('isolates validator mutations and rejects non-boolean asynchronous acceptance', async () => {
    const state = setup();
    state.acceptResponse.mockImplementation(response => {
      response.body.fill(0);
      response.statusCode = 500;
      return true;
    });
    expect((await state.send()).statusCode).toBe(200);
    const asynchronous = setup();
    asynchronous.acceptResponse.mockImplementation(() => Promise.resolve(true) as unknown as boolean);
    await expect(asynchronous.send()).rejects.toThrow('not accepted');
    expect(asynchronous.bpm.authorizeUnitResponse).not.toHaveBeenCalled();
  });
  it('requires an acceptance callback and respects cancellation during validation', async () => {
    const missing = setup();
    await expect(missing.handler.sendRequest(peer, request, undefined, { unitBilling: offer })).rejects.toThrow('response acceptance');
    expect(missing.mux.sendProxyRequest).not.toHaveBeenCalled();
    const state = setup();
    const abort = new AbortController();
    state.acceptResponse.mockImplementation(() => { abort.abort(); return true; });
    await expect(state.send(abort.signal)).rejects.toThrow('not accepted');
    expect(state.bpm.observeUnitResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', false);
    expect(state.bpm.authorizeUnitResponse).not.toHaveBeenCalled();
  });
  it('does not treat a discovered completed-request service as ordinary inference', async () => {
    const state = setup();
    const seller: PeerInfo = {
      ...peer,
      providers: [offer.provider],
      providerServiceApiProtocols: { [offer.provider]: { services: { [offer.service]: [offer.serviceApiProtocol] } } },
      providerServiceUnitBillingModels: { [offer.provider]: { services: { [offer.service]: {
        [offer.serviceApiProtocol]: { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] },
      } } } },
    };
    await expect(state.handler.sendRequest(seller, {
      ...request,
      path: '/v1/levanto-route',
      headers: { ...request.headers, 'content-type': 'application/json' },
    })).rejects.toThrow('explicit offer and response acceptance');
    expect(state.mux.sendProxyRequest).not.toHaveBeenCalled();
    expect(state.bpm.authorizeUnitResponse).not.toHaveBeenCalled();
  });
  it('retries only initial payment negotiation, not upstream errors', async () => {
    const harness = setup([{ statusCode: 402, body: {} }, { statusCode: 200, body: validResponse }]);
    expect((await harness.send()).statusCode).toBe(200);
    expect(harness.mux.sendProxyRequest).toHaveBeenCalledTimes(2);
    expect(harness.negotiator.handle402).not.toHaveBeenCalled();
    const failed = setup([{ statusCode: 503, body: {} }]);
    expect((await failed.send()).statusCode).toBe(503);
    expect(failed.mux.sendProxyRequest).toHaveBeenCalledOnce();
    expect(failed.bpm.authorizeUnitResponse).not.toHaveBeenCalled();
  });
  it.each(['retry', 'return'])('keeps ordinary token negotiation on its own %s path', async action => {
    const state = setup([{ statusCode: 402, body: {} }, { statusCode: 200, body: { choices: [] } }]);
    const returnedResponse = { requestId: request.requestId, statusCode: 402, headers: {}, body: new TextEncoder().encode('{}') };
    state.negotiator.handle402.mockResolvedValue(action === 'return' ? { action, response: returnedResponse } : { action });
    const response = await state.handler.sendRequest({ ...peer, defaultInputUsdPerMillion: 1, defaultOutputUsdPerMillion: 1 }, {
      ...request, path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'chat', messages: [] })),
    });
    expect(response.statusCode).toBe(action === 'retry' ? 200 : 402);
    expect(state.negotiator.handle402).toHaveBeenCalledOnce();
    expect(state.mux.sendProxyRequest).toHaveBeenCalledTimes(action === 'retry' ? 2 : 1);
    expect(state.negotiator.estimateCostFromResponse).toHaveBeenCalledTimes(action === 'retry' ? 1 : 0);
    expect(state.negotiator.negotiateUnitBillingPayment).not.toHaveBeenCalled();
    expect(state.bpm.observeUnitResponse).not.toHaveBeenCalled();
    expect(state.bpm.authorizeUnitResponse).not.toHaveBeenCalled();
  });
  it('does not pay for invalid JSON schemas or day-pass responses', async () => {
    for (const body of [{}, { ...validResponse, renewalDue: true }, { ...validResponse, ranked: [] }]) {
      const harness = setup([{ statusCode: 200, body }]);
      await expect(harness.send()).rejects.toThrow();
      expect(harness.bpm.observeUnitResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', false);
      expect(harness.bpm.authorizeUnitResponse).not.toHaveBeenCalled();
    }
  });
  it('marks negotiation failures and cancellations unbillable', async () => {
    const harness = setup([{ statusCode: 402, body: {} }]);
    harness.negotiator.negotiateUnitBillingPayment.mockRejectedValue(new Error('negotiation failed'));
    await expect(harness.send()).rejects.toThrow('negotiation failed');
    expect(harness.bpm.observeUnitResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', false);
    const cancelled = setup();
    await expect(cancelled.send(AbortSignal.abort())).rejects.toThrow('aborted');
    expect(cancelled.bpm.observeUnitResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', false);
    expect(cancelled.mux.sendProxyRequest).not.toHaveBeenCalled();
  });
  it('requires payments and forbids streaming/external auth before dispatch', async () => {
    const disabled = setup(undefined, false);
    await expect(disabled.send()).rejects.toThrow('payments must be enabled');
    expect(disabled.mux.sendProxyRequest).not.toHaveBeenCalled();
    const harness = setup();
    await expect(harness.handler.sendRequest(peer, request, {}, { unitBilling: offer })).rejects.toThrow('non-streaming');
    await expect(harness.handler.sendRequest(peer, { ...request, headers: { ...request.headers, 'X-Antseed-Spending-Auth': 'external' } }, undefined, { unitBilling: offer })).rejects.toThrow('non-streaming');
    expect(harness.mux.sendProxyRequest).not.toHaveBeenCalled();
  });
});

describe('buyer request response sanitization', () => {
  it('strips seller-controlled fault attribution headers', () => {
    const response: SerializedHttpResponse = {
      requestId: 'req-1',
      statusCode: 503,
      headers: {
        'content-type': 'application/json',
        'X-Antseed-Fault-Attribution': 'peer',
        'x-antseed-fault-attribution': 'buyer',
      },
      body: new Uint8Array(),
    };

    const sanitized = stripPeerControlledResponseHeaders(response);

    expect(sanitized.headers).toEqual({ 'content-type': 'application/json' });
    expect(response.headers['X-Antseed-Fault-Attribution']).toBe('peer');
    expect(response.headers['x-antseed-fault-attribution']).toBe('buyer');
  });
});

function makeImageRequest(): SerializedHttpRequest {
  return {
    requestId: 'req-image-v10',
    method: 'POST',
    path: '/v1/images/generations',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      model: 'gpt-image-1',
      prompt: 'cube',
      size: '1024x1024',
      n: 1,
    })),
  };
}

describe('BuyerRequestHandler payments-inactive 402 handling', () => {
  function makeChatRequest(): SerializedHttpRequest {
    return {
      requestId: 'req-chat-402',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'llama-3', messages: [] })),
    };
  }

  function makeHandlerWithSellerResponse(statusCode: number, body: unknown): BuyerRequestHandler {
    const proxyMux = {
      sendProxyRequest: vi.fn((req: SerializedHttpRequest, onResponse: (r: SerializedHttpResponse, m: { streamingStart: boolean }) => void) => {
        onResponse({
          requestId: req.requestId,
          statusCode,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(body)),
        }, { streamingStart: false });
      }),
      cancelProxyRequest: vi.fn(),
    };
    return new BuyerRequestHandler({}, {
      localPeerId: 'b'.repeat(40),
      negotiator: null,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
      getMux: vi.fn(() => proxyMux as any),
      getVerificationMux: vi.fn(() => ({} as any)),
      registerPaymentMux: vi.fn(),
    });
  }

  const peer: PeerInfo = {
    peerId: 'a'.repeat(40) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['openai'],
  };

  it('converts a seller 402 into a buyer-fault error when payments are not running', async () => {
    const handler = makeHandlerWithSellerResponse(402, {
      error: 'payment_required',
      minBudgetPerRequest: '10000',
      suggestedAmount: '1000000',
    });

    const response = await handler.sendRequest(peer, makeChatRequest());
    expect(response.statusCode).toBe(503);
    expect(response.headers['x-antseed-fault-attribution']).toBe('buyer');
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    expect(parsed.error).toBe('buyer_payments_inactive');
    expect(parsed.peerId).toBe(peer.peerId);
    expect(parsed.message).toMatch(/payments are not running on this buyer/);
    expect(parsed.message).toMatch(/not a balance problem/);
  });

  it('wraps a non-payment seller error with peer guidance', async () => {
    const handler = makeHandlerWithSellerResponse(402, {
      error: 'billing_configuration_error',
      message: 'No billing tier matches this request.',
    });

    const response = await handler.sendRequest(peer, makeChatRequest());
    expect(response.statusCode).toBe(402);
    expect(response.headers['x-antseed-fault-attribution']).toBe('peer');
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      error: { type: string; message: string; peer_message: string; peer_status: number };
    };
    expect(parsed.error.type).toBe('billing_configuration_error');
    expect(parsed.error.peer_message).toBe('No billing tier matches this request.');
    expect(parsed.error.peer_status).toBe(402);
    expect(parsed.error.message).toBe([
      'Oops, peer could not complete the request.',
      'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
      'Original Response: {"message":"No billing tier matches this request.","status":402}',
    ].join('\n'));
  });

  it('buffers a streaming seller error and returns the protocol-wrapped response', async () => {
    const sellerBody = new TextEncoder().encode(JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'Insufficient balance or no resource package. Please recharge.',
      },
    }));
    const proxyMux = {
      sendProxyRequest: vi.fn((
        req: SerializedHttpRequest,
        onResponse: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
        onChunk: (chunk: SerializedHttpResponseChunk) => void,
      ) => {
        onResponse({
          requestId: req.requestId,
          statusCode: 429,
          headers: {
            'content-type': 'text/event-stream',
            [ANTSEED_STREAMING_RESPONSE_HEADER]: '1',
          },
          body: new Uint8Array(),
        }, { streamingStart: true });
        onChunk({ requestId: req.requestId, data: sellerBody, done: false });
        onChunk({ requestId: req.requestId, data: new Uint8Array(), done: true });
      }),
      cancelProxyRequest: vi.fn(),
    };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: 'b'.repeat(40),
      negotiator: null,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
      getMux: vi.fn(() => proxyMux as any),
      getVerificationMux: vi.fn(() => ({} as any)),
      registerPaymentMux: vi.fn(),
    });
    const onResponseStart = vi.fn();
    const onResponseChunk = vi.fn();

    const response = await handler.sendRequest(peer, makeChatRequest(), {
      onResponseStart,
      onResponseChunk,
    }, { pinned: true });

    expect(onResponseStart).not.toHaveBeenCalled();
    expect(onResponseChunk).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(429);
    expect(response.headers['x-antseed-fault-attribution']).toBe('peer');
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      error: { message: string; antseed_pinned: boolean; peer_message: string; peer_status: number };
    };
    expect(parsed.error.antseed_pinned).toBe(true);
    expect(parsed.error.peer_message).toBe('Insufficient balance or no resource package. Please recharge.');
    expect(parsed.error.peer_status).toBe(429);
    expect(parsed.error.message).toBe([
      'Oops, pinned peer could not complete the request.',
      'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
      'Original Response: {"message":"Insufficient balance or no resource package. Please recharge.","status":429}',
    ].join('\n'));
  });
});

describe('BuyerRequestHandler billing guards', () => {
  it('rejects paid image requests when metadata lacks a service unit billing model', async () => {
    const paymentMux = {};
    const negotiator = {
      getOrCreatePaymentMux: vi.fn(() => paymentMux),
      trackRequestBillingContext: vi.fn(),
    };
    const proxyMux = {
      cancelProxyRequest: vi.fn(),
    };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: 'b'.repeat(40),
      negotiator: negotiator as any,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
      getMux: vi.fn(() => proxyMux as any),
      getVerificationMux: vi.fn(() => ({} as any)),
      registerPaymentMux: vi.fn(),
    });
    const peer: PeerInfo = {
      peerId: 'a'.repeat(40) as PeerInfo['peerId'],
      lastSeen: Date.now(),
      providers: ['openai'],
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          services: {
            'gpt-image-1': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          },
        },
      },
      providerServiceApiProtocols: {
        openai: {
          services: {
            'gpt-image-1': ['openai-images'],
          },
        },
      },
    };

    await expect(handler.sendRequest(peer, makeImageRequest())).rejects.toThrow(
      /without service unit billing metadata/,
    );
    expect(negotiator.trackRequestBillingContext).not.toHaveBeenCalled();
  });
});
