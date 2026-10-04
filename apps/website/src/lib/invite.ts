import {secp256k1} from '@noble/curves/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {EPOCH_DURATION, GENESIS} from './useEpochCountdown';

/* ── Referral invites ─────────────────────────────────────────────
   Mirrors packages/node/src/payments/invites.ts: an invite is base64url
   (no padding) of 68 bytes — version 1, issued epoch (uint16 BE), index
   (uint8), then the referrer's EIP-2098 compact signature (r, vs) over the
   EIP-712 `Invite(uint256 issuedEpoch,uint256 index)` in the AntseedReferrals
   domain. The referrer is recovered from the signature. */

/** AntseedReferrals on Base mainnet. Empty until deployed: the page then hides the referrer. */
export const REFERRALS_ADDRESS = '';
const CHAIN_ID = 8453;
/** Epochs an invite stays usable, counting its issue epoch. */
const INVITE_VALIDITY_EPOCHS = 4;

export interface Invite {
  epoch: number;
  index: number;
  r: Uint8Array;
  vs: Uint8Array;
}

export function decodeInvite(value: string): Invite | null {
  if (!/^[A-Za-z0-9_-]{91}$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (bytes.length !== 68 || bytes[0] !== 1) return null;
    return {epoch: (bytes[1] << 8) | bytes[2], index: bytes[3], r: bytes.slice(4, 36), vs: bytes.slice(36, 68)};
  } catch {
    return null;
  }
}

/** When the invite stops working: the start of epoch `epoch + 4`. */
export function inviteExpiry(invite: Invite): Date {
  return new Date((GENESIS + (invite.epoch + INVITE_VALIDITY_EPOCHS) * EPOCH_DURATION) * 1000);
}

const utf8 = (text: string) => new TextEncoder().encode(text);

function word(value: bigint | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const out = new Uint8Array(32);
  for (let i = 31, v = value; i >= 0; i -= 1, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function addressBytes(address: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i += 1) out[12 + i] = parseInt(address.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** EIP-712 digest of Invite(epoch, index); matches AntseedReferrals.inviteDigest. */
export function inviteDigest(epoch: number, index: number, chainId: number, verifyingContract: string): Uint8Array {
  const domainSeparator = keccak_256(concat(
    keccak_256(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
    keccak_256(utf8('AntseedReferrals')),
    keccak_256(utf8('1')),
    word(BigInt(chainId)),
    addressBytes(verifyingContract),
  ));
  const structHash = keccak_256(concat(
    keccak_256(utf8('Invite(uint256 issuedEpoch,uint256 index)')),
    word(BigInt(epoch)),
    word(BigInt(index)),
  ));
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));
}

/** The invite's signer, or null when it cannot be recovered. */
export function recoverInviter(
  invite: Invite,
  chainId = CHAIN_ID,
  verifyingContract = REFERRALS_ADDRESS,
): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(verifyingContract)) return null;
  try {
    const vs = BigInt(`0x${hex(invite.vs)}`);
    const s = vs & ((1n << 255n) - 1n);
    const signature = new secp256k1.Signature(BigInt(`0x${hex(invite.r)}`), s).addRecoveryBit(Number(vs >> 255n));
    const point = signature.recoverPublicKey(inviteDigest(invite.epoch, invite.index, chainId, verifyingContract));
    const publicKey = point.toRawBytes(false).slice(1);
    return `0x${hex(keccak_256(publicKey).slice(12))}`;
  } catch {
    return null;
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
