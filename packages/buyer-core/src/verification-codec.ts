import type { ResponseAuthPayload } from '@antseed/protocol/messages';
import {
  parseJsonObject,
  requireFiniteNumberField,
  requireStringField,
} from '@antseed/protocol/json-codec';

const encoder = new TextEncoder();

const MAX_PAYLOAD_SIZE = 64 * 1024;

function parseVerificationJson(data: Uint8Array): Record<string, unknown> {
  return parseJsonObject(data, {
    maxBytes: MAX_PAYLOAD_SIZE,
    payloadName: 'Verification payload',
  });
}

export function encodeResponseAuth(payload: ResponseAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decodeResponseAuth(data: Uint8Array): ResponseAuthPayload {
  const obj = parseVerificationJson(data);
  const version = obj.version;
  if (version !== 1) {
    throw new Error(`Unsupported response auth version: ${String(version)}`);
  }

  const result: ResponseAuthPayload = {
    version,
    requestId: requireStringField(obj, 'requestId'),
    buyerPeerId: requireStringField(obj, 'buyerPeerId'),
    sellerPeerId: requireStringField(obj, 'sellerPeerId'),
    advertisedService: requireStringField(obj, 'advertisedService'),
    provider: requireStringField(obj, 'provider'),
    statusCode: requireFiniteNumberField(obj, 'statusCode'),
    requestHash: requireStringField(obj, 'requestHash'),
    responseHash: requireStringField(obj, 'responseHash'),
    responseStartedAt: requireFiniteNumberField(obj, 'responseStartedAt'),
    responseCompletedAt: requireFiniteNumberField(obj, 'responseCompletedAt'),
    signature: requireStringField(obj, 'signature'),
  };
  if (typeof obj.channelId === 'string' && obj.channelId.length > 0) {
    result.channelId = obj.channelId;
  }
  return result;
}
