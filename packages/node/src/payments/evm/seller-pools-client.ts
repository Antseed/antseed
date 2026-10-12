import { Contract, Interface, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { multicallRead, type MulticallRequest } from './multicall.js';

export interface SellerPoolsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  antsTokenAddress: string;
  evmChainId?: number;
}

export interface SellerPoolPosition {
  id: number;
  owner: string;
  agentId: number;
  amount: bigint;
  weightAmount: bigint;
  stakeStartEpoch: number;
  stakeEndEpoch: number;
  closedAtEpoch: number;
  withdrawn: boolean;
}

export interface SellerPoolConfig {
  minStakeEpochs: number;
  maxStakeEpochs: number;
  stakeActivationDelay: number;
  maxSlashBps: number;
  minEarlyExitSlashBps: number;
  restakedRewardWeightBonusBps: number;
  moveWeightPenaltyBps: number;
}

export interface PositionPowerSegment {
  normalEndEpoch: number;
  maxLockPower: bigint;
  nextChangeEpoch: number;
}

const SELLER_POOLS_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event StakeCreated(uint256 indexed positionId, address indexed staker, uint256 indexed agentId, uint256 amount, uint256 weightAmount, uint256 stakeStartEpoch, uint256 stakeEndEpoch)',
  'function stake(uint256 agentId, uint256 amount, uint256 stakeEpochs) external returns (uint256 positionId)',
  'function moveStake(uint256 positionId, uint256 toAgentId) external returns (uint256 newPositionId)',
  'function moveStakes(uint256[] positionIds, uint256 toAgentId) external returns (uint256[] newPositionIds)',
  'function splitStake(uint256 positionId, uint256 splitAmount) external returns (uint256 firstPositionId, uint256 secondPositionId)',
  'function mergeStakes(uint256[] positionIds) external returns (uint256 newPositionId)',
  'function extendLock(uint256 positionId, uint256 additionalEpochs) external',
  'function enableMaxLock(uint256 positionId) external',
  'function disableMaxLock(uint256 positionId) external',
  'function withdrawStake(uint256 positionId) external',
  'function withdrawStakes(uint256[] positionIds) external returns (uint256 returnedAmount, uint256 slashedAmount)',
  'function stakerPositionCount(address staker) external view returns (uint256)',
  'function stakerPositionIds(address staker, uint256 offset, uint256 limit) external view returns (uint256[])',
  'function positions(uint256 positionId) external view returns (address owner, uint256 agentId, uint256 amount, uint256 weightAmount, uint64 stakeStartEpoch, uint64 stakeEndEpoch, uint64 closedAtEpoch, bool withdrawn)',
  'function positionWithdrawableEpoch(uint256 positionId) external view returns (uint64)',
  'function earlyExitSlashBps(uint256 positionId) external view returns (uint256)',
  'function positionWeightAtEpoch(uint256 positionId, uint256 epoch) external view returns (uint256)',
  'function positionMaxLockPowerAtEpoch(uint256 positionId, uint256 epoch) external view returns (uint256)',
  'function positionPowerSegmentAt(uint256 positionId, uint256 epoch) external view returns (uint256 normalEndEpoch, uint256 maxLockPower, uint256 nextChangeEpoch)',
  'function agentIdForSeller(address seller) external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function stakeActivationDelay() external view returns (uint256)',
  'function minStakeEpochs() external view returns (uint256)',
  'function MAX_STAKE_EPOCHS() external view returns (uint256)',
  'function maxSlashBps() external view returns (uint256)',
  'function minEarlyExitSlashBps() external view returns (uint256)',
  'function restakedRewardWeightBonusBps() external view returns (uint256)',
  'function moveWeightPenaltyBps() external view returns (uint256)',
  'function nextPositionId() external view returns (uint256)',
  'function stakingSource() external view returns (address)',
  'function hasPoolAtEpoch(uint256 agentId, uint256 epoch) external view returns (bool)',
  'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) external view returns (uint256)',
  'function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) external view returns (uint256)',
  'function totalActiveStakeAtEpoch(uint256 epoch) external view returns (uint256)',
  'function totalPowerWeightAtEpoch(uint256 epoch) external view returns (uint256)',
  'function currentPoolSecurityShareBps(uint256 agentId) external returns (uint256)',
  'function currentPoolSecurityWeight(uint256 agentId) external returns (uint256)',
  'function currentTotalSecurityWeight() external returns (uint256)',
  'function stakerTotalActiveStake(address staker) external view returns (uint256)',
  'function stakerAgentActiveStake(address staker, uint256 agentId) external view returns (uint256)',
] as const;

const SELLER_POOLS_IFACE = new Interface(SELLER_POOLS_ABI);

function requiredRead(results: Array<unknown[] | null>, index: number, method: string): unknown[] {
  const result = results[index];
  if (!result) throw new Error(`Seller pool read failed: ${method}. Retry when the RPC is available.`);
  return result;
}

export class SellerPoolsClient extends BaseEvmClient {
  private readonly antsTokenAddress: string;
  constructor(config: SellerPoolsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this.antsTokenAddress = config.antsTokenAddress;
  }
  private contract(): Contract { return new Contract(this._contractAddress, SELLER_POOLS_ABI, this._provider); }

  // ── writes ──────────────────────────────────────────────────────────
  stake(signer: AbstractSigner, agentId: number, amount: bigint, epochs: number): Promise<string> {
    return this._approveAndExec(signer, this.antsTokenAddress, amount, SELLER_POOLS_ABI, 'stake', agentId, amount, epochs);
  }
  moveStake(signer: AbstractSigner, positionId: number, toAgentId: number): Promise<string> {
    return this._execWrite(signer, SELLER_POOLS_ABI, 'moveStake', positionId, toAgentId);
  }
  moveStakes(signer: AbstractSigner, positionIds: number[], toAgentId: number): Promise<string> {
    return this._execWrite(signer, SELLER_POOLS_ABI, 'moveStakes', positionIds, toAgentId);
  }
  splitStake(signer: AbstractSigner, positionId: number, splitAmount: bigint): Promise<string> {
    return this._execWrite(signer, SELLER_POOLS_ABI, 'splitStake', positionId, splitAmount);
  }
  mergeStakes(signer: AbstractSigner, positionIds: number[]): Promise<string> {
    return this._execWrite(signer, SELLER_POOLS_ABI, 'mergeStakes', positionIds);
  }
  extendLock(signer: AbstractSigner, positionId: number, additionalEpochs: number): Promise<string> {
    return this._execWrite(signer, SELLER_POOLS_ABI, 'extendLock', positionId, additionalEpochs);
  }
  enableMaxLock(signer: AbstractSigner, positionId: number): Promise<string> {
    return this._execWrite(signer, SELLER_POOLS_ABI, 'enableMaxLock', positionId);
  }
  disableMaxLock(signer: AbstractSigner, positionId: number): Promise<string> {
    return this._execWrite(signer, SELLER_POOLS_ABI, 'disableMaxLock', positionId);
  }
  withdrawStakes(signer: AbstractSigner, ids: number[]): Promise<string> { return this._execWrite(signer, SELLER_POOLS_ABI, 'withdrawStakes', ids); }

  // ── position reads ──────────────────────────────────────────────────
  async stakerPositionCount(staker: string): Promise<number> { return Number(await this.contract().getFunction('stakerPositionCount')(staker)); }
  async stakerPositionIds(staker: string, offset = 0, limit = 256): Promise<number[]> {
    const ids = await this.contract().getFunction('stakerPositionIds')(staker, offset, limit) as bigint[];
    return ids.map(Number);
  }
  async position(id: number): Promise<SellerPoolPosition> {
    const result = await this.contract().getFunction('positions')(id);
    return { id, owner: result[0], agentId: Number(result[1]), amount: result[2], weightAmount: result[3], stakeStartEpoch: Number(result[4]), stakeEndEpoch: Number(result[5]), closedAtEpoch: Number(result[6]), withdrawn: result[7] };
  }
  async positionsBatch(ids: number[]): Promise<SellerPoolPosition[]> {
    const results = await multicallRead(this.provider, ids.map(id => ({ target: this.contractAddress, iface: SELLER_POOLS_IFACE, method: 'positions', args: [id] })));
    return ids.map((id, index) => {
      const result = requiredRead(results, index, `positions(${id})`) as [string, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
      return { id, owner: result[0], agentId: Number(result[1]), amount: result[2], weightAmount: result[3], stakeStartEpoch: Number(result[4]), stakeEndEpoch: Number(result[5]), closedAtEpoch: Number(result[6]), withdrawn: result[7] };
    });
  }
  /** `maxLockedNext` is the max-lock state from the next epoch, where enable/disable changes take effect. */
  async positionStatusesBatch(positions: SellerPoolPosition[], currentEpoch: number): Promise<Array<{ withdrawableEpoch: number; maxLocked: boolean; maxLockedNext: boolean; slashBps: number | null }>> {
    const requests: MulticallRequest[] = [];
    const add = (method: string, args: number[]): number => {
      requests.push({ target: this.contractAddress, iface: SELLER_POOLS_IFACE, method, args });
      return requests.length - 1;
    };
    const indices = positions.map(position => {
      const open = !position.withdrawn && position.closedAtEpoch === 0;
      return {
        withdrawable: add('positionWithdrawableEpoch', [position.id]),
        maxLock: open ? add('positionMaxLockPowerAtEpoch', [position.id, Math.max(currentEpoch, position.stakeStartEpoch)]) : null,
        maxLockNext: open ? add('positionMaxLockPowerAtEpoch', [position.id, Math.max(currentEpoch + 1, position.stakeStartEpoch)]) : null,
        slash: open ? add('earlyExitSlashBps', [position.id]) : null,
      };
    });
    const results = await multicallRead(this.provider, requests);
    const read = (index: number): bigint => requiredRead(results, index, requests[index]!.method)[0] as bigint;
    return indices.map(({ withdrawable, maxLock, maxLockNext, slash }) => {
      const withdrawableEpoch = Number(read(withdrawable));
      return {
        withdrawableEpoch,
        maxLocked: maxLock !== null && read(maxLock) !== 0n,
        maxLockedNext: maxLockNext !== null && read(maxLockNext) !== 0n,
        slashBps: slash !== null && currentEpoch >= withdrawableEpoch ? Number(read(slash)) : null,
      };
    });
  }
  async positionWithdrawableEpoch(id: number): Promise<number> { return Number(await this.contract().getFunction('positionWithdrawableEpoch')(id)); }
  async earlyExitSlashBps(id: number): Promise<number> { return Number(await this.contract().getFunction('earlyExitSlashBps')(id)); }
  positionWeightAtEpoch(id: number, epoch: number): Promise<bigint> { return this.contract().getFunction('positionWeightAtEpoch')(id, epoch); }
  positionMaxLockPowerAtEpoch(id: number, epoch: number): Promise<bigint> { return this.contract().getFunction('positionMaxLockPowerAtEpoch')(id, epoch); }
  async positionPowerSegmentAt(id: number, epoch: number): Promise<PositionPowerSegment> {
    const [normalEndEpoch, maxLockPower, nextChangeEpoch] = await this.contract().getFunction('positionPowerSegmentAt')(id, epoch) as [bigint, bigint, bigint];
    return { normalEndEpoch: Number(normalEndEpoch), maxLockPower, nextChangeEpoch: Number(nextChangeEpoch) };
  }
  async isMaxLocked(id: number, epoch: number): Promise<boolean> {
    return (await this.positionMaxLockPowerAtEpoch(id, epoch)) !== 0n;
  }

  // ── pool / config reads ─────────────────────────────────────────────
  async agentIdForSeller(seller: string): Promise<number> { return Number(await this.contract().getFunction('agentIdForSeller')(seller)); }
  async currentEpoch(): Promise<number> { return Number(await this.contract().getFunction('currentEpoch')()); }
  async stakeActivationDelay(): Promise<number> { return Number(await this.contract().getFunction('stakeActivationDelay')()); }
  async minStakeEpochs(): Promise<number> { return Number(await this.contract().getFunction('minStakeEpochs')()); }
  async maxStakeEpochs(): Promise<number> { return Number(await this.contract().getFunction('MAX_STAKE_EPOCHS')()); }
  async nextPositionId(): Promise<number> { return Number(await this.contract().getFunction('nextPositionId')()); }
  stakingSource(): Promise<string> { return this.contract().getFunction('stakingSource')(); }
  async poolConfig(): Promise<SellerPoolConfig> {
    const methods = ['minStakeEpochs', 'MAX_STAKE_EPOCHS', 'stakeActivationDelay', 'maxSlashBps', 'minEarlyExitSlashBps', 'restakedRewardWeightBonusBps', 'moveWeightPenaltyBps'];
    const results = await multicallRead(this.provider, methods.map(method => ({ target: this.contractAddress, iface: SELLER_POOLS_IFACE, method })));
    const [minStakeEpochs, maxStakeEpochs, stakeActivationDelay, maxSlashBps, minEarlyExitSlashBps, restakedRewardWeightBonusBps, moveWeightPenaltyBps] = methods.map((method, index) => requiredRead(results, index, method)[0] as bigint);
    return {
      minStakeEpochs: Number(minStakeEpochs), maxStakeEpochs: Number(maxStakeEpochs), stakeActivationDelay: Number(stakeActivationDelay),
      maxSlashBps: Number(maxSlashBps), minEarlyExitSlashBps: Number(minEarlyExitSlashBps),
      restakedRewardWeightBonusBps: Number(restakedRewardWeightBonusBps), moveWeightPenaltyBps: Number(moveWeightPenaltyBps),
    };
  }
  hasPoolAtEpoch(agentId: number, epoch: number): Promise<boolean> { return this.contract().getFunction('hasPoolAtEpoch(uint256,uint256)')(agentId, epoch); }
  poolWeightAtEpoch(agentId: number, epoch: number): Promise<bigint> { return this.contract().getFunction('poolWeightAtEpoch(uint256,uint256)')(agentId, epoch); }
  poolActiveStakeAtEpoch(agentId: number, epoch: number): Promise<bigint> { return this.contract().getFunction('poolActiveStakeAtEpoch(uint256,uint256)')(agentId, epoch); }
  totalActiveStakeAtEpoch(epoch: number): Promise<bigint> { return this.contract().getFunction('totalActiveStakeAtEpoch')(epoch); }
  totalPowerWeightAtEpoch(epoch: number): Promise<bigint> { return this.contract().getFunction('totalPowerWeightAtEpoch')(epoch); }
  /** Non-view on chain (caches the current epoch's weight); read through a static call. */
  async currentPoolSecurityShareBps(agentId: number): Promise<number> {
    return Number(await this.contract().getFunction('currentPoolSecurityShareBps(uint256)').staticCall(agentId));
  }
  currentPoolSecurityWeight(agentId: number): Promise<bigint> { return this.contract().getFunction('currentPoolSecurityWeight(uint256)').staticCall(agentId); }
  currentTotalSecurityWeight(): Promise<bigint> { return this.contract().getFunction('currentTotalSecurityWeight').staticCall(); }
  stakerTotalActiveStake(staker: string): Promise<bigint> { return this.contract().getFunction('stakerTotalActiveStake')(staker); }
  stakerAgentActiveStake(staker: string, agentId: number): Promise<bigint> { return this.contract().getFunction('stakerAgentActiveStake')(staker, agentId); }

  allStakerPositionIds(staker: string): Promise<number[]> {
    return collectPositionIds((offset, limit) => this.stakerPositionIds(staker, offset, limit));
  }
}

async function collectPositionIds(readPage: (offset: number, limit: number) => Promise<number[]>): Promise<number[]> {
  const ids: number[] = [];
  for (let offset = 0; ; offset += 256) {
    const page = await readPage(offset, 256);
    ids.push(...page);
    if (page.length < 256) return ids;
  }
}

export interface EarlyExitEstimate {
  id: number;
  amount: bigint;
  slashBps: number;
  slashedAmount: bigint;
  returnedAmount: bigint;
}

export function estimateEarlyExit(position: SellerPoolPosition, slashBps: number): EarlyExitEstimate {
  const slashedAmount = position.amount * BigInt(slashBps) / 10_000n;
  return {
    id: position.id,
    amount: position.amount,
    slashBps,
    slashedAmount,
    returnedAmount: position.amount - slashedAmount,
  };
}

export type PositionState = 'pending' | 'active' | 'matured' | 'closed' | 'withdrawn';

export function positionState(position: SellerPoolPosition, currentEpoch: number): PositionState {
  if (position.withdrawn) return 'withdrawn';
  if (position.closedAtEpoch !== 0) return 'closed';
  if (currentEpoch < position.stakeStartEpoch) return 'pending';
  if (currentEpoch < position.stakeEndEpoch) return 'active';
  return 'matured';
}

/**
 * Off-chain mirror of the pool's early-exit slash curve, for previews before
 * a position is withdrawable (the on-chain getter reverts while a change is
 * pending). Whole-epoch integer arithmetic matches the contract.
 */
export function projectedEarlyExitSlashBps(
  position: SellerPoolPosition,
  epoch: number,
  config: Pick<SellerPoolConfig, 'maxSlashBps' | 'minEarlyExitSlashBps'>,
  maxLocked = false,
): number {
  if (maxLocked) return config.maxSlashBps;
  const closeEpoch = Math.max(epoch, position.stakeStartEpoch);
  if (closeEpoch >= position.stakeEndEpoch) return 0;
  const total = position.stakeEndEpoch - position.stakeStartEpoch;
  if (total <= 0) return 0;
  const remaining = position.stakeEndEpoch - closeEpoch;
  const linear = Math.floor(config.maxSlashBps * remaining / total);
  return Math.max(config.minEarlyExitSlashBps, Math.min(config.maxSlashBps, linear));
}
