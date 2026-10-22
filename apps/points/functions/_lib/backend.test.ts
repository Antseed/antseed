import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { KV } from './env';
import { cookie, pkceChallenge, readCookie, sign, verify } from './session';
import { getLink, getX, getXByHandle, link, unlink, upsertX } from './store';
import { checkLink, linkMessage, LINK_MAX_AGE_MS } from './verify';
import { safeReturn } from '../api/auth/x/start';

function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

const alice = { xId: '111', handle: 'alice', name: 'Alice', avatar: 'https://pbs.twimg.com/a_400x400.jpg' };
const bob = { xId: '222', handle: 'bob', name: 'Bob', avatar: '' };
// Well-known test keys (anvil accounts 0 and 1), never funded on mainnet.
const buyer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const rewardWallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

describe('signed cookies', () => {
  it('round-trips and rejects tampering, wrong secrets and expiry', async () => {
    const now = 1_800_000_000;
    const token = await sign({ ...alice, exp: now + 60 }, 's3cret');
    expect(await verify(token, 's3cret', now)).toMatchObject(alice);
    expect(await verify(token, 'other', now)).toBeNull();
    expect(await verify(token, 's3cret', now + 61)).toBeNull();
    const [body, mac] = token.split('.');
    const forged = btoa(JSON.stringify({ ...alice, handle: 'mallory', exp: now + 60 })).replace(/=+$/, '');
    expect(await verify(`${forged}.${mac}`, 's3cret', now)).toBeNull();
    expect(await verify(`${body}.`, 's3cret', now)).toBeNull();
    expect(await verify(null, 's3cret', now)).toBeNull();
  });

  it('reads a cookie back out of the header', () => {
    const set = cookie('ap_session', 'a.b', 60);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    const req = new Request('https://x.test/', { headers: { cookie: `foo=1; ap_session=${encodeURIComponent('a.b')}` } });
    expect(readCookie(req, 'ap_session')).toBe('a.b');
    expect(readCookie(req, 'missing')).toBeNull();
  });

  it('makes the RFC 7636 PKCE challenge', async () => {
    // Test vector from RFC 7636 appendix B.
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('only returns to same-site paths after sign-in', () => {
    expect(safeReturn('/leaderboard')).toBe('/leaderboard');
    expect(safeReturn('//evil.example')).toBe('/me');
    expect(safeReturn('https://evil.example')).toBe('/me');
    expect(safeReturn(null)).toBe('/me');
  });
});

describe('wallet link signatures', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const issuedAt = new Date(now - 60_000).toISOString();
  const noOperator = async () => null;

  it('accepts a signature from the wallet itself', async () => {
    const signature = await buyer.signMessage({ message: linkMessage({ ...alice, address: buyer.address, issuedAt }) });
    expect(await checkLink({ address: buyer.address, issuedAt, signature }, alice, noOperator, now)).toEqual({ ok: true, signer: buyer.address });
  });

  it("accepts a signature from the wallet's reward wallet (Deposits operator)", async () => {
    const signature = await rewardWallet.signMessage({ message: linkMessage({ ...alice, address: buyer.address, issuedAt }) });
    const res = await checkLink({ address: buyer.address, issuedAt, signature }, alice, async () => rewardWallet.address, now);
    expect(res).toEqual({ ok: true, signer: rewardWallet.address });
  });

  it('rejects other signers, other X accounts and stale signatures', async () => {
    const forBuyer = linkMessage({ ...alice, address: buyer.address, issuedAt });
    const wrongSigner = await rewardWallet.signMessage({ message: forBuyer });
    expect((await checkLink({ address: buyer.address, issuedAt, signature: wrongSigner }, alice, noOperator, now)).ok).toBe(false);

    // A signature made for @alice can't be replayed by @bob's session.
    const good = await buyer.signMessage({ message: forBuyer });
    expect((await checkLink({ address: buyer.address, issuedAt, signature: good }, bob, noOperator, now)).ok).toBe(false);

    const old = new Date(now - LINK_MAX_AGE_MS - 1000).toISOString();
    const stale = await buyer.signMessage({ message: linkMessage({ ...alice, address: buyer.address, issuedAt: old }) });
    expect(await checkLink({ address: buyer.address, issuedAt: old, signature: stale }, alice, noOperator, now)).toMatchObject({ ok: false });

    expect(await checkLink({ address: 'nope', issuedAt, signature: good }, alice, noOperator, now)).toMatchObject({ ok: false });
  });
});

describe('profile store', () => {
  const a1 = '0x00000000000000000000000000000000000000A1';
  const a2 = '0x00000000000000000000000000000000000000a2';

  it('links wallets to an X account and finds them by address and handle', async () => {
    const kv = memoryKV();
    await upsertX(kv, alice);
    await link(kv, alice, a1, a1);
    await link(kv, alice, a2, '0xsigner');
    expect((await getLink(kv, a1.toLowerCase()))?.handle).toBe('alice');
    expect((await getXByHandle(kv, '@Alice'))?.addresses).toEqual([a1.toLowerCase(), a2]);
  });

  it('moves a wallet to the newest X account that proves it', async () => {
    const kv = memoryKV();
    await link(kv, alice, a1, a1);
    await link(kv, bob, a1, a1);
    expect((await getLink(kv, a1))?.handle).toBe('bob');
    expect((await getX(kv, alice.xId))?.addresses).toEqual([]);
    expect((await getX(kv, bob.xId))?.addresses).toEqual([a1.toLowerCase()]);
  });

  it('follows handle changes and only lets the owner unlink', async () => {
    const kv = memoryKV();
    await link(kv, alice, a1, a1);
    await upsertX(kv, { ...alice, handle: 'alice_new', name: 'Alice N' });
    expect(await getXByHandle(kv, 'alice')).toBeNull();
    expect((await getLink(kv, a1))?.handle).toBe('alice_new');

    expect(await unlink(kv, bob.xId, a1)).toBe(false);
    expect(await unlink(kv, alice.xId, a1)).toBe(true);
    expect(await getLink(kv, a1)).toBeNull();
    expect((await getX(kv, alice.xId))?.addresses).toEqual([]);
  });
});
