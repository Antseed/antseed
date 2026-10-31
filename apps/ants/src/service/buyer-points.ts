/**
 * A buyer's Antseed Points: this epoch's points with an ANTS estimate at the
 * live rate, and points per past epoch. Points come from the Antscan indexer;
 * the buyer pot is one chain read (Antscan does not serve it).
 */

import type { AntsContext } from './context.js';
import { antsFromWei, pointsFromWeighted, scaled, usageReward } from './points-math.js';

const DAY_MS = 86_400_000;

export interface BuyerPointsView {
  epoch: number;
  /** When this epoch's points convert to ANTS (ms since 1970); null when unknown. */
  endsAt: number | null;
  points: number;
  /** This epoch's points at the live rate, with the 5% cap; null when the pot or the total is unavailable. */
  estimatedAnts: number | null;
  /** The estimate hit the 5% per-claim cap. */
  capped: boolean;
  /** This epoch's buyer ANTS pot; null when it cannot be read. With `totalPoints` it feeds `spendEstimate`. */
  potAnts: number | null;
  /** Everyone's points this epoch so far; null when the explorer does not serve the total. */
  totalPoints: number | null;
  /** When this epoch started (ms since 1970); with `endsAt` it paces `projectRange`. Null when unknown. */
  startsAt: number | null;
  /**
   * Everyone's points per day on a busy day: the busiest recent full day's $ × this
   * epoch's average boost (the Points site's low end). Null when the explorer has no daily volume.
   */
  busyPointsPerDay: number | null;
  /** Points per epoch with any, newest first (this epoch included). */
  history: Array<{ epoch: number; points: number }>;
}

/** Null without an indexer; throws when the indexer cannot be read. A failed pot read only drops the estimate. */
export async function buyerPoints(ctx: AntsContext, epochs = 8): Promise<BuyerPointsView | null> {
  const indexer = ctx.indexer();
  if (!indexer) return null;
  const [participant, pools, stack, daily] = await Promise.all([
    indexer.participant(ctx.buyerAddress, epochs),
    indexer.pools(),
    ctx.stack().catch(() => null),
    indexer.dailyVolume ? indexer.dailyVolume(15).catch(() => null) : Promise.resolve(null),
  ]);
  const epoch = stack?.currentEpoch ?? pools.currentEpoch;
  const mine = participant.buyer.find((row) => row.epoch === epoch)?.weightedPoints ?? '0';
  const total = pools.network.current?.epoch === epoch ? pools.network.current.totalWeightedBuyerPoints : undefined;
  let pot: bigint | null = null;
  try {
    pot = (await ctx.usageRewards()?.usageEpochBudgets(epoch))?.buyer ?? null;
  } catch {
    pot = null;
  }
  const estimate = pot !== null && total !== undefined ? usageReward(antsFromWei(pot), mine, total) : null;
  const endsAt = stack && stack.epochDuration > 0 ? (stack.genesis + (epoch + 1) * stack.epochDuration) * 1000 : null;
  // Average boost this epoch (points per $ spent so far) × the busiest full day before today.
  const volumeUsd = pools.network.current?.epoch === epoch ? scaled(pools.network.current.volumeUsdc, 6) : 0;
  const avgBoost = total !== undefined && volumeUsd > 0 ? pointsFromWeighted(total) / volumeUsd : 0;
  const today = Math.floor(Date.now() / DAY_MS) * (DAY_MS / 1000);
  const busiestUsd = daily ? Math.max(0, ...daily.filter((day) => day.dayStart < today).slice(0, 14).map((day) => scaled(day.volumeUsdc, 6))) : null;
  return {
    epoch,
    endsAt,
    startsAt: endsAt !== null && stack ? endsAt - stack.epochDuration * 1000 : null,
    busyPointsPerDay: busiestUsd === null ? null : busiestUsd * avgBoost,
    points: pointsFromWeighted(mine),
    estimatedAnts: estimate?.ants ?? null,
    capped: estimate?.capped ?? false,
    potAnts: pot === null ? null : antsFromWei(pot),
    totalPoints: total === undefined ? null : pointsFromWeighted(total),
    history: participant.buyer
      .map((row) => ({ epoch: row.epoch, points: pointsFromWeighted(row.weightedPoints) }))
      .filter((row) => row.points > 0 || row.epoch === epoch)
      .sort((a, b) => b.epoch - a.epoch),
  };
}
