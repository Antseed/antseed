import { describe, expect, it, vi } from 'vitest';
import { FreeTierStakeResolver, type FreeTierStakePosition, type FreeTierStakeReader } from '../src/payments/free-tier-stake-resolver.js';

const ANTS = 10n ** 18n;
const BUYER = '0x' + '11'.repeat(20);
const STAKER_A = '0x' + 'aa'.repeat(20);
const STAKER_B = '0x' + 'bb'.repeat(20);

function reader(positions: Record<string, FreeTierStakePosition[]>) {
  return {
    sellerAgentId: vi.fn(async () => 7),
    currentEpoch: vi.fn(async () => 3),
    stakerPositions: vi.fn(async (staker: string) => positions[staker] ?? []),
  } satisfies FreeTierStakeReader;
}

describe('FreeTierStakeResolver', () => {
  it('uses the buyer’s own stake and counts it on its positions, strongest first', async () => {
    const resolver = new FreeTierStakeResolver(reader({ [BUYER]: [{ id: 4, power: 50n * ANTS }, { id: 9, power: 100n * ANTS }] }));
    expect(await resolver.resolve(BUYER)).toEqual({ stakers: [BUYER], power: 150n * ANTS, positionIds: [9, 4] });
  });

  it('pools the buyer’s stake with every delegating staker’s', async () => {
    const r = reader({
      [BUYER]: [{ id: 1, power: 40n * ANTS }],
      [STAKER_A]: [{ id: 2, power: 500n * ANTS }],
      [STAKER_B]: [{ id: 3, power: 600n * ANTS }],
    });
    const resolver = new FreeTierStakeResolver(r);
    expect(await resolver.resolve(BUYER, [STAKER_A, STAKER_B])).toEqual({
      stakers: [BUYER, STAKER_A, STAKER_B],
      power: 1_140n * ANTS,
      positionIds: [3, 2, 1],
    });
  });

  it('counts only the positions it charges toward a tier', async () => {
    const strong = Array.from({ length: 64 }, (_, i) => ({ id: 100 + i, power: 15n * ANTS }));
    const weak = Array.from({ length: 14 }, (_, i) => ({ id: 200 + i, power: 9n * ANTS }));
    const resolver = new FreeTierStakeResolver(reader({ [STAKER_A]: strong, [STAKER_B]: weak }));
    // All 78 positions hold 1,086 power, but only the strongest 64 are charged.
    const standing = await resolver.resolve(BUYER, [STAKER_A, STAKER_B]);
    expect(standing).toMatchObject({ power: 960n * ANTS });
    expect(standing?.positionIds).toEqual(strong.map((position) => position.id));
  });

  it('counts a position once even when two stakers report it', async () => {
    const shared = { id: 5, power: 80n * ANTS };
    const resolver = new FreeTierStakeResolver(reader({ [STAKER_A]: [shared], [STAKER_B]: [shared] }));
    expect(await resolver.resolve(BUYER, [STAKER_A, STAKER_B])).toMatchObject({ power: 80n * ANTS, positionIds: [5] });
  });

  it('reads each staker once across buyers it delegates to', async () => {
    const r = reader({ [STAKER_A]: [{ id: 2, power: 2_000n * ANTS }] });
    const resolver = new FreeTierStakeResolver(r);
    expect((await resolver.resolve(BUYER, [STAKER_A]))?.positionIds).toEqual([2]);
    expect((await resolver.resolve('0x' + '22'.repeat(20), [STAKER_A]))?.power).toBe(2_000n * ANTS);
    expect(r.stakerPositions.mock.calls.filter(([staker]) => staker === STAKER_A)).toHaveLength(1);
  });

  it('returns null without stake, without an agent id, and on read failures', async () => {
    expect(await new FreeTierStakeResolver(reader({ [BUYER]: [] })).resolve(BUYER)).toBeNull();
    expect(await new FreeTierStakeResolver(reader({ [BUYER]: [{ id: 1, power: 0n }] })).resolve(BUYER)).toBeNull();

    const unregistered = reader({ [BUYER]: [{ id: 1, power: 5_000n * ANTS }] });
    unregistered.sellerAgentId = vi.fn(async () => 0);
    expect(await new FreeTierStakeResolver(unregistered).resolve(BUYER)).toBeNull();

    const failing = reader({});
    failing.stakerPositions = vi.fn(async () => { throw new Error('rpc down'); });
    expect(await new FreeTierStakeResolver(failing).resolve(BUYER)).toBeNull();
  });

  it('caches standings for the TTL', async () => {
    let now = 0;
    const r = reader({ [BUYER]: [{ id: 1, power: 150n * ANTS }] });
    const resolver = new FreeTierStakeResolver(r, { cacheTtlMs: 1_000, now: () => now });
    await resolver.resolve(BUYER);
    await resolver.resolve(BUYER);
    expect(r.stakerPositions).toHaveBeenCalledTimes(1);
    now = 1_001;
    await resolver.resolve(BUYER);
    expect(r.stakerPositions).toHaveBeenCalledTimes(2);
  });

  it('expires a standing with the stake snapshot it was built from', async () => {
    let now = 0;
    const holdings: Record<string, FreeTierStakePosition[]> = { [STAKER_A]: [{ id: 2, power: 2_000n * ANTS }] };
    const r = reader(holdings);
    const resolver = new FreeTierStakeResolver(r, { cacheTtlMs: 1_000, now: () => now });
    const otherBuyer = '0x' + '22'.repeat(20);
    expect((await resolver.resolve(BUYER, [STAKER_A]))?.power).toBe(2_000n * ANTS);
    holdings[STAKER_A] = [];
    // A second buyer resolves from the staker's snapshot read at time 0 ...
    now = 900;
    expect((await resolver.resolve(otherBuyer, [STAKER_A]))?.power).toBe(2_000n * ANTS);
    // ... and loses the standing as soon as that snapshot expires, not a full TTL later.
    now = 1_001;
    expect(await resolver.resolve(otherBuyer, [STAKER_A])).toBeNull();
  });

  it('falls back to base limits when the lookup is slow', async () => {
    const slow = reader({});
    slow.currentEpoch = vi.fn(() => new Promise<number>(() => {}));
    const resolver = new FreeTierStakeResolver(slow, { lookupTimeoutMs: 10 });
    expect(await resolver.resolve(BUYER)).toBeNull();
  });

  it('tries again after a stalled lookup times out', async () => {
    const r = reader({ [BUYER]: [{ id: 1, power: 150n * ANTS }] });
    r.currentEpoch = vi.fn().mockReturnValueOnce(new Promise<number>(() => {})).mockResolvedValue(3);
    const resolver = new FreeTierStakeResolver(r, { lookupTimeoutMs: 10 });
    expect(await resolver.resolve(BUYER)).toBeNull();
    expect((await resolver.resolve(BUYER))?.power).toBe(150n * ANTS);
  });

  it('keeps a newer result when a timed-out lookup fails later', async () => {
    const r = reader({ [BUYER]: [{ id: 1, power: 150n * ANTS }] });
    let failStalled!: (err: Error) => void;
    r.currentEpoch = vi.fn()
      .mockReturnValueOnce(new Promise<number>((_, reject) => { failStalled = reject; }))
      .mockResolvedValue(3);
    const resolver = new FreeTierStakeResolver(r, { lookupTimeoutMs: 10 });
    expect(await resolver.resolve(BUYER)).toBeNull();
    expect((await resolver.resolve(BUYER))?.power).toBe(150n * ANTS);
    failStalled(new Error('rpc down'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await resolver.resolve(BUYER))?.power).toBe(150n * ANTS);
  });

  it('keeps newer positions when an older position read finishes later', async () => {
    const r = reader({});
    let finishStalled!: (positions: FreeTierStakePosition[]) => void;
    r.stakerPositions = vi.fn()
      .mockReturnValueOnce(new Promise<FreeTierStakePosition[]>((resolve) => { finishStalled = resolve; }))
      // Only the buyer has stake, so the last check passes only if its newer positions survive.
      .mockImplementation(async (staker: string) => (staker === BUYER ? [{ id: 1, power: 150n * ANTS }] : []));
    const resolver = new FreeTierStakeResolver(r, { lookupTimeoutMs: 10 });
    expect(await resolver.resolve(BUYER)).toBeNull();
    expect((await resolver.resolve(BUYER))?.power).toBe(150n * ANTS);
    finishStalled([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await resolver.resolve(BUYER, [STAKER_A]))?.power).toBe(150n * ANTS);
  });
});
