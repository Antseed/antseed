/**
 * A PeerId is the EVM address hex (40 lowercase chars = 20 bytes, no 0x prefix).
 * This is the canonical identifier for any peer in the network.
 * The peer's secp256k1 wallet address serves as both P2P and on-chain identity.
 */
export type PeerId = string & { readonly __brand: "PeerId" };

/**
 * Validates and brands a string as a PeerId.
 * Must be exactly 40 lowercase hex characters (EVM address without 0x).
 */
export function toPeerId(hex: string): PeerId {
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`Invalid PeerId: expected 40 hex chars, got "${hex.slice(0, 20)}..."`);
  }
  return hex as PeerId;
}

/** Convert a PeerId to a checksummed 0x-prefixed EVM address. */
export function peerIdToAddress(peerId: string): string {
  return '0x' + peerId;
}
