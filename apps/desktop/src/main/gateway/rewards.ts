/**
 * The Rewards summary: $ANTS the gateway's paying wallet earned from usage,
 * read from the chain with the same buyer-only calculation as the staking
 * dashboard. Claiming needs the wallet's operator signature, so it happens in
 * the Gateway Console's Rewards page.
 */
import { formatAntsExact, rewards } from '@antseed/ants/service';
import type { GatewayRewardsSummary } from '../../shared/gateway-types.js';
import { readConfig } from '../runtime/config-io.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { resolveStakingChain } from '../payments/chain-config.js';
import { sharedChainContext } from '../payments/shared-chain.js';

export type { GatewayRewardsSummary };

const TTL_MS = 5 * 60_000;
let cached: { address: string; at: number; summary: GatewayRewardsSummary } | null = null;

/**
 * A remote gateway's wallet is on whatever chain that gateway uses, which
 * this app's config doesn't say: reading it on the local chain could show
 * another chain's amount, so no amount is read for it.
 */
export function remoteRewardsSummary(address: string): GatewayRewardsSummary {
  return { available: false, address, pendingAnts: '0', currentEpoch: null, transfersEnabled: false, remoteChainUnverified: true };
}

export async function readGatewayRewards(address: string, options: { force?: boolean } = {}): Promise<GatewayRewardsSummary> {
  const key = address.toLowerCase();
  if (!options.force && cached?.address === key && Date.now() - cached.at < TTL_MS) return cached.summary;
  const chain = resolveStakingChain(await readConfig(ACTIVE_CONFIG_PATH));
  const available = Boolean(chain.emissionsContractAddress || chain.usageRewardsAddress);
  if (!available) return { available, address, pendingAnts: '0', currentEpoch: null, transfersEnabled: false };
  // The shared context keeps its ranked RPC endpoints between reads; the
  // desktop reads one wallet, so pointing it at this one is safe.
  const ctx = await sharedChainContext(chain);
  ctx.buyerAddress = address;
  const [view, transfersEnabled] = await Promise.all([
    rewards(ctx),
    chain.antsTokenAddress ? ctx.antsToken().transfersEnabled() : Promise.resolve(false),
  ]);
  const summary: GatewayRewardsSummary = {
    available,
    address,
    pendingAnts: formatAntsExact(BigInt(view.buyerUsage.total ?? '0') + BigInt(view.legacy.buyer ?? '0')),
    currentEpoch: view.currentEpoch,
    transfersEnabled,
  };
  cached = { address: key, at: Date.now(), summary };
  return summary;
}
