import { Interface, ZeroAddress } from 'ethers';
import { GATE_MINTERS, gateMinterId, multicallRead, type MulticallRequest } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import type { EmissionsView, NetworkSnapshot, NetworkStakerConfig, NetworkUsageConfig } from '../api-types.js';

const ABI = new Interface([
  'function genesis() view returns(uint256)',
  'function epochDuration() view returns(uint256)',
  'function effectiveEpoch() view returns(uint256)',
  'function currentEpoch() view returns(uint256)',
  'function INITIAL_EMISSION() view returns(uint256)',
  'function initialEmission() view returns(uint256)',
  'function HALVING_INTERVAL() view returns(uint256)',
  'function SHARE_DENOMINATOR() view returns(uint256)',
  'function GATE_SHARE_DENOMINATOR() view returns(uint256)',
  'function getEpochEmission(uint256) view returns(uint256)',
  'function cumulativeEmissionThrough(uint256) view returns(uint256)',
  'function minters(bytes32) view returns(address controller,uint32 shareBps,bool editable)',
  'function minterEpochBudget(bytes32,uint256) view returns(uint256)',
  'function totalSupply() view returns(uint256)',
  'function MAX_SUPPLY() view returns(uint256)',
  'function totalActiveStakeAtEpoch(uint256) view returns(uint256)',
  'function totalPowerWeightAtEpoch(uint256) view returns(uint256)',
  'function totalBuyerPointsByEpoch(uint256) view returns(uint256)',
  'function totalSellerPointsByEpoch(uint256) view returns(uint256)',
  'function stakerEpochBudget(uint256) view returns(uint256)',
  'function usageEpochBudgets(uint256) view returns(uint256 buyer,uint256 seller)',
  'function dynamicStakerConfigAt(uint256) view returns(tuple(uint32 minShareBps,uint32 maxShareBps,uint256 stakeShareTarget))',
  'function dynamicUsageConfigAt(uint256) view returns(tuple(uint32 buyerMinShareBps,uint32 buyerMaxShareBps,uint32 sellerMinShareBps,uint32 sellerMaxShareBps,uint256 volumeShareTarget))',
  'function emissionsGate() view returns(address)',
  'function sellerPools() view returns(address)',
  'function usageAccounting() view returns(address)',
  'function emissions() view returns(address)',
  'function staking() view returns(address)',
]);

interface Metadata { genesis: number; duration: number; initial: string; halving: number; denominator: number }
interface Cache { key: string; metadata?: Metadata; value?: NetworkSnapshot; pending?: Promise<NetworkSnapshot> }
const caches = new WeakMap<AntsContext, Cache>();
const TTL_MS = 20_000;

export function invalidateNetwork(ctx: AntsContext): void {
  const cache = caches.get(ctx);
  if (cache) caches.set(ctx, { key: cache.key, metadata: cache.metadata });
}

export function networkSnapshot(ctx: AntsContext): Promise<NetworkSnapshot> {
  const key = JSON.stringify(ctx.chain);
  let cache = caches.get(ctx);
  if (!cache || cache.key !== key) {
    cache = { key };
    caches.set(ctx, cache);
  }
  if (cache.pending) return cache.pending;
  const value = cache.value;
  const age = value ? Date.now() - value.fetchedAt : Infinity;
  if (value && age < TTL_MS && age < value.epoch.secondsToBoundary * 1000) return Promise.resolve(value);
  const entry = cache;
  const pending = readSnapshot(ctx, entry).then(snapshot => {
    entry.value = snapshot;
    return snapshot;
  }).finally(() => { entry.pending = undefined; });
  entry.pending = pending;
  return pending;
}

async function readSnapshot(ctx: AntsContext, cache: Cache): Promise<NetworkSnapshot> {
  const chain = ctx.chain;
  const gate = chain.emissionsGateAddress;
  if (!gate || gate === ZeroAddress) throw new Error('The emission gate is not configured on this network.');
  const provider = ctx.provider();
  const block = await provider.getBlock('latest');
  if (!block) throw new Error('The latest network block is unavailable.');
  const options = { blockTag: block.number };
  if (!cache.metadata) {
    const methods = ['genesis', 'epochDuration', 'INITIAL_EMISSION', 'HALVING_INTERVAL', 'SHARE_DENOMINATOR'];
    const values = await multicallRead(provider, methods.map(method => ({ target: gate, iface: ABI, method })), options);
    const required = (index: number): bigint => {
      const value = values[index]?.[0];
      if (typeof value !== 'bigint') throw new Error(`Network configuration unavailable: ${methods[index]}.`);
      return value;
    };
    const metadata = { genesis: Number(required(0)), duration: Number(required(1)), initial: required(2).toString(), halving: Number(required(3)), denominator: Number(required(4)) };
    if (![metadata.genesis, metadata.duration, metadata.halving, metadata.denominator].every(Number.isSafeInteger) || metadata.duration <= 0 || metadata.denominator <= 0) throw new Error('Invalid emission timing or share denominator.');
    cache.metadata = metadata;
  }
  const metadata = cache.metadata;
  const epoch = Math.max(0, Math.floor((block.timestamp - metadata.genesis) / metadata.duration));
  const requests: MulticallRequest[] = [];
  const errors: string[] = [];
  const add = (target: string | undefined, method: string, args: unknown[] = []) => {
    if (!target || target === ZeroAddress) return -1;
    return requests.push({ target, iface: ABI, method, args }) - 1;
  };
  const poolRewards = chain.sellerPoolsRewardsAddress;
  const usageRewards = chain.usageRewardsAddress;
  const ids = {
    epoch: add(gate, 'currentEpoch'), effective: add(gate, 'effectiveEpoch'),
    emission: add(gate, 'getEpochEmission', [epoch]), nextEmission: add(gate, 'getEpochEmission', [epoch + 1]),
    cumulative: add(gate, 'cumulativeEmissionThrough', [epoch + 1]),
    supply: add(chain.antsTokenAddress, 'totalSupply'), maxSupply: add(chain.antsTokenAddress, 'MAX_SUPPLY'),
    stake: add(chain.sellerPoolsAddress, 'totalActiveStakeAtEpoch', [epoch]), weight: add(chain.sellerPoolsAddress, 'totalPowerWeightAtEpoch', [epoch]),
    buyerPoints: add(chain.usageAccountingAddress, 'totalBuyerPointsByEpoch', [epoch]), sellerPoints: add(chain.usageAccountingAddress, 'totalSellerPointsByEpoch', [epoch]),
    stakerBudget: add(poolRewards, 'stakerEpochBudget', [epoch]), usageBudgets: add(usageRewards, 'usageEpochBudgets', [epoch]),
    stakerConfig: add(poolRewards, 'dynamicStakerConfigAt', [epoch]), nextStakerConfig: add(poolRewards, 'dynamicStakerConfigAt', [epoch + 1]),
    usageConfig: add(usageRewards, 'dynamicUsageConfigAt', [epoch]), nextUsageConfig: add(usageRewards, 'dynamicUsageConfigAt', [epoch + 1]),
    initial: add(poolRewards, 'initialEmission'),
    stakerGate: add(poolRewards, 'emissionsGate'), usageGate: add(usageRewards, 'emissionsGate'),
    pools: add(poolRewards, 'sellerPools'), accounting: add(usageRewards, 'usageAccounting'),
    stakerDenominator: add(poolRewards, 'GATE_SHARE_DENOMINATOR'), usageDenominator: add(usageRewards, 'GATE_SHARE_DENOMINATOR'),
    registryEmissions: add(chain.registryContractAddress, 'emissions'), registryStaking: add(chain.registryContractAddress, 'staking'),
  };
  const buckets = GATE_MINTERS.map(minter => {
    const id = gateMinterId(minter.id);
    return { name: minter.name, id, info: add(gate, 'minters', [id]), budget: add(gate, 'minterEpochBudget', [id, epoch]), nextBudget: add(gate, 'minterEpochBudget', [id, epoch + 1]) };
  });
  const values = await multicallRead(provider, requests, options);
  const read = (index: number, label: string): unknown[] | null => {
    const value = index < 0 ? null : values[index];
    if (!value) errors.push(`${label} unavailable.`);
    return value ?? null;
  };
  const amount = (index: number, label: string) => {
    const value = read(index, label)?.[0];
    return typeof value === 'bigint' ? value.toString() : null;
  };
  if (amount(ids.epoch, 'Current epoch') !== String(epoch)) throw new Error('The emission epoch does not match the snapshot block. Refresh the network data.');
  const bucketViews = buckets.map(bucket => ({ name: bucket.name, id: bucket.id, controller: read(bucket.info, `${bucket.name} controller`)?.[0] as string | undefined ?? null, budget: amount(bucket.budget, `${bucket.name} limit`), nextBudget: amount(bucket.nextBudget, `${bucket.name} next-epoch limit`) }));
  const matches = (index: number, expected: string | undefined) => typeof values[index]?.[0] === 'string' && (values[index]![0] as string).toLowerCase() === expected?.toLowerCase();
  const stakerVerified = matches(ids.stakerGate, gate) && matches(ids.pools, chain.sellerPoolsAddress)
    && bucketViews[0]?.controller?.toLowerCase() === poolRewards?.toLowerCase() && values[ids.stakerDenominator]?.[0] === BigInt(metadata.denominator);
  const usageVerified = matches(ids.usageGate, gate) && matches(ids.accounting, chain.usageAccountingAddress)
    && bucketViews[1]?.controller?.toLowerCase() === usageRewards?.toLowerCase() && values[ids.usageDenominator]?.[0] === BigInt(metadata.denominator);
  if (!stakerVerified) errors.push('Staker controller connections could not be verified against the emission gate.');
  if (!usageVerified) errors.push('Usage controller connections could not be verified against the emission gate.');
  const stakerConfig = (index: number): NetworkStakerConfig | null => {
    const result = read(index, 'Staker configuration')?.[0] as [bigint, bigint, bigint] | undefined;
    return stakerVerified && result ? { minShareBps: Number(result[0]), maxShareBps: Number(result[1]), stakeShareTarget: result[2].toString() } : null;
  };
  const usageConfig = (index: number): NetworkUsageConfig | null => {
    const result = read(index, 'Usage configuration')?.[0] as [bigint, bigint, bigint, bigint, bigint] | undefined;
    return usageVerified && result ? { buyerMinShareBps: Number(result[0]), buyerMaxShareBps: Number(result[1]), sellerMinShareBps: Number(result[2]), sellerMaxShareBps: Number(result[3]), volumeShareTarget: result[4].toString() } : null;
  };
  const emission = amount(ids.emission, 'Epoch emission');
  const config = stakerConfig(ids.stakerConfig);
  const initial = amount(ids.initial, 'Staker initial emission');
  const buyerPoints = amount(ids.buyerPoints, 'Buyer usage input');
  const sellerPoints = amount(ids.sellerPoints, 'Seller usage input');
  const usage = read(ids.usageBudgets, 'Usage budgets');
  const effective = amount(ids.effective, 'Reward activation epoch');
  const registryEmissions = read(ids.registryEmissions, 'Registry emissions pointer');
  const registryStaking = read(ids.registryStaking, 'Registry staking pointer');
  const activation = !registryEmissions || !registryStaking ? 'unverified'
    : matches(ids.registryEmissions, chain.usageAccountingAddress) && matches(ids.registryStaking, chain.sellerRegistryAddress) ? 'active' : 'not-active';
  const nextBoundaryAt = metadata.genesis + (epoch + 1) * metadata.duration;
  return {
    chainId: chain.chainId, evmChainId: chain.evmChainId, blockNumber: block.number, blockTimestamp: block.timestamp, fetchedAt: Date.now(),
    activation,
    epoch: { current: epoch, effective: effective === null ? null : Number(effective), genesis: metadata.genesis, epochDuration: metadata.duration, nextBoundaryAt, secondsToBoundary: Math.max(0, nextBoundaryAt - block.timestamp) },
    shareDenominator: metadata.denominator, initialEmission: metadata.initial, halvingInterval: metadata.halving,
    emission, nextEmission: amount(ids.nextEmission, 'Next epoch emission'), cumulativeScheduled: amount(ids.cumulative, 'Scheduled cumulative emission'),
    totalSupply: amount(ids.supply, 'Token supply'), maxSupply: amount(ids.maxSupply, 'Maximum token supply'),
    totalActiveStake: amount(ids.stake, 'Active stake'), totalPowerWeight: amount(ids.weight, 'Power weight'),
    usageVolume: buyerPoints === null || sellerPoints === null ? null : (BigInt(buyerPoints) > BigInt(sellerPoints) ? buyerPoints : sellerPoints),
    buckets: bucketViews,
    budgets: { staker: stakerVerified ? amount(ids.stakerBudget, 'Staker budget') : null, buyer: usageVerified && usage ? String(usage[0]) : null, seller: usageVerified && usage ? String(usage[1]) : null },
    stakerConfig: config, nextStakerConfig: stakerConfig(ids.nextStakerConfig),
    scaledStakeTarget: config && emission !== null && initial !== null && BigInt(initial) > 0n ? (BigInt(config.stakeShareTarget) * BigInt(emission) / BigInt(initial)).toString() : null,
    usageConfig: usageConfig(ids.usageConfig), nextUsageConfig: usageConfig(ids.nextUsageConfig),
    contracts: Object.fromEntries(Object.entries({ registry: chain.registryContractAddress, gate, sellerPools: chain.sellerPoolsAddress, stakerRewards: poolRewards, usageRewards, usageAccounting: chain.usageAccountingAddress, token: chain.antsTokenAddress }).filter((entry): entry is [string, string] => !!entry[1])),
    errors: [...new Set(errors)],
  };
}

export async function networkLegacy(ctx: AntsContext): Promise<EmissionsView['legacy']> {
  const stack = await ctx.stack();
  const contract = ctx.legacyEmissionsAt(stack.legacyEmissions);
  if (!contract || !stack.legacyEmissions) return null;
  const [shares, info] = await Promise.all([contract.getShares(), contract.getEpochInfo()]);
  return { contract: stack.legacyEmissions, sellerPct: shares.sellerSharePct, buyerPct: shares.buyerSharePct, reservePct: shares.reserveSharePct, teamPct: shares.teamSharePct, currentEpoch: info.epoch };
}
