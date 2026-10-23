import { describe, expect, it, vi } from 'vitest';
import { FreeTierStakeResolver, type FreeTierStakeReader } from '../src/payments/free-tier-stake-resolver.js';

const ANTS = 10n ** 18n;
const BUYER = '0x' + '11'.repeat(20);
const OTHER_BUYER = '0x' + '22'.repeat(20);
const OPERATOR = '0x' + 'aa'.repeat(20);
const TIERS = [
  { minPower: 100, multiplier: 5 },
  { minPower: 1_000, multiplier: 'unlimited' as const },
];

function reader(powers: Record<string, bigint>, operators: Record<string, string> = {}): FreeTierStakeReader & { stakerPower: ReturnType<typeof vi.fn> } {
  return {
    sellerAgentId: vi.fn(async () => 7),
    currentEpoch: vi.fn(async () => 3),
    stakerPower: vi.fn(async (staker: string) => powers[staker] ?? 0n),
    operatorOf: vi.fn(async (buyer: string) => operators[buyer] ?? null),
  };
}

describe('FreeTierStakeResolver', () => {
  it('uses the buyer’s own stake', async () => {
    const resolver = new FreeTierStakeResolver(reader({ [BUYER]: 150n * ANTS }), TIERS);
    expect(await resolver.resolve(BUYER)).toEqual({ owner: BUYER, power: 150n * ANTS, tier: TIERS[0] });
  });

  it('makes the operator the shared owner for all of its buyers', async () => {
    const r = reader({ [OPERATOR]: 2_000n * ANTS }, { [BUYER]: OPERATOR, [OTHER_BUYER]: OPERATOR });
    const resolver = new FreeTierStakeResolver(r, TIERS);
    expect((await resolver.resolve(BUYER))?.owner).toBe(OPERATOR);
    expect((await resolver.resolve(OTHER_BUYER))?.tier.multiplier).toBe('unlimited');
    // The operator's power is read once and reused for its second buyer.
    expect(r.stakerPower.mock.calls.filter(([staker]) => staker === OPERATOR)).toHaveLength(1);
  });

  it('returns null below the first tier, without an agent id, and on read failures', async () => {
    expect(await new FreeTierStakeResolver(reader({ [BUYER]: 99n * ANTS }), TIERS).resolve(BUYER)).toBeNull();

    const unregistered = reader({ [BUYER]: 5_000n * ANTS });
    unregistered.sellerAgentId = vi.fn(async () => 0);
    expect(await new FreeTierStakeResolver(unregistered, TIERS).resolve(BUYER)).toBeNull();

    const failing = reader({});
    failing.stakerPower = vi.fn(async () => { throw new Error('rpc down'); });
    expect(await new FreeTierStakeResolver(failing, TIERS).resolve(BUYER)).toBeNull();
  });

  it('caches standings for the TTL', async () => {
    let now = 0;
    const r = reader({ [BUYER]: 150n * ANTS });
    const resolver = new FreeTierStakeResolver(r, TIERS, { cacheTtlMs: 1_000, now: () => now });
    await resolver.resolve(BUYER);
    await resolver.resolve(BUYER);
    expect(r.stakerPower).toHaveBeenCalledTimes(1);
    now = 1_001;
    await resolver.resolve(BUYER);
    expect(r.stakerPower).toHaveBeenCalledTimes(2);
  });

  it('falls back to base limits when the lookup is slow', async () => {
    const slow = reader({ [BUYER]: 150n * ANTS });
    slow.operatorOf = () => new Promise(() => {});
    const resolver = new FreeTierStakeResolver(slow, TIERS, { lookupTimeoutMs: 10 });
    expect(await resolver.resolve(BUYER)).toBeNull();
  });
});
