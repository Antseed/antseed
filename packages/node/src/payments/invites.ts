import { Signature, TypedDataEncoder, getBytes, hexlify, recoverAddress, zeroPadValue } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { INVITE_TYPES, makeReferralsDomain, type ReferralInvite } from '@antseed/protocol/signatures';
import type { InviteFailure, ReferralsClient } from './evm/referrals-client.js';

/**
 * Referral invites (AntseedReferrals). A referrer issues one off-chain by
 * signing the EIP-712 `Invite(uint256 issuedEpoch,uint256 index)`; the buyer
 * carries it in its signed settlement metadata until AntseedStatsV2 binds it.
 *
 * Shareable form: base64url (RFC 4648 §5, no padding) of 68 bytes,
 *
 *   byte  0      format version (1)
 *   bytes 1-2    issued epoch, uint16 big-endian
 *   byte  3      index, uint8
 *   bytes 4-35   r
 *   bytes 36-67  vs (EIP-2098 compact: s with the y-parity in the top bit)
 *
 * 91 characters, URL-safe, shared as https://antseed.com/invite/<invite> or
 * antseed://invite/<invite>. The referrer is not in the string: it is
 * recovered from the signature with the chain's referrals contract.
 */

/** Epochs an invite stays usable, counting its issue epoch (AntseedReferrals.INVITE_VALIDITY_EPOCHS). */
export const INVITE_VALIDITY_EPOCHS = 4;
/** Epochs after the binding in which the referee earns its half (AntseedAttributionUsage.REFEREE_BONUS_EPOCHS). */
export const REFEREE_BONUS_EPOCHS = 12;
export const INVITE_LINK_BASE = 'https://antseed.com/invite/';
export const INVITE_DEEP_LINK_BASE = 'antseed://invite/';

const INVITE_FORMAT_VERSION = 1;
const INVITE_BYTES = 68;

export interface InviteDomain {
  /** EVM chain id (8453 on Base mainnet). */
  chainId: number;
  /** AntseedReferrals contract address. */
  referralsAddress: string;
}

/** EIP-712 digest a referrer signs to issue invite (epoch, index); matches `inviteDigest` on-chain. */
export function inviteDigest(domain: InviteDomain, epoch: number | bigint, index: number | bigint): string {
  return TypedDataEncoder.hash(
    makeReferralsDomain(domain.chainId, domain.referralsAddress),
    INVITE_TYPES,
    { issuedEpoch: BigInt(epoch), index: BigInt(index) },
  );
}

/** Sign invite (epoch, index) with the referrer's wallet as an EIP-2098 compact signature. */
export async function signInvite(
  signer: AbstractSigner,
  domain: InviteDomain,
  epoch: number | bigint,
  index: number | bigint,
): Promise<ReferralInvite> {
  const signature = Signature.from(await signer.signTypedData(
    makeReferralsDomain(domain.chainId, domain.referralsAddress),
    INVITE_TYPES,
    { issuedEpoch: BigInt(epoch), index: BigInt(index) },
  ));
  return { epoch: BigInt(epoch), index: BigInt(index), r: signature.r, vs: signature.yParityAndS };
}

/** The invite's signer (the referrer), or null for a malformed signature. */
export function recoverInviter(invite: ReferralInvite, domain: InviteDomain): string | null {
  try {
    return recoverAddress(inviteDigest(domain, invite.epoch, invite.index), { r: invite.r, yParityAndS: invite.vs });
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The shareable invite string (see the module comment for the layout). */
export function encodeInvite(invite: ReferralInvite): string {
  if (invite.epoch < 0n || invite.epoch > 0xffffn) throw new Error('Invite epoch out of range.');
  if (invite.index < 0n || invite.index > 0xffn) throw new Error('Invite index out of range.');
  const bytes = new Uint8Array(INVITE_BYTES);
  bytes[0] = INVITE_FORMAT_VERSION;
  bytes[1] = Number(invite.epoch >> 8n);
  bytes[2] = Number(invite.epoch & 0xffn);
  bytes[3] = Number(invite.index);
  bytes.set(getBytes(zeroPadValue(invite.r, 32)), 4);
  bytes.set(getBytes(zeroPadValue(invite.vs, 32)), 36);
  return toBase64Url(bytes);
}

/**
 * Parse an invite string or any link that ends in one
 * (https://antseed.com/invite/<invite>, antseed://invite/<invite>).
 * Throws "Not a valid invite." for anything else.
 */
export function decodeInvite(value: string): ReferralInvite {
  const raw = value.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? '';
  let bytes: Uint8Array;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('charset');
    bytes = fromBase64Url(raw);
  } catch {
    throw new Error('Not a valid invite.');
  }
  if (bytes.length !== INVITE_BYTES || bytes[0] !== INVITE_FORMAT_VERSION) throw new Error('Not a valid invite.');
  return {
    epoch: BigInt((bytes[1]! << 8) | bytes[2]!),
    index: BigInt(bytes[3]!),
    r: hexlify(bytes.slice(4, 36)),
    vs: hexlify(bytes.slice(36, 68)),
  };
}

export function inviteLink(invite: ReferralInvite | string): string {
  return `${INVITE_LINK_BASE}${typeof invite === 'string' ? invite : encodeInvite(invite)}`;
}

/** First epoch in which the invite no longer binds. */
export function inviteExpiryEpoch(invite: Pick<ReferralInvite, 'epoch'>): number {
  return Number(invite.epoch) + INVITE_VALIDITY_EPOCHS;
}

/** Short, user-facing reason an invite cannot be redeemed. */
export function inviteFailureMessage(failure: InviteFailure): string {
  switch (failure) {
    case 'InviteNotActive': return 'This invite has expired or is not active yet.';
    case 'InviteAlreadyUsed': return 'This invite was already used.';
    case 'InviteOverQuota': return 'The inviter is over their invite limit for that week.';
    case 'SelfReferral': return 'You cannot use your own invite.';
    case 'NotNewBuyer': return 'Invites are for new wallets only.';
    case 'ReferralAlreadyBound': return 'This wallet already has an inviter.';
    case 'InvalidInviteSignature': return 'This invite is not valid.';
    default: return 'This invite cannot be used.';
  }
}

export type InviteCheck =
  | { ok: true; invite: ReferralInvite; encoded: string; referrer: string }
  | { ok: false; reason: string; failure?: InviteFailure; referrer?: string };

/**
 * Decode `value` and run `previewInvite` for `buyer`. Returns the canonical
 * invite string and its referrer, or the reason it would not bind.
 */
export async function checkInvite(
  client: Pick<ReferralsClient, 'previewInvite'>,
  buyer: string,
  value: string,
): Promise<InviteCheck> {
  let invite: ReferralInvite;
  try {
    invite = decodeInvite(value);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const { referrer, failure } = await client.previewInvite(buyer, invite);
  if (failure) return { ok: false, reason: inviteFailureMessage(failure), failure, ...(referrer ? { referrer } : {}) };
  return { ok: true, invite, encoded: encodeInvite(invite), referrer };
}

/**
 * A random index below `quota` that is neither used on-chain nor already
 * handed out from this install; null when the epoch's invites are exhausted.
 *
 * Random rather than lowest-first: the same wallet may issue from several
 * installs (CLI, Desktop, dashboard) that share no state, and an index
 * handed out but not yet redeemed is invisible on-chain. Lowest-first would
 * give every install the same invite; a random free index makes two installs
 * collide only by chance (1 in the number of free indices).
 */
export function nextInviteIndex(quota: number, taken: Iterable<number>, random: () => number = Math.random): number | null {
  const skip = new Set(taken);
  const free: number[] = [];
  for (let index = 0; index < quota; index += 1) if (!skip.has(index)) free.push(index);
  if (free.length === 0) return null;
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))]!;
}
