import { Contract, ZeroAddress, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { previewPositionReward, REWARD_INDEX_SCALE } from '../reward-preview.js';

export interface SellerPoolsRewardsClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }
const ABI = [
  'function sellerPools() view returns (address)',
  'function usageAccounting() view returns (address)',
  'function positionClaimCursor(uint256 positionId) view returns (uint256)',
  'function poolRewardIndexNextEpoch(uint256 agentId) view returns (uint256)',
  'function initialIndexEpoch() view returns (uint256)',
  'function poolCumulativeRewardPerWeightAt(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolCumulativeEpochRewardPerWeightAt(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolEpochEmissions(uint256 epoch, uint256 agentId) view returns (bool, uint256)',
  'function stakerEpochBudget(uint256 epoch) view returns (uint256)',
  'function indexPoolRewards(uint256 agentId, uint256 maxEpochs) returns (uint256)',
  'function pendingIndexedStakerReward(uint256 positionId) external view returns (uint256)',
  'function claimStakerRewards(uint256 positionId, address recipient) external',
  'function claimStakerRewardsBatch(uint256[] positionIds, address recipient) external',
  'function restakeStakerRewards(uint256 positionId, uint256 stakeEpochs) external returns (uint256 newPositionId)',
  'function restakeStakerRewardsBatch(uint256[] positionIds, uint256 stakeEpochs) external returns (uint256[] newPositionIds)',
  'function dynamicStakerConfigAt(uint256 epoch) view returns (tuple(uint32 minShareBps, uint32 maxShareBps, uint256 stakeShareTarget))',
  'function paused() view returns (bool)',
] as const;
const POOLS_ABI = [
  'function positionPowerSegmentAt(uint256 positionId, uint256 epoch) view returns (uint256, uint256, uint256)',
  'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function currentEpoch() view returns (uint256)',
  'function positions(uint256 positionId) view returns (address, uint256, uint256, uint256, uint64, uint64, uint64, bool)',
];
const ACCOUNTING_ABI = [
  'function weightedPoolPointsByEpoch(uint256 epoch, uint256 agentId) view returns (uint256)',
  'function totalWeightedPoolPointsByEpoch(uint256 epoch) view returns (uint256)',
];

export interface DynamicStakerConfig { minShareBps: number; maxShareBps: number; stakeShareTarget: bigint; }

export class SellerPoolsRewardsClient extends BaseEvmClient {
  constructor(config: SellerPoolsRewardsClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  pendingIndexedStakerReward(positionId: number): Promise<bigint> { return new Contract(this._contractAddress, ABI, this._provider).getFunction('pendingIndexedStakerReward')(positionId); }
  claimStakerRewards(signer: AbstractSigner, positionId: number, recipient: string): Promise<string> { return this._execWrite(signer, ABI, 'claimStakerRewards', positionId, recipient); }
  claimStakerRewardsBatch(signer: AbstractSigner, positionIds: number[], recipient: string): Promise<string> { return this._execWrite(signer, ABI, 'claimStakerRewardsBatch', positionIds, recipient); }
  /** Compound indexed staker rewards into a fresh locked position (earns the restake weight bonus). */
  restakeStakerRewards(signer: AbstractSigner, positionId: number, stakeEpochs: number): Promise<string> { return this._execWrite(signer, ABI, 'restakeStakerRewards', positionId, stakeEpochs); }
  restakeStakerRewardsBatch(signer: AbstractSigner, positionIds: number[], stakeEpochs: number): Promise<string> { return this._execWrite(signer, ABI, 'restakeStakerRewardsBatch', positionIds, stakeEpochs); }
  stakerEpochBudget(epoch: number): Promise<bigint> { return new Contract(this._contractAddress, ABI, this._provider).getFunction('stakerEpochBudget')(epoch); }
  async poolEpochEmissions(epoch: number, agentId: number): Promise<{ settled: boolean; amount: bigint }> {
    const [settled, amount] = await new Contract(this._contractAddress, ABI, this._provider).getFunction('poolEpochEmissions')(epoch, agentId) as [boolean, bigint];
    return { settled, amount };
  }
  async dynamicStakerConfigAt(epoch: number): Promise<DynamicStakerConfig> {
    const result = await new Contract(this._contractAddress, ABI, this._provider).getFunction('dynamicStakerConfigAt')(epoch);
    return { minShareBps: Number(result[0]), maxShareBps: Number(result[1]), stakeShareTarget: result[2] };
  }
  paused(): Promise<boolean> { return new Contract(this._contractAddress, ABI, this._provider).getFunction('paused')(); }
  async positionClaimCursor(positionId: number): Promise<number> { return Number(await new Contract(this._contractAddress, ABI, this._provider).getFunction('positionClaimCursor')(positionId)); }
  async previewStakerReward(positionId: number): Promise<bigint> {
    return (await this.previewStakerRewards([positionId]))[0]!;
  }

  async previewStakerRewards(positionIds: number[]): Promise<bigint[]> {
    if (positionIds.length === 0) return [];
    const blockTag = await this.provider.getBlockNumber();
    const reads = new Map<string, Promise<unknown>>();
    const read = <Value>(contract: Contract, method: string, ...args: (number | bigint)[]): Promise<Value> => {
      const key = `${contract.target}:${method}:${args.join(',')}`;
      let result = reads.get(key);
      if (!result) {
        result = contract.getFunction(method)(...args, { blockTag });
        reads.set(key, result!);
      }
      return result as Promise<Value>;
    };
    const rewards = new Contract(this.contractAddress, ABI, this.provider);
    const poolAddress = await read<string>(rewards, 'sellerPools');
    const pools = new Contract(poolAddress, POOLS_ABI, this.provider);
    const accounting = new Contract(await read<string>(rewards, 'usageAccounting'), ACCOUNTING_ABI, this.provider);
    const previewPosition = async (positionId: number): Promise<bigint> => {
      const position = await read<[string, bigint, bigint, bigint, bigint, bigint, bigint, boolean]>(pools, 'positions', positionId);
      if (position[0] === ZeroAddress) throw new Error(`Unknown position ${positionId}`);
      return previewPositionReward({
        id: positionId, owner: position[0], agentId: Number(position[1]), amount: position[2], weightAmount: position[3],
        stakeStartEpoch: Number(position[4]), stakeEndEpoch: Number(position[5]), closedAtEpoch: Number(position[6]), withdrawn: position[7],
      }, {
        currentEpoch: async () => Number(await read<bigint>(pools, 'currentEpoch')),
        claimCursor: async (id) => Number(await read<bigint>(rewards, 'positionClaimCursor', id)),
        indexCursor: async (agentId) => Number(await read<bigint>(rewards, 'poolRewardIndexNextEpoch', agentId) || await read<bigint>(rewards, 'initialIndexEpoch')),
        segment: async (id, epoch) => {
          const [normalEnd, maxLockPower, nextChange] = await read<[bigint, bigint, bigint]>(pools, 'positionPowerSegmentAt', id, epoch);
          return { normalEnd, maxLockPower, nextChange };
        },
        cumulative: async (agentId, epoch) => ({
          reward: await read<bigint>(rewards, 'poolCumulativeRewardPerWeightAt', agentId, epoch),
          epochReward: await read<bigint>(rewards, 'poolCumulativeEpochRewardPerWeightAt', agentId, epoch),
        }),
        rewardPerWeight: async (agentId, epoch) => {
          const weight = await read<bigint>(pools, 'poolWeightAtEpoch', agentId, epoch);
          if (weight === 0n) return 0n;
          const [settled, amount] = await read<[boolean, bigint]>(rewards, 'poolEpochEmissions', epoch, agentId);
          if (settled) return amount * REWARD_INDEX_SCALE / weight;
          const [points, total] = await Promise.all([
            read<bigint>(accounting, 'weightedPoolPointsByEpoch', epoch, agentId),
            read<bigint>(accounting, 'totalWeightedPoolPointsByEpoch', epoch),
          ]);
          if (points === 0n || total === 0n) return 0n;
          const budget = await read<bigint>(rewards, 'stakerEpochBudget', epoch);
          return (budget * points / total) * REWARD_INDEX_SCALE / weight;
        },
      });
    };
    const amounts: bigint[] = [];
    for (let offset = 0; offset < positionIds.length; offset += 16) {
      amounts.push(...await Promise.all(positionIds.slice(offset, offset + 16).map(previewPosition)));
    }
    return amounts;
  }

  async poolRewardIndexNextEpoch(agentId: number): Promise<number> {
    return Number(await new Contract(this.contractAddress, ABI, this.provider).getFunction('poolRewardIndexNextEpoch')(agentId));
  }
  async initialIndexEpoch(): Promise<number> {
    return Number(await new Contract(this.contractAddress, ABI, this.provider).getFunction('initialIndexEpoch')());
  }
  indexPoolRewards(signer: AbstractSigner, agentId: number, maxEpochs: number): Promise<string> {
    return this._execWrite(signer, ABI, 'indexPoolRewards', agentId, maxEpochs);
  }
}
