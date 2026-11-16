import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import {
  FREE_TIER_DELEGATION_TYPES,
  acceptFreeTierDelegationCode,
  decodeFreeTierDelegationCode,
  decodeFreeTierDelegationsHeader,
  encodeFreeTierDelegationCode,
  encodeFreeTierDelegationsHeader,
  isFreeTierDelegationSigned,
  freeTierDelegationMessage,
  makeFreeTierDelegationDomain,
  verifyFreeTierDelegations,
  withFreeTierDelegation,
  type FreeTierDelegation,
} from '../src/payments/free-tier-delegation.js';

const CHAIN_ID = 8453;
const BUYER = '0x' + '11'.repeat(20);
const OTHER_BUYER = '0x' + '22'.repeat(20);
const NOW_MS = 1_800_000_000_000;
const LATER = NOW_MS / 1000 + 86_400;

async function sign(staker: Pick<Wallet, 'address' | 'signTypedData'>, buyer: string, expiresAt: number, chainId = CHAIN_ID): Promise<FreeTierDelegation> {
  const unsigned = { staker: staker.address, buyer, expiresAt };
  const signature = await staker.signTypedData(makeFreeTierDelegationDomain(chainId), FREE_TIER_DELEGATION_TYPES, freeTierDelegationMessage(unsigned));
  return { ...unsigned, signature };
}

describe('free-tier delegations', () => {
  it('accepts signed, unexpired delegations to this buyer and survives the header round trip', async () => {
    const a = Wallet.createRandom();
    const b = Wallet.createRandom();
    const delegations = [await sign(a, BUYER, LATER), await sign(b, BUYER, LATER + 10)];
    const decoded = decodeFreeTierDelegationsHeader(encodeFreeTierDelegationsHeader(delegations), BUYER);
    expect(verifyFreeTierDelegations(decoded, BUYER, CHAIN_ID, NOW_MS)).toEqual([
      { staker: a.address.toLowerCase(), expiresAt: LATER },
      { staker: b.address.toLowerCase(), expiresAt: LATER + 10 },
    ]);
  });

  it('rejects a delegation replayed by another buyer, expired, from another chain, or signed by someone else', async () => {
    const staker = Wallet.createRandom();
    const forBuyer = await sign(staker, BUYER, LATER);
    // Another buyer sends the same signature: the seller binds it to that buyer's connection.
    const replayed = decodeFreeTierDelegationsHeader(encodeFreeTierDelegationsHeader([forBuyer]), OTHER_BUYER);
    expect(verifyFreeTierDelegations(replayed, OTHER_BUYER, CHAIN_ID, NOW_MS)).toEqual([]);

    expect(verifyFreeTierDelegations([await sign(staker, BUYER, NOW_MS / 1000 - 1)], BUYER, CHAIN_ID, NOW_MS)).toEqual([]);
    expect(verifyFreeTierDelegations([await sign(staker, BUYER, LATER, 1)], BUYER, CHAIN_ID, NOW_MS)).toEqual([]);

    const impostor = await sign(Wallet.createRandom(), BUYER, LATER);
    expect(verifyFreeTierDelegations([{ ...impostor, staker: staker.address }], BUYER, CHAIN_ID, NOW_MS)).toEqual([]);
  });

  it('skips malformed header entries and caps the count', async () => {
    const staker = Wallet.createRandom();
    const valid = encodeFreeTierDelegationsHeader([await sign(staker, BUYER, LATER)]);
    expect(decodeFreeTierDelegationsHeader(`garbage,${valid},0x12:1:0x34`, BUYER)).toHaveLength(1);
    expect(decodeFreeTierDelegationsHeader(Array(20).fill(valid).join(','), BUYER)).toHaveLength(8);
    expect(decodeFreeTierDelegationsHeader(undefined, BUYER)).toEqual([]);
  });

  it('round-trips a shareable code and rejects malformed ones', async () => {
    const staker = Wallet.createRandom();
    const delegation = await sign(staker, BUYER, LATER);
    const code = encodeFreeTierDelegationCode(delegation);
    expect(code).toMatch(/^antseed-free-tier-[A-Za-z0-9_-]+$/);
    const decoded = decodeFreeTierDelegationCode(`  ${code}\n`);
    expect(decoded).toEqual({ staker: staker.address, buyer: BUYER, expiresAt: LATER, signature: delegation.signature.toLowerCase() });
    expect(isFreeTierDelegationSigned(decoded, CHAIN_ID)).toBe(true);
    expect(() => decodeFreeTierDelegationCode('hello')).toThrow(/should start with/);
    expect(() => decodeFreeTierDelegationCode(code.slice(0, -10))).toThrow(/incomplete/);
    expect(() => decodeFreeTierDelegationCode('antseed-free-tier-@@')).toThrow(/malformed/);
  });

  it('accepts a pasted code only for this buyer, unexpired and signed, and replaces the same staker', async () => {
    const staker = Wallet.createRandom();
    const code = encodeFreeTierDelegationCode(await sign(staker, BUYER, LATER));
    const accepted = acceptFreeTierDelegationCode(code, BUYER, CHAIN_ID, NOW_MS);
    expect(accepted.staker).toBe(staker.address);
    expect(() => acceptFreeTierDelegationCode(code, OTHER_BUYER, CHAIN_ID, NOW_MS)).toThrow(/is for buyer/);
    expect(() => acceptFreeTierDelegationCode(code, BUYER, CHAIN_ID, (LATER + 1) * 1000)).toThrow(/expired/);
    expect(() => acceptFreeTierDelegationCode(code, BUYER, 1, NOW_MS)).toThrow(/not signed/);

    const renewed = { ...accepted, expiresAt: LATER + 100 };
    expect(withFreeTierDelegation([accepted], renewed)).toEqual([renewed]);
    const full = await Promise.all(Array.from({ length: 8 }, () => sign(Wallet.createRandom(), BUYER, LATER)));
    expect(() => withFreeTierDelegation(full, accepted)).toThrow(/already has 8/);
    expect(withFreeTierDelegation(full, { ...accepted, buyer: OTHER_BUYER })).toHaveLength(9);
  });
});
