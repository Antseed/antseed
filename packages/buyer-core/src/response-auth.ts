import { keccak256 } from 'ethers';
import { keccak_256 } from '@noble/hashes/sha3';
import { VIDEO_DOWNLOAD_MAX_BYTES } from '@antseed/protocol/http';
import type { Wallet } from 'ethers';
import type { ResponseAuthPayload } from '@antseed/protocol/messages';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/protocol/http';
import { bytesToHex, hexToBytes, signData, verifySignature } from '@antseed/protocol/signing';
import { encodeHttpRequest, encodeHttpResponse, encodeHttpResponsePrefix } from '@antseed/protocol/request-codec';

const RESPONSE_AUTH_DOMAIN = 'antseed-response-auth-v1';

export interface ResponseAuthInput {
  request: SerializedHttpRequest;
  response: SerializedHttpResponse;
  buyerPeerId: string;
  sellerPeerId: string;
  advertisedService: string;
  provider: string;
  responseStartedAt: number;
  responseCompletedAt: number;
  channelId?: string | null;
}

export interface ResponseAuthVerificationExpected {
  request: SerializedHttpRequest;
  response: SerializedHttpResponse;
  buyerPeerId: string;
  sellerPeerId: string;
  advertisedService: string;
  channelId?: string | null;
}

export interface ResponseAuthVerificationResult {
  valid: boolean;
  reason?: string;
}

export function createResponseAuthPayload(input: ResponseAuthInput, signer: Wallet): ResponseAuthPayload {
  const payload: Omit<ResponseAuthPayload, 'signature'> = {
    version: 1,
    requestId: input.request.requestId,
    ...(input.channelId ? { channelId: input.channelId } : {}),
    buyerPeerId: normalizePeerId(input.buyerPeerId),
    sellerPeerId: normalizePeerId(input.sellerPeerId),
    advertisedService: input.advertisedService,
    provider: input.provider,
    statusCode: input.response.statusCode,
    requestHash: hashRequest(input.request),
    responseHash: hashResponse(input.response),
    responseStartedAt: input.responseStartedAt,
    responseCompletedAt: input.responseCompletedAt,
  };
  const signature = bytesToHex(signData(signer, buildResponseAuthSigningBytes(payload)));
  return { ...payload, signature };
}

export function verifyResponseAuth(
  payload: ResponseAuthPayload,
  expected: ResponseAuthVerificationExpected,
): ResponseAuthVerificationResult {
  const expectedRequestHash = hashRequest(expected.request);
  if (payload.requestHash !== expectedRequestHash) {
    return { valid: false, reason: 'request_hash_mismatch' };
  }

  const expectedResponseHash = hashResponse(expected.response);
  if (payload.responseHash !== expectedResponseHash) {
    return { valid: false, reason: 'response_hash_mismatch' };
  }

  if (payload.requestId !== expected.request.requestId) {
    return { valid: false, reason: 'request_id_mismatch' };
  }
  if (payload.statusCode !== expected.response.statusCode) {
    return { valid: false, reason: 'status_code_mismatch' };
  }
  if (normalizePeerId(payload.buyerPeerId) !== normalizePeerId(expected.buyerPeerId)) {
    return { valid: false, reason: 'buyer_peer_mismatch' };
  }
  if (normalizePeerId(payload.sellerPeerId) !== normalizePeerId(expected.sellerPeerId)) {
    return { valid: false, reason: 'seller_peer_mismatch' };
  }
  if (payload.advertisedService !== expected.advertisedService) {
    return { valid: false, reason: 'advertised_service_mismatch' };
  }
  if (expected.channelId && payload.channelId !== expected.channelId) {
    return { valid: false, reason: 'channel_id_mismatch' };
  }

  const { signature: _signature, ...unsigned } = payload;
  let validSignature = false;
  try {
    const signature = hexToBytes(payload.signature);
    validSignature = verifySignature(
      normalizePeerId(expected.sellerPeerId),
      signature,
      buildResponseAuthSigningBytes(unsigned),
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true };
}

export function hashRequest(request: SerializedHttpRequest): string {
  return keccak256(encodeHttpRequest(request));
}

export function hashResponse(response: SerializedHttpResponse): string {
  if (response.streamedBody) return response.streamedBody.responseHash;
  return keccak256(encodeHttpResponse(stripStreamingHeader(response)));
}

export function createStreamingResponseHash(response: SerializedHttpResponse) {
  const rawLength = response.headers['content-length'];
  if (rawLength !== undefined) {
    const declaredLength = Number(rawLength);
    if (!/^[1-9][0-9]*$/.test(rawLength) || !Number.isSafeInteger(declaredLength) || declaredLength > VIDEO_DOWNLOAD_MAX_BYTES) {
      throw new Error('Invalid video content length');
    }
  }
  const byteLength = rawLength === undefined ? undefined : Number(rawLength);
  const { body: _body, ...responseWithoutBody } = stripStreamingHeader(response);
  const prefix = encodeHttpResponsePrefix(responseWithoutBody, byteLength ?? 0);
  const hash = keccak_256.create().update(prefix);
  let received = 0;
  return {
    update(data: Uint8Array): void {
      received += data.length;
      if (received > VIDEO_DOWNLOAD_MAX_BYTES || (byteLength !== undefined && received > byteLength)) throw new Error('Video exceeds content length');
      hash.update(data);
    },
    finish(): NonNullable<SerializedHttpResponse['streamedBody']> {
      if (byteLength !== undefined && received !== byteLength) throw new Error('Incomplete video');
      return { byteLength: received, responseHash: `0x${bytesToHex(hash.digest())}` };
    },
  };
}

function buildResponseAuthSigningBytes(payload: Omit<ResponseAuthPayload, 'signature'>): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [
    RESPONSE_AUTH_DOMAIN,
    String(payload.version),
    payload.requestId,
    payload.channelId ?? '',
    normalizePeerId(payload.buyerPeerId),
    normalizePeerId(payload.sellerPeerId),
    payload.advertisedService,
    payload.provider,
    String(payload.statusCode),
    payload.requestHash,
    payload.responseHash,
    String(payload.responseStartedAt),
    String(payload.responseCompletedAt),
  ].map((field) => encoder.encode(field));

  const totalLength = fields.reduce((sum, field) => sum + 4 + field.length, 0);
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.length);
    offset += 4;
    out.set(field, offset);
    offset += field.length;
  }
  return out;
}

function stripStreamingHeader(response: SerializedHttpResponse): SerializedHttpResponse {
  if (response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] !== '1') {
    return response;
  }
  const headers = { ...response.headers };
  delete headers[ANTSEED_STREAMING_RESPONSE_HEADER];
  return { ...response, headers };
}

function normalizePeerId(peerId: string): string {
  return peerId.startsWith('0x') ? peerId.slice(2).toLowerCase() : peerId.toLowerCase();
}
