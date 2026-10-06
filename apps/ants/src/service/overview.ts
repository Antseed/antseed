import { overviewReads } from './overview-reads.js';
import type { AntsContext } from './context.js';
import type { OverviewView, EpochInfo } from '../api-types.js';
import { toJson } from './json.js';


export function epochInfo(stack: { currentEpoch: number; effectiveEpoch: number | null; genesis: number; epochDuration: number }, now = Math.floor(Date.now() / 1000)): EpochInfo {
  const nextBoundaryAt = stack.genesis + (stack.currentEpoch + 1) * stack.epochDuration;
  return {
    current: stack.currentEpoch,
    effective: stack.effectiveEpoch,
    genesis: stack.genesis,
    epochDuration: stack.epochDuration,
    nextBoundaryAt,
    secondsToBoundary: Math.max(0, nextBoundaryAt - now),
  };
}

export async function overview(ctx: AntsContext): Promise<OverviewView> {
  const stack = await ctx.stack();
  const pools = ctx.pools();
  const sellerRegistry = ctx.sellerRegistry();
  const { ants, eth, transfersEnabled, whitelisted, totalActiveStake, positionCount, registryAgentId, legacyAgentId,
    totalSupply, maxSupply, networkStake, networkWeight, epochEmission, stakerBudget, usageBudgets, networkSource, networkAvailable, networkEpoch } = await overviewReads(ctx, stack);

  let network: OverviewView['network'] = null;
  if (pools && networkAvailable) {
    network = {
      totalActiveStake: networkStake.toString(),
      totalPowerWeight: networkWeight.toString(),
      epochEmission: epochEmission.toString(),
      stakerBudget: stakerBudget.toString(),
      usageBuyerBudget: usageBudgets.buyer.toString(),
      usageSellerBudget: usageBudgets.seller.toString(),
      antsTotalSupply: totalSupply.toString(),
      antsMaxSupply: maxSupply.toString(),
    };
  }

  const notices: string[] = [];
  if (networkSource.error) notices.push(`Network statistics: ${networkSource.error}`);
  const sellerBound = !!sellerRegistry && registryAgentId !== 0 &&
    (await sellerRegistry.agentSeller(registryAgentId)).toLowerCase() === ctx.address.toLowerCase();
  const epoch = networkEpoch ?? epochInfo(stack);
  const signingAddress = await ctx.signer?.getAddress();
  const signingWalletEth = signingAddress && signingAddress.toLowerCase() !== ctx.address.toLowerCase()
    ? (await ctx.provider().getBalance(signingAddress)).toString() : undefined;
  if (stack.phase === 'legacy') {
    notices.push('The recognized-usage contracts are not configured for this chain. Only legacy emissions are available.');
  } else if (stack.phase === 'deployed') {
    const startsAt = stack.effectiveEpoch !== null ? new Date((stack.genesis + stack.effectiveEpoch * stack.epochDuration) * 1000).toUTCString() : 'the cutover';
    notices.push(`Recognized usage is deployed but not active yet: the registry still points at the legacy stack. Rewards from epoch ${stack.effectiveEpoch ?? '?'} start at ${startsAt}. Positions staked now have power from the first rewarded epoch.`);
  }
  if (!transfersEnabled && !whitelisted) {
    notices.push('ANTS transfers are not enabled and this wallet is not whitelisted, so staking new ANTS is not possible yet. Rewards can still be claimed and restaked.');
  }

  return toJson({
    phase: stack.phase,
    chainId: ctx.chain.chainId,
    evmChainId: ctx.chain.evmChainId,
    rpcUrl: ctx.chain.rpcUrl,
    addresses: ctx.addresses(),
    epoch,
    wallet: {
      address: ctx.address,
      ants: ants.toString(),
      eth: eth.toString(),
      signingWalletEth,
      transfersEnabled,
      whitelisted,
      canTransfer: transfersEnabled || whitelisted,
      totalActiveStake: totalActiveStake.toString(),
      positionCount,
      agentId: registryAgentId || legacyAgentId,
      sellerBound,
    },
    network,
    networkSource,
    notices,
  });
}
