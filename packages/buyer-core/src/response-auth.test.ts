import { describe, expect, it } from 'vitest';
import { Wallet, keccak256 } from 'ethers';
import { randomBytes } from 'node:crypto';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/protocol/http';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/protocol/request-codec';
import { createResponseAuthPayload, hashRequest, hashResponse, verifyResponseAuth } from './response-auth.js';
import { keccakReady } from './keccak.js';

const request: SerializedHttpRequest = {
  requestId: 'req-1',
  method: 'POST',
  path: '/v1/chat/completions?x=1',
  headers: { 'content-type': 'application/json', 'x-custom': 'värde' },
  body: randomBytes(150_000),
};

const response: SerializedHttpResponse = {
  requestId: 'req-1',
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: randomBytes(90_000),
};

describe('response auth hashes', () => {
  it('hashes a request as its wire encoding', async () => {
    await keccakReady;
    expect(hashRequest(request)).toBe(keccak256(encodeHttpRequest(request)));
    const empty = { ...request, method: 'GET', body: new Uint8Array() };
    expect(hashRequest(empty)).toBe(keccak256(encodeHttpRequest(empty)));
  });

  it('hashes a response as its wire encoding, without the streaming marker', async () => {
    await keccakReady;
    expect(hashResponse(response)).toBe(keccak256(encodeHttpResponse(response)));
    const streamed = { ...response, headers: { ...response.headers, [ANTSEED_STREAMING_RESPONSE_HEADER]: '1' } };
    expect(hashResponse(streamed)).toBe(keccak256(encodeHttpResponse(response)));
  });

  it('signs a request hash made earlier without reading the request body again', async () => {
    await keccakReady;
    const seller = Wallet.createRandom();
    const context = {
      buyerPeerId: Wallet.createRandom().address,
      sellerPeerId: seller.address,
      advertisedService: 'model-a',
    };
    const payload = createResponseAuthPayload({
      ...context,
      request: { ...request, body: new Uint8Array() },
      requestHash: hashRequest(request),
      response,
      provider: 'provider-a',
      responseStartedAt: 1,
      responseCompletedAt: 2,
    }, seller as unknown as Wallet);

    expect(verifyResponseAuth(payload, { ...context, request, response })).toEqual({ valid: true });
  });
});
