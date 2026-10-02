import { Contract, Interface, ZeroAddress, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { previewPositionReward, REWARD_INDEX_SCALE } from '../reward-preview.js';
import { multicallRead, MULTICALL3_ADDRESS, type MulticallRequest } from './multicall.js';

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
const REWARDS_IFACE = new Interface(ABI);
const POOLS_IFACE = new Interface(POOLS_ABI);
const ACCOUNTING_IFACE = new Interface(ACCOUNTING_ABI);

/**
 * Run `callback` on the next task. Unlike `setTimeout`, neither `setImmediate`
 * nor a `MessageChannel` message is throttled in background browser tabs.
 */
function nextTask(callback: () => void): void {
  if (typeof setImmediate === 'function') { setImmediate(callback); return; }
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    (channel.port1 as unknown as { onmessage: (() => void) | null }).onmessage = () => { channel.port1.close(); callback(); };
    channel.port2.postMessage(null);
    return;
  }
  setTimeout(callback, 0);
}

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

  /**
   * Exact pending staker rewards, read at one block. The per-position walk in
   * `previewPositionReward` is unchanged; every read it issues in the same tick
   * (across all positions) is coalesced into one Multicall3 `aggregate3`, so a
   * wallet costs one request per algorithm step instead of one per read.
   * Chains without Multicall3 fall back to individual calls.
   */
  async previewStakerRewards(positionIds: number[]): Promise<bigint[]> {
    if (positionIds.length === 0) return [];
    const [blockTag, batched] = await Promise.all([this.provider.getBlockNumber(), this.multicallAvailable()]);
    const reads = new Map<string, Promise<unknown>>();
    let queue: Array<{ request: MulticallRequest; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
    const flush = async () => {
      const pending = queue;
      queue = [];
      try {
        const values = await multicallRead(this.provider, pending.map(entry => entry.request), { blockTag, assumeDeployed: true });
        pending.forEach((entry, index) => {
          const value = values[index];
          if (!value) entry.reject(new Error(`Reward preview read failed: ${entry.request.method}`));
          else entry.resolve(value.length === 1 ? value[0] : value);
        });
      } catch (error) {
        for (const entry of pending) entry.reject(error);
      }
    };
    const read = <Value>(target: string, iface: Interface, method: string, ...args: (number | bigint)[]): Promise<Value> => {
      const key = `${target}:${method}:${args.join(',')}`;
      let result = reads.get(key);
      if (!result) {
        if (batched) {
          result = new Promise((resolve, reject) => {
            // Flush on the next task so every position's pending microtasks enqueue their reads first.
            if (queue.length === 0) nextTask(() => void flush());
            queue.push({ request: { target, iface, method, args }, resolve, reject });
          });
        } else {
          result = new Contract(target, iface, this.provider).getFunction(method)(...args, { blockTag });
        }
        reads.set(key, result);
      }
      return result as Promise<Value>;
    };
    const rewards = this.contractAddress;
    const [pools, accounting] = await Promise.all([
      read<string>(rewards, REWARDS_IFACE, 'sellerPools'),
      read<string>(rewards, REWARDS_IFACE, 'usageAccounting'),
    ]);
    const previewPosition = async (positionId: number): Promise<bigint> => {
      const position = await read<[string, bigint, bigint, bigint, bigint, bigint, bigint, boolean]>(pools, POOLS_IFACE, 'positions', positionId);
      if (position[0] === ZeroAddress) throw new Error(`Unknown position ${positionId}`);
      return previewPositionReward({
        id: positionId, owner: position[0], agentId: Number(position[1]), amount: position[2], weightAmount: position[3],
        stakeStartEpoch: Number(position[4]), stakeEndEpoch: Number(position[5]), closedAtEpoch: Number(position[6]), withdrawn: position[7],
      }, {
        currentEpoch: async () => Number(await read<bigint>(pools, POOLS_IFACE, 'currentEpoch')),
        claimCursor: async (id) => Number(await read<bigint>(rewards, REWARDS_IFACE, 'positionClaimCursor', id)),
        indexCursor: async (agentId) => Number(await read<bigint>(rewards, REWARDS_IFACE, 'poolRewardIndexNextEpoch', agentId) || await read<bigint>(rewards, REWARDS_IFACE, 'initialIndexEpoch')),
        segment: async (id, epoch) => {
          const [normalEnd, maxLockPower, nextChange] = await read<[bigint, bigint, bigint]>(pools, POOLS_IFACE, 'positionPowerSegmentAt', id, epoch);
          return { normalEnd, maxLockPower, nextChange };
        },
        cumulative: async (agentId, epoch) => {
          const [reward, epochReward] = await Promise.all([
            read<bigint>(rewards, REWARDS_IFACE, 'poolCumulativeRewardPerWeightAt', agentId, epoch),
            read<bigint>(rewards, REWARDS_IFACE, 'poolCumulativeEpochRewardPerWeightAt', agentId, epoch),
          ]);
          return { reward, epochReward };
        },
        rewardPerWeight: async (agentId, epoch) => {
          const weight = await read<bigint>(pools, POOLS_IFACE, 'poolWeightAtEpoch', agentId, epoch);
          if (weight === 0n) return 0n;
          const [settled, amount] = await read<[boolean, bigint]>(rewards, REWARDS_IFACE, 'poolEpochEmissions', epoch, agentId);
          if (settled) return amount * REWARD_INDEX_SCALE / weight;
          const [points, total] = await Promise.all([
            read<bigint>(accounting, ACCOUNTING_IFACE, 'weightedPoolPointsByEpoch', epoch, agentId),
            read<bigint>(accounting, ACCOUNTING_IFACE, 'totalWeightedPoolPointsByEpoch', epoch),
          ]);
          if (points === 0n || total === 0n) return 0n;
          const budget = await read<bigint>(rewards, REWARDS_IFACE, 'stakerEpochBudget', epoch);
          return (budget * points / total) * REWARD_INDEX_SCALE / weight;
        },
      });
    };
    if (batched) return Promise.all(positionIds.map(previewPosition));
    const amounts: bigint[] = [];
    for (let offset = 0; offset < positionIds.length; offset += 16) {
      amounts.push(...await Promise.all(positionIds.slice(offset, offset + 16).map(previewPosition)));
    }
    return amounts;
  }

  private multicallProbe: { provider: unknown; result: Promise<boolean> } | null = null;
  /** Multicall3 deployment check, once per provider; a failed probe is retried on the next preview. */
  private multicallAvailable(): Promise<boolean> {
    if (this.multicallProbe?.provider !== this.provider) {
      const result = this.provider.getCode(MULTICALL3_ADDRESS).then(code => code !== '0x');
      const probe = { provider: this.provider, result };
      this.multicallProbe = probe;
      result.catch(() => { if (this.multicallProbe === probe) this.multicallProbe = null; });
    }
    return this.multicallProbe!.result;
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
