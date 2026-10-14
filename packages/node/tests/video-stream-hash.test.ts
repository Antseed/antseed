import { expect, it } from 'vitest';
import { createStreamingResponseHash, hashResponse, createResponseAuthPayload, verifyResponseAuth } from '../src/verification/response-auth.js';
import { Wallet } from 'ethers';

const request = { requestId: 'video', method: 'POST', path: '/api/v1/video/retrieve', headers: {}, body: new TextEncoder().encode('{"queue_id":"job"}') };
const body = new Uint8Array(3 * 1024 * 1024 + 17).fill(42);
const response = { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(body.length), 'x-antseed-streaming': '1' }, body };

it('incremental hashing exactly matches v1 response authentication for any chunk boundaries', () => {
  for (const size of [65536, 12345]) {
    const hash = createStreamingResponseHash(response);
    for (let offset = 0; offset < body.length; offset += size) hash.update(body.subarray(offset, offset + size));
    const streamed = { ...response, body: new Uint8Array(), streamedBody: hash.finish() };
    expect(hashResponse(streamed)).toBe(hashResponse(response));
    const wallet = Wallet.createRandom();
    const context = { request, buyerPeerId: '11'.repeat(20), sellerPeerId: wallet.address, advertisedService: 'venice' };
    const auth = createResponseAuthPayload({ ...context, response: streamed, provider: 'venice', responseStartedAt: 1, responseCompletedAt: 2 }, wallet as unknown as Wallet);
    expect(verifyResponseAuth(auth, { ...context, response }).valid).toBe(true);
    const corrupt = new Uint8Array(body);
    corrupt[0] ^= 1;
    expect(verifyResponseAuth(auth, { ...context, response: { ...response, body: corrupt } }).valid).toBe(false);
  }
});

it('supports bounded streams without a content length and rejects invalid declared lengths', () => {
  const unknownLength = { ...response, headers: { 'content-type': 'video/mp4', 'x-antseed-streaming': '1' } };
  const hash = createStreamingResponseHash(unknownLength);
  hash.update(body.subarray(0, 20));
  hash.update(body.subarray(20));
  expect(hash.finish().byteLength).toBe(body.length);
  for (const length of ['', '0', '-1', 'NaN', '4294967296']) expect(() => createStreamingResponseHash({ ...response, headers: { 'content-length': length } })).toThrow();
  const truncated = createStreamingResponseHash(response);
  truncated.update(body.subarray(0, 20));
  expect(() => truncated.finish()).toThrow('Incomplete');
  const excessive = createStreamingResponseHash(response);
  excessive.update(body);
  expect(() => excessive.update(new Uint8Array(1))).toThrow('exceeds');
});
