import { describe, expect, it, vi } from 'vitest';
import { FreeTierStakeResolver, type FreeTierStakePosition, type FreeTierStakeReader } from '../src/payments/free-tier-stake-resolver.js';

const ANTS = 10n ** 18n;
const BUYER = '0x' + '11'.repeat(20);
const OTHER_BUYER = '0x' + '22'.repeat(20);
const OPERATOR = '0x' + 'aa'.repeat(20);
const TIERS = [
  { minPower: 100, multiplier: 5 },
  { minPower: 1_000, multiplier: 'unlimited' as const },
];

function reader(
  positions: Record<string, FreeTierStakePosition[]>,
  operators: Record<string, string> = {},
  paidBuyers: string[] = [],
) {
  return {
    sellerAgentId: vi.fn(async () => 7),
    currentEpoch: vi.fn(async () => 3),
    stakerPositions: vi.fn(async (staker: string) => positions[staker] ?? []),
    operatorOf: vi.fn(async (buyer: string) => operators[buyer] ?? null),
    hasPaidUsage: vi.fn(async (buyer: string) => paidBuyers.includes(buyer)),
  } satisfies FreeTierStakeReader;
}

describe('FreeTierStakeResolver', () => {
  it('uses the buyer’s own stake and counts it on its positions, strongest first', async () => {
    const resolver = new FreeTierStakeResolver(reader({ [BUYER]: [{ id: 4, power: 50n * ANTS }, { id: 9, power: 100n * ANTS }] }), TIERS);
    expect(await resolver.resolve(BUYER)).toEqual({ owner: BUYER, power: 150n * ANTS, tier: TIERS[0], positionIds: [9, 4] });
  });

  it('shares the operator’s positions with buyers that have paid for usage', async () => {
    const r = reader(
      { [OPERATOR]: [{ id: 1, power: 2_000n * ANTS }] },
      { [BUYER]: OPERATOR, [OTHER_BUYER]: OPERATOR },
      [BUYER, OTHER_BUYER],
    );
    const resolver = new FreeTierStakeResolver(r, TIERS);
    expect(await resolver.resolve(BUYER)).toMatchObject({ owner: OPERATOR, positionIds: [1] });
    expect((await resolver.resolve(OTHER_BUYER))?.tier.multiplier).toBe('unlimited');
    // The operator's positions are read once and reused for its second buyer.
    expect(r.stakerPositions.mock.calls.filter(([staker]) => staker === OPERATOR)).toHaveLength(1);
  });

  it('ignores an operator a buyer named without ever paying for usage', async () => {
    const r = reader({ [OPERATOR]: [{ id: 1, power: 2_000n * ANTS }] }, { [BUYER]: OPERATOR });
    expect(await new FreeTierStakeResolver(r, TIERS).resolve(BUYER)).toBeNull();
    expect(r.stakerPositions).not.toHaveBeenCalledWith(OPERATOR, expect.anything(), expect.anything());
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
    const slow = reader({ [BUYER]: [{ id: 1, power: 150n * ANTS }] });
    slow.operatorOf = vi.fn(() => new Promise<string | null>(() => {}));
    const resolver = new FreeTierStakeResolver(slow, TIERS, { lookupTimeoutMs: 10 });
    expect(await resolver.resolve(BUYER)).toBeNull();
  });
});
