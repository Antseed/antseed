import type { FreeTierPoolStakeView, FreeTierStakeView } from '@antseed/node/free-tier-program';
import type { AntsContext } from './context.js';

const ANTS_WEI = 10n ** 18n;

/** Weighted ANTS as a number of whole ANTS, to four decimals. */
function wholeAnts(weight: bigint): number {
  return Number(weight / 10n ** 14n) / 10_000;
}

/**
 * The seller-pool stake a buyer's staked free tier counts, by pool: the
 * buyer's own positions plus those of every staker that shared stake with it
 * (`stakers`, each with its code's expiry). Read live from the chain; sellers
 * count the same positions when they admit the buyer.
 */
export async function freeTierStake(
  ctx: AntsContext,
  buyer: string,
  stakers: ReadonlyArray<{ staker: string; expiresAt: number }>,
): Promise<FreeTierStakeView> {
  const stack = await ctx.stack();
  const pools = ctx.requirePools();
  const epoch = stack.currentEpoch;
  const holders = new Map<string, number | null>([[buyer.toLowerCase(), null]]);
  for (const entry of stakers) {
    const key = entry.staker.toLowerCase();
    if (holders.has(key) && holders.get(key) === null) continue;
    holders.set(key, Math.max(holders.get(key) ?? 0, entry.expiresAt));
  }
  const byPool = new Map<number, FreeTierPoolStakeView>();
  const seen = new Set<number>();
  await Promise.all([...holders].map(async ([holder, expiresAt]) => {
    const ids = await pools.allStakerPositionIds(holder);
    if (ids.length === 0) return;
    const open = (await pools.positionsBatch(ids))
      .filter((position) => !position.withdrawn && (position.closedAtEpoch === 0 || position.closedAtEpoch > epoch))
      .filter((position) => position.weightAmount >= ANTS_WEI / 10_000n);
    if (open.length === 0) return;
    const statuses = await pools.positionStatusesBatch(open, epoch);
    open.forEach((position, index) => {
      if (seen.has(position.id)) return;
      seen.add(position.id);
      const pool = byPool.get(position.agentId) ?? { agentId: position.agentId, positions: [] };
      pool.positions.push({
        id: position.id,
        staker: holder,
        ants: wholeAnts(position.weightAmount),
        startEpoch: position.stakeStartEpoch,
        endEpoch: position.stakeEndEpoch,
        closedAtEpoch: position.closedAtEpoch === 0 ? null : position.closedAtEpoch,
        maxLocked: statuses[index]!.maxLockedNext,
        expiresAt,
      });
      byPool.set(position.agentId, pool);
    });
  }));
  return {
    currentEpoch: epoch,
    genesis: stack.genesis,
    epochDuration: stack.epochDuration,
    pools: [...byPool.values()]
      .map((pool) => ({ ...pool, positions: pool.positions.sort((a, b) => a.id - b.id) }))
      .sort((a, b) => a.agentId - b.agentId),
  };
}
