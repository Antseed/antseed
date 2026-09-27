import { describe, expect, it } from 'vitest';
import { matchReferral, normalizeReferrer, recordReferralDownload } from './referrals';

const ALICE = `0x${'11'.repeat(20)}`;
const BOB = `0x${'22'.repeat(20)}`;

class MemoryStore {
  values = new Map<string, string>();
  get(key: string) { return Promise.resolve(this.values.get(key) ?? null); }
  put(key: string, value: string) { this.values.set(key, value); return Promise.resolve(); }
}

function request(ip: string) {
  return new Request('https://download.antseed.com/referral/match', { headers: { 'cf-connecting-ip': ip } });
}

describe('referral attribution', () => {
  it('normalizes wallet addresses', () => {
    expect(normalizeReferrer(` ${ALICE.toUpperCase().replace('0X', '0x')} `)).toBe(ALICE);
    expect(normalizeReferrer('alice')).toBeNull();
  });

  it('matches only the same HMACed network without storing the raw IP', async () => {
    const store = new MemoryStore();
    const env = { REFERRAL_ATTRIBUTION: store, REFERRAL_HASH_SECRET: 'test-secret' };
    await recordReferralDownload(request('203.0.113.8'), env, ALICE, 1_000);

    const matched = await matchReferral(request('203.0.113.8'), env, 2_000);
    expect(await matched.json()).toMatchObject({ match: { referrer: ALICE, confidence: 'probable' } });
    expect([...store.values.keys()].join(' ')).not.toContain('203.0.113.8');

    const missed = await matchReferral(request('203.0.113.9'), env, 2_000);
    expect(await missed.json()).toEqual({ match: null });
  });

  it('lowers confidence when a shared network downloaded different referrals', async () => {
    const store = new MemoryStore();
    const env = { REFERRAL_ATTRIBUTION: store, REFERRAL_HASH_SECRET: 'test-secret' };
    const sameNetwork = request('198.51.100.4');
    await recordReferralDownload(sameNetwork, env, ALICE, 1_000);
    await recordReferralDownload(sameNetwork, env, BOB, 2_000);
    const response = await matchReferral(sameNetwork, env, 3_000);
    expect(await response.json()).toMatchObject({ match: { referrer: BOB, confidence: 'low' } });
  });
});
