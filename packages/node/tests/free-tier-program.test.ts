import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREE_TIER_STAKE_TIERS,
  encodeFreeTierCapabilities,
  freeTierStakeTierForPower,
  parseFreeTierProgram,
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
});
