import { describe, expect, it } from 'vitest';
import { Wallet, zeroPadValue } from 'ethers';
import {
  checkInvite,
  decodeInvite,
  encodeInvite,
  inviteDigest,
  inviteExpiryEpoch,
  inviteLink,
  nextInviteIndex,
  recoverInviter,
  signInvite,
} from '../src/payments/invites.js';
import { inviteFailureOf } from '../src/payments/evm/referrals-client.js';

// Fixed vector from packages/contracts (AntseedReferralsTest.test_inviteSignatureVector).
const DOMAIN = { chainId: 8453, referralsAddress: '0x1111111111111111111111111111111111111111' };
const KEY = zeroPadValue('0x0a11ce', 32);
const REFERRER = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7';
const VECTOR = {
  epoch: 42n,
  index: 7n,
  r: '0xd802ee5a16750afbabae3b72ff1d3fd4b0e020078f532d083845ef4abd2c8eda',
  vs: '0x446c5c2a3057d6654b49e84d192c62a787ff15082d4748ae083e366b78e80755',
};

describe('referral invites', () => {
  it('signs the contract vector', async () => {
    const wallet = new Wallet(KEY);
    expect(wallet.address).toBe(REFERRER);
    expect(inviteDigest(DOMAIN, 42, 7)).toBe('0x23a154885f1032c2161dc1e68d05535b819dbdeb17a51793c019bdfe30d4b4c9');
    expect(await signInvite(wallet, DOMAIN, 42, 7)).toEqual(VECTOR);
    expect(recoverInviter(VECTOR, DOMAIN)).toBe(REFERRER);
    expect(recoverInviter(VECTOR, { ...DOMAIN, chainId: 84532 })).not.toBe(REFERRER);
  });

  it('round-trips the 91-character shareable form and its links', () => {
    const encoded = encodeInvite(VECTOR);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{91}$/);
    expect(decodeInvite(encoded)).toEqual(VECTOR);
    expect(inviteLink(VECTOR)).toBe(`https://antseed.com/invite/${encoded}`);
    expect(decodeInvite(inviteLink(encoded))).toEqual(VECTOR);
    expect(decodeInvite(`antseed://invite/${encoded}/`)).toEqual(VECTOR);
    expect(decodeInvite(`  https://antseed.com/invite/${encoded}?utm=x  `)).toEqual(VECTOR);
    expect(inviteExpiryEpoch(VECTOR)).toBe(46);
  });

  it('rejects anything that is not an invite', () => {
    const encoded = encodeInvite(VECTOR);
    for (const bad of ['', 'hello', encoded.slice(1), `${encoded}AA`, encoded.replace(/^./, 'B'), '0x1111111111111111111111111111111111111111']) {
      expect(() => decodeInvite(bad)).toThrow('Not a valid invite.');
    }
    expect(() => encodeInvite({ ...VECTOR, epoch: 70_000n })).toThrow();
    expect(() => encodeInvite({ ...VECTOR, index: 256n })).toThrow();
  });

  it('maps previewInvite selectors to reasons', async () => {
    expect(inviteFailureOf('0x00000000')).toBeNull();
    expect(inviteFailureOf('0xdeadbeef')).toBe('Unknown');
    const preview = async () => ({ referrer: REFERRER, failure: 'InviteAlreadyUsed' as const });
    expect(await checkInvite({ previewInvite: preview }, REFERRER, encodeInvite(VECTOR))).toEqual({
      ok: false, reason: 'This invite was already used.', failure: 'InviteAlreadyUsed', referrer: REFERRER,
    });
    expect(await checkInvite({ previewInvite: async () => ({ referrer: REFERRER, failure: null }) }, REFERRER, inviteLink(VECTOR)))
      .toEqual({ ok: true, invite: VECTOR, encoded: encodeInvite(VECTOR), referrer: REFERRER });
    expect(await checkInvite({ previewInvite: preview }, REFERRER, 'nope')).toEqual({ ok: false, reason: 'Not a valid invite.' });
  });

  it('picks a random free index under the quota', () => {
    expect(nextInviteIndex(3, [], () => 0)).toBe(0);
    expect(nextInviteIndex(3, [], () => 0.999)).toBe(2);
    expect(nextInviteIndex(5, [0, 2, 3], () => 0.6)).toBe(4);
    expect(nextInviteIndex(3, [0, 2])).toBe(1);
    expect(nextInviteIndex(3, [0, 1, 2])).toBeNull();
    expect(nextInviteIndex(0, [])).toBeNull();
    const seen = new Set(Array.from({ length: 200 }, () => nextInviteIndex(20, [])));
    expect(seen.size).toBeGreaterThan(10);
  });
});
