import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { createResponseAuthPayload } from '../src/verification/index.js';
import type { PeerInfo, PeerId } from '../src/types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from '../src/types/protocol.js';

describe('BuyerRequestHandler response auth sampling', () => {
  it.each([
    { free: true, validSignature: true, error: null },
    { free: false, validSignature: true, error: 'channel_id_mismatch' },
    { free: true, validSignature: false, error: 'invalid_signature' },
  ])('checks receipt identity and signatures without requiring a stale paid channel for free requests: %j', async scenario => {
    const seller = identityFromPrivateKeyHex('11'.repeat(32));
    const buyer = identityFromPrivateKeyHex('22'.repeat(32));
    const peer = { peerId: seller.peerId, capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1] } as PeerInfo;
    const request = { requestId: 'free-video-reconnect', method: 'POST', path: '/api/v1/video/retrieve', headers: {}, body: new TextEncoder().encode('{"queue_id":"job"}') };
    const response = { requestId: request.requestId, statusCode: 200, headers: {}, body: new Uint8Array([42]) };
    const payload = createResponseAuthPayload({ request, response, buyerPeerId: buyer.peerId, sellerPeerId: seller.peerId, advertisedService: 'venice', provider: 'venice', responseStartedAt: 100, responseCompletedAt: 200, channelId: '0x' + '33'.repeat(32) }, seller.wallet);
    if (!scenario.validSignature) payload.signature = '00'.repeat(65);
    const maybeStoreResponseAuthSample = vi.fn(async () => null);
    const handler = new BuyerRequestHandler({}, {
      localPeerId: buyer.peerId,
      negotiator: { bpm: { getActiveSession: () => ({ sessionId: '0x' + '44'.repeat(32) }) } },
      verificationSampler: { maybeStoreResponseAuthSample },
    } as any);
    (handler as any)._recordResponseAuth(peer, request, response, 'venice', { waitForResponseAuth: async () => payload }, scenario.free);
    await vi.waitFor(() => expect(maybeStoreResponseAuthSample).toHaveBeenCalledOnce());
    expect(maybeStoreResponseAuthSample).toHaveBeenCalledWith(expect.objectContaining({ verified: scenario.error === null, verificationError: scenario.error }));
  });

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
    let deliverAuth!: () => void;
    const authReady = new Promise<void>(resolve => { deliverAuth = resolve; });
    const handler = new BuyerRequestHandler(
      {},
      {
        localPeerId: buyer.peerId as PeerId,
        negotiator: null,
        verificationStorage: null,
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
          waitForResponseAuth: vi.fn(async () => { await authReady; return responseAuth; }),
        })) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    const received = await handler.sendRequest(peer, request);
    received.headers['x-antseed-seller-peer'] = seller.peerId;
    deliverAuth();

    await vi.waitFor(() => {
      expect(maybeStoreResponseAuthSample).toHaveBeenCalledOnce();
    });
    expect(maybeStoreResponseAuthSample).toHaveBeenCalledWith(expect.objectContaining({
      request,
      response: expect.objectContaining({ headers: { 'content-type': 'application/json' } }),
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
});
