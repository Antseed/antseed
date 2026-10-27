import { describe, expect, it } from 'vitest';
import { describeFreeTierLimit, readFreeTierLimit } from './peer-error-response.js';

describe('free-tier limits', () => {
  it('reads a stakers-only refusal and says how much stake unlocks the model', () => {
    const limit = readFreeTierLimit({
      limitedBy: 'stake_required',
      limit: 0,
      windowMs: 86_400_000,
      retryAfterSeconds: 86_400,
      stakersOnly: true,
      baseLimit: 40,
      stakeTiers: [{ minPower: 520_000, multiplier: 5 }],
      stakePower: 0,
    });
    expect(limit).toMatchObject({ limitedBy: 'stake_required', limit: 0, baseLimit: 40, stakersOnly: true });
    expect(describeFreeTierLimit(limit!)).toBe(
      'This model is free only for buyers staked on this seller. ' +
      'Stake ANTS in its pool to use it: 10,000 ANTS locked for a year gives 200 free requests per day.',
    );
  });

  it('still describes an exhausted base allowance with its reset and next tier', () => {
    const limit = readFreeTierLimit({
      limitedBy: 'ip',
      limit: 3,
      windowMs: 86_400_000,
      retryAfterSeconds: 60,
      stakeTiers: [{ minPower: 520_000, multiplier: 5 }],
    });
    // Older sellers don't send baseLimit: the tier is named by its multiplier.
    expect(limit).toMatchObject({ baseLimit: null, stakersOnly: false });
    expect(describeFreeTierLimit(limit!)).toBe(
      'Free limit reached on this seller for your IP address (3 requests per day). It resets in 60s. ' +
      "Stake ANTS in this seller's pool to raise it: 10,000 ANTS locked for a year gives 5× the free limit.",
    );
  });
});
