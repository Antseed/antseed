import { Interface, ZeroAddress } from 'ethers';
import { multicallRead, type MulticallRequest } from '@antseed/node/payments';
import type { AntsContext, ResolvedStack } from './context.js';
import { displayData } from './display-snapshot.js';
import { networkSnapshot } from './network.js';

const ABI = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfersEnabled() view returns (bool)',
  'function transferWhitelist(address) view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function stakerTotalActiveStake(address) view returns (uint256)',
  'function stakerPositionCount(address) view returns (uint256)',
  'function getAgentId(address) view returns (uint256)',
  'function totalActiveStakeAtEpoch(uint256) view returns (uint256)',
  'function totalPowerWeightAtEpoch(uint256) view returns (uint256)',
  'function getEpochEmission(uint256) view returns (uint256)',
  'function stakerEpochBudget(uint256) view returns (uint256)',
  'function usageEpochBudgets(uint256) view returns (uint256 buyer, uint256 seller)',
]);

/** One Multicall for overview contract state; missing configured reads must not become zero balances. */
export async function overviewReads(ctx: AntsContext, stack: ResolvedStack) {
  const modern = !!ctx.chain.emissionsGateAddress;
  let networkError: string | undefined;
  const snapshot = modern ? await networkSnapshot(ctx).catch((error: unknown) => {
    networkError = error instanceof Error ? error.message : String(error);
    return null;
  }) : null;
  const display = modern ? { snapshot: null, source: { source: 'chain' as const, error: networkError } } : await displayData(ctx, stack);
  const network = display.snapshot?.epochs.find(row => row.epoch === stack.currentEpoch);
  const requests: MulticallRequest[] = [];
  const add = (target: string | undefined | null, method: string, args: unknown[] = []) => {
    if (!target || target.toLowerCase() === ZeroAddress) return -1;
    return requests.push({ target, iface: ABI, method, args }) - 1;
  };
  const c = ctx.chain, address = ctx.address, epoch = stack.currentEpoch;
  const token = ctx.antsToken().contractAddress;
  const ids = {
    ants: add(token, 'balanceOf', [address]), transfers: add(token, 'transfersEnabled'), whitelist: add(token, 'transferWhitelist', [address]),
    supply: modern ? -1 : add(token, 'totalSupply'), maxSupply: modern ? -1 : add(token, 'MAX_SUPPLY'),
    stake: add(c.sellerPoolsAddress, 'stakerTotalActiveStake', [address]), count: add(c.sellerPoolsAddress, 'stakerPositionCount', [address]),
    agent: add(c.sellerRegistryAddress, 'getAgentId', [address]), legacyAgent: add(stack.legacyStaking, 'getAgentId', [address]),
    networkStake: modern || network ? -1 : add(c.sellerPoolsAddress, 'totalActiveStakeAtEpoch', [epoch]), networkWeight: modern || network ? -1 : add(c.sellerPoolsAddress, 'totalPowerWeightAtEpoch', [epoch]),
    emission: modern ? -1 : add(c.emissionsGateAddress, 'getEpochEmission', [epoch]), budget: modern || network ? -1 : add(c.sellerPoolsRewardsAddress, 'stakerEpochBudget', [epoch]),
    usage: modern ? -1 : add(c.usageRewardsAddress, 'usageEpochBudgets', [epoch]),
  };
  const [values, eth] = await Promise.all([multicallRead(ctx.provider(), requests), ctx.provider().getBalance(address)]);
  const read = (index: number, field = 0): unknown => {
    if (index < 0) return 0n;
    const value = values[index]?.[field];
    if (value === undefined) throw new Error(`Wallet overview read failed: ${requests[index]!.method}. Retry when the RPC is available.`);
    return value;
  };
  const big = (index: number, field = 0) => BigInt(read(index, field) as bigint);
  const networkAvailable = !modern || !!snapshot && [snapshot.totalSupply, snapshot.maxSupply, snapshot.totalActiveStake, snapshot.totalPowerWeight, snapshot.emission, ...Object.values(snapshot.budgets)].every(value => value !== null);
  return {
    ants: big(ids.ants), eth, transfersEnabled: read(ids.transfers) === true, whitelisted: read(ids.whitelist) === true,
    totalActiveStake: big(ids.stake), positionCount: Number(big(ids.count)), registryAgentId: Number(big(ids.agent)), legacyAgentId: Number(big(ids.legacyAgent)),
    totalSupply: modern ? BigInt(snapshot?.totalSupply ?? '0') : big(ids.supply), maxSupply: modern ? BigInt(snapshot?.maxSupply ?? '0') : big(ids.maxSupply),
    networkStake: modern ? BigInt(snapshot?.totalActiveStake ?? '0') : network ? BigInt(network.totalActiveStake) : big(ids.networkStake), networkWeight: modern ? BigInt(snapshot?.totalPowerWeight ?? '0') : network ? BigInt(network.totalPowerWeight) : big(ids.networkWeight),
    epochEmission: modern ? BigInt(snapshot?.emission ?? '0') : big(ids.emission), stakerBudget: modern ? BigInt(snapshot?.budgets.staker ?? '0') : network ? BigInt(network.stakerBudget) : big(ids.budget),
    usageBudgets: modern ? { buyer: BigInt(snapshot?.budgets.buyer ?? '0'), seller: BigInt(snapshot?.budgets.seller ?? '0') } : { buyer: big(ids.usage), seller: big(ids.usage, 1) },
    networkAvailable, networkEpoch: snapshot?.epoch,
    networkSource: { ...display.source, error: networkError ?? (snapshot?.errors.length ? snapshot.errors.join(' ') : display.source.error) },
  };
}
