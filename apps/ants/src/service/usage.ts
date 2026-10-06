import { ZeroAddress } from 'ethers';
import type { AntsContext } from './context.js';
import type { UsageView, UsageEpochView } from '../api-types.js';
import { toJson } from './json.js';
import { IndexerError } from './indexer.js';


/**
 * Your buyer and seller usage per epoch with network totals. The per-epoch
 * series comes from the indexer (no per-epoch chain reads); only the
 * wallet's lifetime totals and the accounting policies are read live.
 */
export async function usage(ctx: AntsContext, options: { epochs?: number } = {}): Promise<UsageView> {
  const stack = await ctx.stack();
  const accounting = ctx.usageAccounting();
  const indexer = ctx.indexer();
  const count = Math.max(1, Math.min(52, options.epochs ?? 8));
  const first = stack.effectiveEpoch ?? 0;
  const from = Math.max(first, stack.currentEpoch - count + 1);
  let epochs: UsageEpochView[] = [];
  let source: UsageView['source'] = 'chain';
  let sourceError: string | null = null;
  if (indexer && stack.phase === 'active') {
    try {
      const [participant, network] = await Promise.all([indexer.participant(ctx.address, count), indexer.stakingEpochs(count)]);
      source = 'indexer';
      for (let epoch = stack.currentEpoch; epoch >= from; epoch -= 1) {
        const seller = participant.seller.find((row) => row.epoch === epoch);
        const buyer = participant.buyer.find((row) => row.epoch === epoch);
        const totals = network.find((row) => row.epoch === epoch);
        epochs.push({
          epoch,
          buyerPoints: buyer?.points ?? '0',
          weightedBuyerPoints: buyer?.weightedPoints ?? '0',
          sellerPoints: seller?.points ?? '0',
          agentId: seller?.agentId ?? 0,
          totalBuyerPoints: totals?.totalBuyerPoints ?? '0',
          totalSellerPoints: totals?.totalSellerPoints ?? '0',
          totalPoolPoints: totals?.totalSellerPoints ?? '0',
          totalWeightedPoolPoints: totals?.totalWeightedPoolPoints ?? '0',
        });
      }
    } catch (error) {
      if (!(error instanceof IndexerError)) throw error;
      sourceError = error.message;
      epochs = [];
    }
  }
  const [buyerTotal, networkTotal, pointsPolicy, poolWeightPolicy, minimumPower] = await Promise.all([
    accounting ? accounting.buyerUsageTotal(ctx.address) : Promise.resolve({ points: 0n, weightedPoints: 0n }),
    accounting ? accounting.totalUsage() : Promise.resolve({ buyers: { points: 0n, weightedPoints: 0n }, sellers: { points: 0n, weightedPoints: 0n } }),
    accounting ? accounting.pointsPolicy() : Promise.resolve(null),
    accounting ? accounting.poolWeightPolicy() : Promise.resolve(null),
    accounting ? accounting.minimumAccountedPoolPower() : Promise.resolve(null),
  ]);
  return toJson({
    currentEpoch: stack.currentEpoch,
    firstRewardedEpoch: stack.effectiveEpoch,
    epochs,
    totals: {
      buyerPoints: buyerTotal.points.toString(), buyerWeightedPoints: buyerTotal.weightedPoints.toString(),
      networkBuyerPoints: networkTotal.buyers.points.toString(), networkSellerPoints: networkTotal.sellers.points.toString(),
    },
    pointsPolicy: pointsPolicy && pointsPolicy !== ZeroAddress ? pointsPolicy : null,
    poolWeightPolicy: poolWeightPolicy && poolWeightPolicy !== ZeroAddress ? poolWeightPolicy : null,
    minimumAccountedPoolPower: minimumPower === null ? null : minimumPower.toString(),
    source,
    sourceError,
  });
}
