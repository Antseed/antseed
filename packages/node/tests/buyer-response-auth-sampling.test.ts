import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { createResponseAuthPayload } from '../src/verification/index.js';
import type { PeerInfo, PeerId } from '../src/types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from '../src/types/protocol.js';
import { encodeHttpRequest, encodeHttpResponse } from '../src/proxy/request-codec.js';

describe('BuyerRequestHandler response auth sampling', () => {
  it('passes verified response auth evidence to the sampler', async () => {
    const seller = identityFromPrivateKeyHex('11'.repeat(32));
    const buyer = identityFromPrivateKeyHex('22'.repeat(32));
    const peer = {
      peerId: seller.peerId,
      capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId: 'req-sampled',
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'sample-model' })),
    };
    const response: SerializedHttpResponse = {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })),
    };
    const responseAuth = createResponseAuthPayload({
      request,
      response,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'sample-model',
      provider: 'test-provider',
      responseStartedAt: 100,
      responseCompletedAt: 200,
    }, seller.wallet);

    const maybeStoreResponseAuthSample = vi.fn(async () => null);
    const insertResponseAuth = vi.fn();
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: buyer.peerId as PeerId,
        negotiator: null,
        verificationStorage: { insertResponseAuth },
        verificationSampler: { maybeStoreResponseAuthSample } as any,
        getConnection: vi.fn(async () => ({ state: 'open' })) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest: vi.fn((
            _request: SerializedHttpRequest,
            onResponse: (res: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
          ) => {
            onResponse(response, { streamingStart: false });
          }),
          cancelProxyRequest: vi.fn(),
        })) as any,
        getVerificationMux: vi.fn(() => ({
          waitForResponseAuth: vi.fn(async () => responseAuth),
        })) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    await handler.sendRequest(peer, request, undefined, { captureResponseAuthPreimages: true });

    await vi.waitFor(() => {
      expect(maybeStoreResponseAuthSample).toHaveBeenCalledOnce();
      expect(insertResponseAuth).toHaveBeenCalledOnce();
    });
    expect(insertResponseAuth).toHaveBeenCalledWith(expect.objectContaining({
      requestPreimage: encodeHttpRequest(request),
      responsePreimage: encodeHttpResponse(response),
    }));
    expect(maybeStoreResponseAuthSample).toHaveBeenCalledWith(expect.objectContaining({
      request,
      response,
      responseAuth,
      verified: true,
      verificationError: null,
    }));
  });

  it('does not wait for response auth on non-inference requests', async () => {
    const waitForResponseAuth = vi.fn(async () => {
      throw new Error('should not wait');
    });
    const request: SerializedHttpRequest = {
      requestId: 'req-models',
      method: 'GET',
      path: '/v1/models',
      headers: {},
      body: new Uint8Array(0),
    };
    const response: SerializedHttpResponse = {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ data: [] })),
    };
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: 'a'.repeat(40) as PeerId,
        negotiator: null,
        verificationStorage: null,
        verificationSampler: null,
        getConnection: vi.fn(async () => ({ state: 'open' })) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest: vi.fn((
            _request: SerializedHttpRequest,
            onResponse: (res: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
          ) => {
            onResponse(response, { streamingStart: false });
          }),
          cancelProxyRequest: vi.fn(),
        })) as any,
        getVerificationMux: vi.fn(() => ({ waitForResponseAuth })) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    await handler.sendRequest({
      peerId: 'b'.repeat(40),
      capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    } as PeerInfo, request);

    expect(waitForResponseAuth).not.toHaveBeenCalled();
  });

  it('does not wait for response auth when the seller has not advertised support', async () => {
    const waitForResponseAuth = vi.fn(async () => {
      throw new Error('should not wait');
    });
    const request: SerializedHttpRequest = {
      requestId: 'req-no-capability',
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'sample-model' })),
    };
    const response: SerializedHttpResponse = {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ ok: true })),
    };
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: 'a'.repeat(40) as PeerId,
        negotiator: null,
        verificationStorage: null,
        verificationSampler: null,
        getConnection: vi.fn(async () => ({ state: 'open' })) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest: vi.fn((
            _request: SerializedHttpRequest,
            onResponse: (res: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
          ) => {
            onResponse(response, { streamingStart: false });
          }),
          cancelProxyRequest: vi.fn(),
        })) as any,
        getVerificationMux: vi.fn(() => ({ waitForResponseAuth })) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    await handler.sendRequest({ peerId: 'b'.repeat(40) } as PeerInfo, request);

    expect(waitForResponseAuth).not.toHaveBeenCalled();
  });

  it('validates response auth against the channel captured when the request was dispatched', async () => {
    const seller = identityFromPrivateKeyHex('33'.repeat(32));
    const buyer = identityFromPrivateKeyHex('44'.repeat(32));
    const channelAtDispatch = `0x${'55'.repeat(32)}`;
    const rotatedChannel = `0x${'66'.repeat(32)}`;
    const peer = {
      peerId: seller.peerId,
      capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId: 'req-channel-snapshot',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'sample-model' })),
    };
    const response: SerializedHttpResponse = {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
    };
    const responseAuth = createResponseAuthPayload({
      request,
      response,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'sample-model',
      provider: 'test-provider',
      channelId: channelAtDispatch,
      responseStartedAt: 100,
      responseCompletedAt: 200,
    }, seller.wallet);
    let requestDispatched = false;
    const maybeStoreResponseAuthSample = vi.fn(async () => null);
    const bpm = {
      trackRequestService: vi.fn(),
      getActiveSession: vi.fn(() => ({ sessionId: requestDispatched ? rotatedChannel : channelAtDispatch })),
    };
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: buyer.peerId as PeerId,
        negotiator: {
          bpm,
          getOrCreatePaymentMux: vi.fn(() => ({})),
          trackRequestBillingContext: vi.fn(),
          estimateCostFromResponse: vi.fn(),
        } as any,
        verificationStorage: null,
        verificationSampler: { maybeStoreResponseAuthSample } as any,
        getConnection: vi.fn(async () => ({ state: 'open' })) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest: vi.fn((
            _request: SerializedHttpRequest,
            onResponse: (res: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
          ) => {
            requestDispatched = true;
            onResponse(response, { streamingStart: false });
          }),
          cancelProxyRequest: vi.fn(),
        })) as any,
        getVerificationMux: vi.fn(() => ({
          waitForResponseAuth: vi.fn(async () => responseAuth),
        })) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    await handler.sendRequest(peer, request);

    await vi.waitFor(() => expect(maybeStoreResponseAuthSample).toHaveBeenCalledOnce());
    expect(maybeStoreResponseAuthSample).toHaveBeenCalledWith(expect.objectContaining({
      verified: true,
      verificationError: null,
    }));
    expect(bpm.getActiveSession).toHaveBeenCalledOnce();
  });
});
