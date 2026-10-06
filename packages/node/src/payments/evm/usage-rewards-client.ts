import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface UsageRewardsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface DynamicUsageConfig {
  buyerMinShareBps: number;
  buyerMaxShareBps: number;
  sellerMinShareBps: number;
  sellerMaxShareBps: number;
  volumeShareTarget: bigint;
}

const USAGE_REWARDS_ABI = [
  'function pendingAgentReward(uint256 agentId, uint256 epoch) external view returns (uint256)',
  'function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256)',
  'function agentEpochClaimed(uint256 agentId, uint256 epoch) external view returns (bool)',
  'function buyerEpochClaimed(address buyer, uint256 epoch) external view returns (bool)',
  'function claimAgentReward(uint256 agentId, uint256 epoch) external',
  'function claimBuyerReward(address buyer, uint256 epoch) external',
  'function stakeAgentReward(uint256 agentId, uint256 epoch, uint256 stakeEpochs) external returns (uint256 newPositionId)',
  'function stakeBuyerReward(address buyer, uint256 epoch, uint256 stakeAgentId, uint256 stakeEpochs) external returns (uint256 newPositionId)',
  'function rewardRecipient(uint256 agentId) external view returns (address)',
  'function buyerEpochBudget(uint256 epoch) external view returns (uint256)',
  'function sellerEpochBudget(uint256 epoch) external view returns (uint256)',
  'function usageEpochBudgets(uint256 epoch) external view returns (uint256 buyerBudget, uint256 sellerBudget)',
  'function allocatedEpochBudget(uint256 epoch) external view returns (uint256)',
  'function dynamicUsageConfigAt(uint256 epoch) external view returns (tuple(uint32 buyerMinShareBps, uint32 buyerMaxShareBps, uint32 sellerMinShareBps, uint32 sellerMaxShareBps, uint256 volumeShareTarget))',
  'function operatorSource() external view returns (address)',
  'function claimForwarder() external view returns (address)',
  'function paused() external view returns (bool)',
  'function MAX_REWARD_SHARE_BPS() external view returns (uint256)',
] as const;

export class UsageRewardsClient extends BaseEvmClient {
  constructor(config: UsageRewardsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }
  private contract(): Contract { return new Contract(this._contractAddress, USAGE_REWARDS_ABI, this._provider); }

  pendingAgentReward(agentId: number, epoch: number): Promise<bigint> { return this.contract().getFunction('pendingAgentReward')(agentId, epoch); }
  pendingBuyerReward(buyer: string, epoch: number): Promise<bigint> { return this.contract().getFunction('pendingBuyerReward')(buyer, epoch); }
  agentEpochClaimed(agentId: number, epoch: number): Promise<boolean> { return this.contract().getFunction('agentEpochClaimed')(agentId, epoch); }
  buyerEpochClaimed(buyer: string, epoch: number): Promise<boolean> { return this.contract().getFunction('buyerEpochClaimed')(buyer, epoch); }
  claimAgentReward(signer: AbstractSigner, agentId: number, epoch: number): Promise<string> { return this._execWrite(signer, USAGE_REWARDS_ABI, 'claimAgentReward', agentId, epoch); }
  claimBuyerReward(signer: AbstractSigner, buyer: string, epoch: number): Promise<string> { return this._execWrite(signer, USAGE_REWARDS_ABI, 'claimBuyerReward', buyer, epoch); }
  /** Claim an agent's usage reward straight into a new locked pool position (agent owner only). */
  stakeAgentReward(signer: AbstractSigner, agentId: number, epoch: number, stakeEpochs: number): Promise<string> {
    return this._execWrite(signer, USAGE_REWARDS_ABI, 'stakeAgentReward', agentId, epoch, stakeEpochs);
  }
  /** Claim a buyer's usage reward straight into a new locked pool position (deposits operator only). */
  stakeBuyerReward(signer: AbstractSigner, buyer: string, epoch: number, stakeAgentId: number, stakeEpochs: number): Promise<string> {
    return this._execWrite(signer, USAGE_REWARDS_ABI, 'stakeBuyerReward', buyer, epoch, stakeAgentId, stakeEpochs);
  }
  rewardRecipient(agentId: number): Promise<string> { return this.contract().getFunction('rewardRecipient')(agentId); }
  buyerEpochBudget(epoch: number): Promise<bigint> { return this.contract().getFunction('buyerEpochBudget')(epoch); }
  sellerEpochBudget(epoch: number): Promise<bigint> { return this.contract().getFunction('sellerEpochBudget')(epoch); }
  async usageEpochBudgets(epoch: number): Promise<{ buyer: bigint; seller: bigint }> {
    const [buyer, seller] = await this.contract().getFunction('usageEpochBudgets')(epoch) as [bigint, bigint];
    return { buyer, seller };
  }
  allocatedEpochBudget(epoch: number): Promise<bigint> { return this.contract().getFunction('allocatedEpochBudget')(epoch); }
  async dynamicUsageConfigAt(epoch: number): Promise<DynamicUsageConfig> {
    const result = await this.contract().getFunction('dynamicUsageConfigAt')(epoch);
    return {
      buyerMinShareBps: Number(result[0]), buyerMaxShareBps: Number(result[1]),
      sellerMinShareBps: Number(result[2]), sellerMaxShareBps: Number(result[3]), volumeShareTarget: result[4],
    };
  }
  operatorSource(): Promise<string> { return this.contract().getFunction('operatorSource')(); }
  claimForwarder(): Promise<string> { return this.contract().getFunction('claimForwarder')(); }
  paused(): Promise<boolean> { return this.contract().getFunction('paused')(); }
  async maxRewardShareBps(): Promise<number> { return Number(await this.contract().getFunction('MAX_REWARD_SHARE_BPS')()); }
}
