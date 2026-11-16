import { describe, expect, it, vi } from 'vitest';
import type { SellerPoolPosition } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import { freeTierStake } from './free-tier.js';

const ANTS = 10n ** 18n;
const buyer = '0x00000000000000000000000000000000000000B1';
const staker = '0x00000000000000000000000000000000000000A1';

function position(id: number, owner: string, overrides: Partial<SellerPoolPosition> = {}): SellerPoolPosition {
  return { id, owner, agentId: 7, amount: 1000n * ANTS, weightAmount: 1000n * ANTS, stakeStartEpoch: 5, stakeEndEpoch: 40, closedAtEpoch: 0, withdrawn: false, ...overrides };
}

function makeCtx(byOwner: Record<string, SellerPoolPosition[]>, maxLockedNext: number[] = [], maxLocked: number[] = []): AntsContext {
  const all = Object.values(byOwner).flat();
  const pools = {
    allStakerPositionIds: vi.fn(async (owner: string) => (byOwner[owner.toLowerCase()] ?? []).map((row) => row.id)),
    positionsBatch: vi.fn(async (ids: number[]) => ids.map((id) => all.find((row) => row.id === id)!)),
    positionStatusesBatch: vi.fn(async (rows: SellerPoolPosition[]) => rows.map((row) => ({ withdrawableEpoch: 0, maxLocked: maxLocked.includes(row.id), maxLockedNext: maxLockedNext.includes(row.id), slashBps: null }))),
  };
  return {
    stack: async () => ({ currentEpoch: 10, genesis: 1_000, epochDuration: 604_800 }),
    requirePools: () => pools,
  } as unknown as AntsContext;
}

describe('freeTierStake', () => {
  it('groups the buyer and shared stakers by pool with each code expiry and max-lock state now and next epoch', async () => {
    const ctx = makeCtx({
      [buyer.toLowerCase()]: [position(1, buyer)],
      [staker.toLowerCase()]: [
        position(2, staker, { agentId: 3, weightAmount: 2500n * ANTS / 10n }),
        position(3, staker),
        position(4, staker, { withdrawn: true }),
        position(5, staker, { closedAtEpoch: 9 }),
      ],
    }, [3], [2]);
    const view = await freeTierStake(ctx, buyer, [{ staker, expiresAt: 2_000_000 }]);
    expect(view).toMatchObject({ currentEpoch: 10, genesis: 1_000, epochDuration: 604_800 });
    expect(view.pools).toEqual([
      { agentId: 3, positions: [{ id: 2, staker: staker.toLowerCase(), ants: 250, startEpoch: 5, endEpoch: 40, closedAtEpoch: null, maxLocked: true, maxLockedNext: false, expiresAt: 2_000_000 }] },
      { agentId: 7, positions: [
        { id: 1, staker: buyer.toLowerCase(), ants: 1000, startEpoch: 5, endEpoch: 40, closedAtEpoch: null, maxLocked: false, maxLockedNext: false, expiresAt: null },
        // Max lock turned on this epoch: it counts from the next one.
        { id: 3, staker: staker.toLowerCase(), ants: 1000, startEpoch: 5, endEpoch: 40, closedAtEpoch: null, maxLocked: false, maxLockedNext: true, expiresAt: 2_000_000 },
      ] },
    ]);
  });

  it('treats a buyer listed as its own staker as its own stake', async () => {
    const ctx = makeCtx({ [buyer.toLowerCase()]: [position(1, buyer)] });
    const view = await freeTierStake(ctx, buyer, [{ staker: buyer, expiresAt: 5 }]);
    expect(view.pools[0]!.positions[0]!.expiresAt).toBeNull();
  });
});
