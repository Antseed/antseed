import { createPublicKey, type KeyObject } from 'node:crypto';

/** P-256 public keys as they travel: uncompressed SEC1 points (0x04 ‖ x ‖ y, 65 bytes). */

export const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export function p256Jwk(raw: Uint8Array) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('P-256 public key must be 65 bytes, uncompressed');
  return { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) };
}

export function publicKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: p256Jwk(raw), format: 'jwk' });
}
