import { buyerPoints, formatAntsExact, rewards, type AntsChainConfig } from '@antseed/ants/service';
import type { DesktopRewardsSummary } from '../payments/buyer-channels.js';
import { sharedChainContext } from '../payments/shared-chain.js';

/** Use the dashboard's buyer-only calculation so VPR never advertises another reward category. */
export async function readBuyerRewardsSummary(chain: AntsChainConfig, buyerAddress: string): Promise<DesktopRewardsSummary> {
  // The shared context keeps its ranked endpoints and resolved stack between
  // refreshes. VPR has one wallet, so pointing it at the current buyer is safe.
  const ctx = await sharedChainContext(chain);
  ctx.buyerAddress = buyerAddress;
  const [view, transfersEnabled, points] = await Promise.all([
    rewards(ctx),
    chain.antsTokenAddress ? ctx.antsToken().transfersEnabled() : Promise.resolve(false),
    // Antseed Points from the explorer; the rewards summary still answers when it cannot be read.
    buyerPoints(ctx).catch(() => null),
  ]);
  return {
    available: !!(chain.emissionsContractAddress || chain.usageRewardsAddress),
    pendingAnts: formatAntsExact(BigInt(view.buyerUsage.total) + BigInt(view.legacy.buyer)),
    currentEpoch: view.currentEpoch,
    transfersEnabled,
    error: null,
    points: points && {
      points: points.points, estimatedAnts: points.estimatedAnts, capped: points.capped, endsAt: points.endsAt,
      potAnts: points.potAnts, totalPoints: points.totalPoints, startsAt: points.startsAt, busyPointsPerDay: points.busyPointsPerDay,
    },
  };
}
