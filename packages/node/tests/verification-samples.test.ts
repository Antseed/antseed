import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeHttpRequest, decodeHttpResponse } from '../src/proxy/request-codec.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import { createResponseAuthPayload, VerificationSampler } from '../src/verification/index.js';

function makeRequest(body = JSON.stringify({ model: 'sample-model', messages: [] })): SerializedHttpRequest {
  return {
    requestId: 'req/sample-1',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(body),
  };
}

function makeResponse(body = JSON.stringify({ content: [{ type: 'text', text: 'sampled' }] })): SerializedHttpResponse {
  return {
    requestId: 'req/sample-1',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(body),
  };
}

describe('VerificationSampler', () => {
  it('defaults to a 0.5 percent sample rate', () => {
    const samplerHit = new VerificationSampler('/tmp/unused', { random: () => 0.0049 });
    const samplerMiss = new VerificationSampler('/tmp/unused', { random: () => 0.005 });

    expect(samplerHit.shouldSample()).toBe(true);
    expect(samplerMiss.shouldSample()).toBe(false);
  });

  it('stores sampled request and response evidence with the response auth manifest', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'verification-samples-test-'));
    try {
      const seller = identityFromPrivateKeyHex('11'.repeat(32));
      const buyer = identityFromPrivateKeyHex('22'.repeat(32));
      const request = makeRequest();
      const response = makeResponse();
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

      const sampler = new VerificationSampler(tempDir, { sampleRate: 1 });
      const sample = await sampler.maybeStoreResponseAuthSample({
        request,
        response,
        responseAuth,
        verified: true,
        verificationError: null,
      });

      expect(sample).not.toBeNull();
      const manifest = JSON.parse(readFileSync(join(sample!.directory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest.requestId).toBe(request.requestId);
      expect(manifest.requestHash).toBe(responseAuth.requestHash);
      expect(manifest.responseHash).toBe(responseAuth.responseHash);
      expect((manifest.files as Record<string, unknown>).encoding).toBe('antseed-http-codec-v1');

      const storedRequest = decodeHttpRequest(readFileSync(join(sample!.directory, 'request.bin')));
      const storedResponse = decodeHttpResponse(readFileSync(join(sample!.directory, 'response.bin')));
      expect(storedRequest.path).toBe(request.path);
      expect(new TextDecoder().decode(storedRequest.body)).toBe(new TextDecoder().decode(request.body));
      expect(storedResponse.statusCode).toBe(response.statusCode);
      expect(new TextDecoder().decode(storedResponse.body)).toBe(new TextDecoder().decode(response.body));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips streamed responses whose bytes were not retained for evidence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'verification-samples-stream-test-'));
    try {
      const seller = identityFromPrivateKeyHex('11'.repeat(32));
      const buyer = identityFromPrivateKeyHex('22'.repeat(32));
      const request = makeRequest();
      const response = makeResponse();
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
      const sampler = new VerificationSampler(tempDir, { sampleRate: 1 });
      const sample = await sampler.maybeStoreResponseAuthSample({
        request,
        response: {
          ...response,
          body: new Uint8Array(),
          streamedBody: { byteLength: response.body.length, responseHash: responseAuth.responseHash },
        },
        responseAuth,
        verified: true,
        verificationError: null,
      });

      expect(sample).toBeNull();
      expect(readdirSync(tempDir)).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips samples over the configured byte limit', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'verification-samples-limit-test-'));
    try {
      const seller = identityFromPrivateKeyHex('11'.repeat(32));
      const buyer = identityFromPrivateKeyHex('22'.repeat(32));
      const request = makeRequest('x'.repeat(128));
      const response = makeResponse('y'.repeat(128));
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

      const sampler = new VerificationSampler(tempDir, { sampleRate: 1, maxSampleBytes: 32 });
      const sample = await sampler.maybeStoreResponseAuthSample({
        request,
        response,
        responseAuth,
        verified: true,
        verificationError: null,
      });

      expect(sample).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
