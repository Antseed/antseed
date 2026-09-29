import { AntsContext, formatAntsExact, rewards, type AntsChainConfig } from '@antseed/ants/service';
import { ZeroAddress } from 'ethers';
import type { DesktopRewardsSummary } from '../payments/buyer-channels.js';

/** Use the dashboard's buyer-only calculation so VPR never advertises another reward category. */
export async function readBuyerRewardsSummary(chain: AntsChainConfig, buyerAddress: string): Promise<DesktopRewardsSummary> {
  const ctx = new AntsContext({ chain, buyerAddress, address: ZeroAddress });
  try {
    const [view, transfersEnabled] = await Promise.all([
      rewards(ctx),
      chain.antsTokenAddress ? ctx.antsToken().transfersEnabled() : Promise.resolve(false),
    ]);
    return {
      available: !!(chain.emissionsContractAddress || chain.usageRewardsAddress),
      pendingAnts: formatAntsExact(BigInt(view.buyerUsage.total) + BigInt(view.legacy.buyer)),
      currentEpoch: view.currentEpoch,
      transfersEnabled,
      error: null,
    };
  } finally { ctx.provider().destroy(); }
}
