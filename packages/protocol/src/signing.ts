/**
 * Peer message signing: EIP-191 personal_sign with Antseed domain prefixes to
 * prevent cross-domain signature replay. Moved from @antseed/node p2p/identity.
 */

import { Wallet, hashMessage, getBytes, hexlify, verifyMessage } from 'ethers';
import { MSG_SIGNING_DOMAIN } from './connection-auth.js';

const DOMAIN_DATA = new TextEncoder().encode('antseed-data-v1:');
const DOMAIN_MSG = MSG_SIGNING_DOMAIN;

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Hex string must have even length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sign binary data. Domain-tagged with "antseed-data-v1:" to prevent
 * cross-domain replay. Uses EIP-191 personal_sign; returns 65 bytes (r+s+v).
 */
export function signData(
  wallet: Wallet,
  data: Uint8Array
): Uint8Array {
  const tagged = new Uint8Array(DOMAIN_DATA.length + data.length);
  tagged.set(DOMAIN_DATA, 0);
  tagged.set(data, DOMAIN_DATA.length);
  const digest = hashMessage(tagged);
  const sig = wallet.signingKey.sign(digest);
  return getBytes(sig.serialized);
}

/**
 * Verify a binary data signature from a remote peer using ecrecover.
 * The expectedAddress is the 40-char hex peerId (no 0x prefix).
 */
export function verifySignature(
  expectedAddress: string,
  signature: Uint8Array,
  data: Uint8Array
): boolean {
  try {
    const tagged = new Uint8Array(DOMAIN_DATA.length + data.length);
    tagged.set(DOMAIN_DATA, 0);
    tagged.set(data, DOMAIN_DATA.length);
    const recovered = verifyMessage(tagged, hexlify(signature));
    return recovered.slice(2).toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Sign a UTF-8 message and return a hex-encoded secp256k1 signature (130 hex
 * chars = 65 bytes). Domain-tagged with "antseed-msg-v1:".
 */
export function signUtf8(wallet: Wallet, message: string): string {
  const tagged = DOMAIN_MSG + message;
  const msgBytes = new TextEncoder().encode(tagged);
  const digest = hashMessage(msgBytes);
  const sig = wallet.signingKey.sign(digest);
  return sig.serialized.slice(2);
}

/**
 * Verify a UTF-8 message against a hex-encoded secp256k1 signature.
 * Returns true if the recovered address matches the expected address.
 */
export function verifyUtf8(
  address: string,
  message: string,
  signatureHex: string
): boolean {
  try {
    const tagged = DOMAIN_MSG + message;
    const msgBytes = new TextEncoder().encode(tagged);
    const recovered = verifyMessage(msgBytes, '0x' + signatureHex);
    return recovered.slice(2).toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}
