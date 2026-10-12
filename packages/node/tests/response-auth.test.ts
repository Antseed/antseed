import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import {
  createResponseAuthPayload,
  verifyResponseAuth,
  VerificationStorage,
} from '../src/verification/index.js';

function makeRequest(): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-test', messages: [] })),
  };
}

function makeResponse(): SerializedHttpResponse {
  return {
    requestId: 'req-1',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })),
  };
}

describe('ResponseAuth', () => {
  it('signs and verifies one response auth payload', () => {
    const seller = identityFromPrivateKeyHex('11'.repeat(32));
    const buyer = identityFromPrivateKeyHex('22'.repeat(32));
    const request = makeRequest();
    const response = makeResponse();

    const payload = createResponseAuthPayload({
      request,
      response,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'claude-sonnet-test',
      provider: 'anthropic',
      responseStartedAt: 100,
      responseCompletedAt: 200,
      channelId: '0x' + 'aa'.repeat(32),
    }, seller.wallet);

    expect(payload.signature).toHaveLength(130);
    expect(verifyResponseAuth(payload, {
      request,
      response,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'claude-sonnet-test',
      channelId: '0x' + 'aa'.repeat(32),
    })).toEqual({ valid: true });
  });

  it('rejects a payload when the response bytes differ', () => {
    const seller = identityFromPrivateKeyHex('11'.repeat(32));
    const buyer = identityFromPrivateKeyHex('22'.repeat(32));
    const request = makeRequest();
    const response = makeResponse();

    const payload = createResponseAuthPayload({
      request,
      response,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'claude-sonnet-test',
      provider: 'anthropic',
      responseStartedAt: 100,
      responseCompletedAt: 200,
    }, seller.wallet);

    const tamperedResponse = {
      ...response,
      body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'tampered' }] })),
    };
    const result = verifyResponseAuth(payload, {
      request,
      response: tamperedResponse,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'claude-sonnet-test',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('response_hash_mismatch');
  });

  it('signs and verifies fields containing delimiter characters', () => {
    const seller = identityFromPrivateKeyHex('11'.repeat(32));
    const buyer = identityFromPrivateKeyHex('22'.repeat(32));
    const request = {
      ...makeRequest(),
      requestId: 'req|with|pipes',
    };
    const response = {
      ...makeResponse(),
      requestId: request.requestId,
    };
    const channelId = 'channel|with|pipes';

    const payload = createResponseAuthPayload({
      request,
      response,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'claude|sonnet|test',
      provider: 'anthropic|test',
      responseStartedAt: 100,
      responseCompletedAt: 200,
      channelId,
    }, seller.wallet);

    expect(verifyResponseAuth(payload, {
      request,
      response,
      buyerPeerId: buyer.peerId,
      sellerPeerId: seller.peerId,
      advertisedService: 'claude|sonnet|test',
      channelId,
    })).toEqual({ valid: true });
  });

  it('stores lightweight response auth records locally', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'verification-store-test-'));
    const storage = new VerificationStorage(join(tempDir, 'verification.db'));
    try {
      const seller = identityFromPrivateKeyHex('11'.repeat(32));
      const buyer = identityFromPrivateKeyHex('22'.repeat(32));
      const payload = createResponseAuthPayload({
        request: makeRequest(),
        response: makeResponse(),
        buyerPeerId: buyer.peerId,
        sellerPeerId: seller.peerId,
        advertisedService: 'claude-sonnet-test',
        provider: 'anthropic',
        responseStartedAt: 100,
        responseCompletedAt: 200,
      }, seller.wallet);

      storage.insertResponseAuth({
        ...payload,
        receivedAt: 300,
        verified: true,
        verificationError: null,
      });

      const loaded = storage.getResponseAuth(payload.requestId);
      expect(loaded).not.toBeNull();
      expect(loaded!.requestHash).toBe(payload.requestHash);
      expect(loaded!.verified).toBe(true);
      expect(loaded!.verificationError).toBeNull();

      (storage as unknown as { _db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
        ._db.prepare('UPDATE response_auths SET version = ? WHERE request_id = ?')
        .run(7, payload.requestId);
      expect(storage.getResponseAuth(payload.requestId)!.version).toBe(7);
    } finally {
      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
