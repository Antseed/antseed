import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREE_TIER_STAKE_TIERS,
  encodeFreeTierCapabilities,
  freeTierServiceScope,
  freeTierStakeTierForPower,
  normalizeFreeTierProgram,
  parseFreeTierProgram,
  parseServiceFreeTierProgram,
  powerToAntsEpochs,
} from '../src/payments/free-tier-program.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';

const ANTS = 10n ** 18n;

describe('free-tier program', () => {
  it('round-trips through capability strings that pass metadata validation', () => {
    const program = {
      base: { maxRequestsPerAddress: 1000, maxRequestsPerIp: null, windowMs: 3_600_000 },
      stakeTiers: [...DEFAULT_FREE_TIER_STAKE_TIERS],
    };
    const capabilities = encodeFreeTierCapabilities(program);
    expect(parseFreeTierProgram(['response-auth.v1', ...capabilities])).toEqual(program);
    for (const capability of capabilities) {
      expect(capability.length).toBeLessThanOrEqual(64);
      expect(capability).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    }
  });

  it('round-trips a service’s own stakers-only program within the capability limits', () => {
    const serviceId = 'qwen/qwen3.5-397b-a17b:free';
    const program = {
      base: { maxRequestsPerAddress: 1_000_000, maxRequestsPerIp: 1_000_000, windowMs: 604_800_000, stakersOnly: true },
      stakeTiers: [{ minPower: 10_400_000_000, multiplier: 10_000 }],
    };
    const capabilities = encodeFreeTierCapabilities(program, serviceId);
    expect(capabilities[0]).toMatch(new RegExp(`^free-tier\\.v1\\.${freeTierServiceScope(serviceId)}\\.base\\.`));
    for (const capability of capabilities) {
      expect(capability.length).toBeLessThanOrEqual(64);
      expect(capability).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    }
    expect(parseFreeTierProgram(capabilities, serviceId)).toEqual(program);
    // Another service, and the seller-wide lookup, do not see a scoped program.
    expect(parseFreeTierProgram(capabilities, 'other')).toBeNull();
    expect(parseFreeTierProgram(capabilities)).toBeNull();
  });

  it('fills inherited service tiers from the seller-wide program', () => {
    const sellerWide = { base: { maxRequestsPerAddress: 10, maxRequestsPerIp: null, windowMs: 86_400_000 }, stakeTiers: [...DEFAULT_FREE_TIER_STAKE_TIERS] };
    const own = { base: { maxRequestsPerAddress: 2, maxRequestsPerIp: null, windowMs: 86_400_000 }, stakeTiers: [...DEFAULT_FREE_TIER_STAKE_TIERS] };
    const scoped = encodeFreeTierCapabilities(own, 'm', { sellerWideTiers: sellerWide.stakeTiers });
    expect(scoped).toHaveLength(1);
    expect(parseFreeTierProgram([...encodeFreeTierCapabilities(sellerWide), ...scoped], 'm')).toEqual(own);
    // Without the seller-wide strings the inherited program cannot be read.
    expect(parseFreeTierProgram(scoped, 'm')).toBeNull();
  });

  it('reads only a service\'s own program for a priced service, never the seller-wide one', () => {
    const sellerWide = { base: { maxRequestsPerAddress: 10, maxRequestsPerIp: null, windowMs: 86_400_000 }, stakeTiers: [] };
    const own = { base: { maxRequestsPerAddress: 2, maxRequestsPerIp: null, windowMs: 86_400_000 }, stakeTiers: [] };
    const capabilities = [...encodeFreeTierCapabilities(sellerWide), ...encodeFreeTierCapabilities(own, 'k3')];
    expect(parseServiceFreeTierProgram(capabilities, 'k3')).toEqual(own);
    expect(parseServiceFreeTierProgram(capabilities, 'flash')).toBeNull();
    expect(parseFreeTierProgram(capabilities, 'flash')).toEqual(sellerWide);
    expect(parseServiceFreeTierProgram(undefined, 'k3')).toBeNull();
  });

  it('returns null without a base entry or with malformed tiers', () => {
    expect(parseFreeTierProgram(undefined)).toBeNull();
    expect(parseFreeTierProgram(['free-tier.v1.tier.p100.x5'])).toBeNull();
    expect(parseFreeTierProgram(['free-tier.v1.base.a1.w60000', 'free-tier.v1.tier.p100.xfive'])).toBeNull();
    expect(parseFreeTierProgram(['free-tier.v1.base.a1.w60000', 'free-tier.v1.tier.p100.x0', 'free-tier.v1.tier.p200.x5'])).toBeNull();
  });

  it('picks the highest tier the power reaches', () => {
    const tiers = DEFAULT_FREE_TIER_STAKE_TIERS;
    expect(freeTierStakeTierForPower(tiers, 519_999n * ANTS)).toBeNull();
    // 10k ANTS locked for 52 epochs.
    expect(freeTierStakeTierForPower(tiers, 10_000n * ANTS * 52n)?.multiplier).toBe(5);
    // 200k ANTS max-locked (104 epochs of power).
    expect(freeTierStakeTierForPower(tiers, 200_000n * ANTS * 104n)?.multiplier).toBe('unlimited');
    expect(powerToAntsEpochs(10_000n * ANTS * 52n + 5n)).toBe(520_000);
  });

  it('keeps metadata with the program capabilities valid', () => {
    const errors = validateMetadata({
      peerId: 'ab'.repeat(20),
      version: 12,
      providers: [],
      region: 'eu',
      timestamp: Date.now(),
      capabilities: encodeFreeTierCapabilities({
        base: { maxRequestsPerAddress: 5000, maxRequestsPerIp: 15000, windowMs: 86_400_000 },
        stakeTiers: [...DEFAULT_FREE_TIER_STAKE_TIERS],
      }),
      signature: '00'.repeat(65),
    } as never);
    expect(errors.filter((error) => error.field.startsWith('capabilities'))).toEqual([]);
  });

  it('normalizes a program passed on as JSON and rejects malformed ones', () => {
    const program = {
      base: { maxRequestsPerAddress: 1000, maxRequestsPerIp: null, windowMs: 86_400_000 },
      stakeTiers: [...DEFAULT_FREE_TIER_STAKE_TIERS],
    };
    expect(normalizeFreeTierProgram(JSON.parse(JSON.stringify(program)))).toEqual(program);
    expect(normalizeFreeTierProgram(null)).toBeNull();
    expect(normalizeFreeTierProgram({ ...program, base: { ...program.base, windowMs: 0 } })).toBeNull();
    expect(normalizeFreeTierProgram({ ...program, stakeTiers: [{ minPower: 10, multiplier: 1.5 }] })).toBeNull();
    expect(normalizeFreeTierProgram({ ...program, stakeTiers: [{ minPower: 10, multiplier: 'lots' }] })).toBeNull();
  });
});
