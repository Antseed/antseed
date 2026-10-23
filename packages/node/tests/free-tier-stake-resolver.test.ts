import { describe, expect, it, vi } from 'vitest';
import { FreeTierStakeResolver, type FreeTierStakePosition, type FreeTierStakeReader } from '../src/payments/free-tier-stake-resolver.js';

const ANTS = 10n ** 18n;
const BUYER = '0x' + '11'.repeat(20);
const STAKER_A = '0x' + 'aa'.repeat(20);
const STAKER_B = '0x' + 'bb'.repeat(20);
const TIERS = [
  { minPower: 100, multiplier: 5 },
  { minPower: 1_000, multiplier: 'unlimited' as const },
];

function reader(positions: Record<string, FreeTierStakePosition[]>) {
  return {
    sellerAgentId: vi.fn(async () => 7),
    currentEpoch: vi.fn(async () => 3),
    stakerPositions: vi.fn(async (staker: string) => positions[staker] ?? []),
  } satisfies FreeTierStakeReader;
}

describe('FreeTierStakeResolver', () => {
  it('uses the buyer’s own stake and counts it on its positions, strongest first', async () => {
    const resolver = new FreeTierStakeResolver(reader({ [BUYER]: [{ id: 4, power: 50n * ANTS }, { id: 9, power: 100n * ANTS }] }), TIERS);
    expect(await resolver.resolve(BUYER)).toEqual({ stakers: [BUYER], power: 150n * ANTS, tier: TIERS[0], positionIds: [9, 4] });
  });

  it('pools the buyer’s stake with every delegating staker’s', async () => {
    const r = reader({
      [BUYER]: [{ id: 1, power: 40n * ANTS }],
      [STAKER_A]: [{ id: 2, power: 500n * ANTS }],
      [STAKER_B]: [{ id: 3, power: 600n * ANTS }],
    });
    const resolver = new FreeTierStakeResolver(r, TIERS);
    // Neither staker alone reaches the unlimited tier; together they do.
    expect(await resolver.resolve(BUYER, [STAKER_A, STAKER_B])).toEqual({
      stakers: [BUYER, STAKER_A, STAKER_B],
      power: 1_140n * ANTS,
      tier: TIERS[1],
      positionIds: [3, 2, 1],
    });
  });

  it('counts only the positions it charges toward the tier', async () => {
    const strong = Array.from({ length: 64 }, (_, i) => ({ id: 100 + i, power: 15n * ANTS }));
    const weak = Array.from({ length: 14 }, (_, i) => ({ id: 200 + i, power: 9n * ANTS }));
    const resolver = new FreeTierStakeResolver(reader({ [STAKER_A]: strong, [STAKER_B]: weak }), TIERS);
    // All 78 positions would reach the unlimited tier, but only the strongest 64 are charged.
    const standing = await resolver.resolve(BUYER, [STAKER_A, STAKER_B]);
    expect(standing).toMatchObject({ power: 960n * ANTS, tier: TIERS[0] });
    expect(standing?.positionIds).toEqual(strong.map((position) => position.id));
  });

  it('counts a position once even when two stakers report it', async () => {
    const shared = { id: 5, power: 80n * ANTS };
    const resolver = new FreeTierStakeResolver(reader({ [STAKER_A]: [shared], [STAKER_B]: [shared] }), TIERS);
    expect(await resolver.resolve(BUYER, [STAKER_A, STAKER_B])).toBeNull();
  });

  it('reads each staker once across buyers it delegates to', async () => {
    const r = reader({ [STAKER_A]: [{ id: 2, power: 2_000n * ANTS }] });
    const resolver = new FreeTierStakeResolver(r, TIERS);
    expect((await resolver.resolve(BUYER, [STAKER_A]))?.positionIds).toEqual([2]);
    expect((await resolver.resolve('0x' + '22'.repeat(20), [STAKER_A]))?.tier.multiplier).toBe('unlimited');
    expect(r.stakerPositions.mock.calls.filter(([staker]) => staker === STAKER_A)).toHaveLength(1);
  });

  it('returns null below the first tier, without an agent id, and on read failures', async () => {
    expect(await new FreeTierStakeResolver(reader({ [BUYER]: [{ id: 1, power: 99n * ANTS }] }), TIERS).resolve(BUYER)).toBeNull();

    const unregistered = reader({ [BUYER]: [{ id: 1, power: 5_000n * ANTS }] });
    unregistered.sellerAgentId = vi.fn(async () => 0);
    expect(await new FreeTierStakeResolver(unregistered, TIERS).resolve(BUYER)).toBeNull();

    const failing = reader({});
    failing.stakerPositions = vi.fn(async () => { throw new Error('rpc down'); });
    expect(await new FreeTierStakeResolver(failing, TIERS).resolve(BUYER)).toBeNull();
  });

  it('caches standings for the TTL', async () => {
    let now = 0;
    const r = reader({ [BUYER]: [{ id: 1, power: 150n * ANTS }] });
    const resolver = new FreeTierStakeResolver(r, TIERS, { cacheTtlMs: 1_000, now: () => now });
    await resolver.resolve(BUYER);
    await resolver.resolve(BUYER);
    expect(r.stakerPositions).toHaveBeenCalledTimes(1);
    now = 1_001;
    await resolver.resolve(BUYER);
    expect(r.stakerPositions).toHaveBeenCalledTimes(2);
  });

  it('falls back to base limits when the lookup is slow', async () => {
    const slow = reader({});
    slow.currentEpoch = vi.fn(() => new Promise<number>(() => {}));
    const resolver = new FreeTierStakeResolver(slow, TIERS, { lookupTimeoutMs: 10 });
    expect(await resolver.resolve(BUYER)).toBeNull();
  });
});
