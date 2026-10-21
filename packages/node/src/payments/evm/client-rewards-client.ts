import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ClientRewardsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface ClientEpochReward {
  epoch: number;
  amount: bigint;
}

const CLIENT_REWARDS_ABI = [
  'function attributionUsage() external view returns (address)',
  'function identityRegistry() external view returns (address)',
  'function isClaimable(uint256 epoch) external view returns (bool)',
  'function claimed(uint256 clientAgentId, uint256 epoch) external view returns (bool)',
  'function pendingReward(uint256 clientAgentId, uint256 epoch) external view returns (uint256)',
  'function claim(uint256 clientAgentId, uint256 epoch) external',
  'event ClientRewardClaimed(uint256 indexed epoch, uint256 indexed clientAgentId, address indexed recipient, uint256 points, uint256 totalPoints, uint256 amount)',
] as const;

/**
 * Read/claim client for AntseedClientRewards (the builders program). Each
 * epoch's bucket is split among client apps pro rata to the recognized usage
 * AntseedAttributionUsage credited to their ERC-8004 agent. Claims are
 * permissionless and always pay `ownerOf(clientAgentId)`; there is no batch
 * claim, so several epochs take one transaction each.
 */
export class ClientRewardsClient extends BaseEvmClient {
  constructor(config: ClientRewardsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private contract(): Contract {
    return new Contract(this._contractAddress, CLIENT_REWARDS_ABI, this._provider);
  }

  pendingReward(clientAgentId: number, epoch: number): Promise<bigint> {
    return this.contract().getFunction('pendingReward')(clientAgentId, epoch);
  }

  claimed(clientAgentId: number, epoch: number): Promise<boolean> {
    return this.contract().getFunction('claimed')(clientAgentId, epoch);
  }

  async currentEpoch(): Promise<number> {
    // AttributionUsage reads epochs from the same AntseedUsageAccounting clock.
    const attribution = await this.contract().getFunction('attributionUsage')() as string;
    const usage = new Contract(attribution, ['function usageAccounting() external view returns (address)'], this._provider);
    const accounting = await usage.getFunction('usageAccounting')() as string;
    const contract = new Contract(accounting, ['function currentEpoch() external view returns (uint256)'], this._provider);
    return Number(await contract.getFunction('currentEpoch')());
  }

  /**
   * Epochs with a non-zero payable reward for `clientAgentId`, scanning the
   * last `lookback` claimable epochs (unclaimed, claimable, budget available).
   */
  async pendingRewards(clientAgentId: number, lookback = 26): Promise<ClientEpochReward[]> {
    const current = await this.currentEpoch();
    const latestClaimable = current - 2; // one finalized epoch plus the settlement grace epoch
    if (latestClaimable < 0) return [];
    const from = Math.max(0, latestClaimable - lookback + 1);
    const epochs = Array.from({ length: latestClaimable - from + 1 }, (_, i) => from + i);
    const amounts = await Promise.all(epochs.map((epoch) => this.pendingReward(clientAgentId, epoch)));
    return epochs.map((epoch, i) => ({ epoch, amount: amounts[i]! })).filter((entry) => entry.amount > 0n);
  }

  /** Mint the client's share of `epoch` to its agent owner; any signer may send it. */
  claim(signer: AbstractSigner, clientAgentId: number, epoch: number): Promise<string> {
    return this._execWrite(signer, CLIENT_REWARDS_ABI, 'claim', clientAgentId, epoch);
  }
}
