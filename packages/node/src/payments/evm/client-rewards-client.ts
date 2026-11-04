import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { scanEpochRewards } from '../reward-claims.js';
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
  'function emissionsGate() external view returns (address)',
  'function identityRegistry() external view returns (address)',
  'function isClaimable(uint256 epoch) external view returns (bool)',
  'function clientEpochClaimed(uint256 clientAgentId, uint256 epoch) external view returns (bool)',
  'function pendingClientReward(uint256 clientAgentId, uint256 epoch) external view returns (uint256)',
  'function claimClientReward(uint256 clientAgentId, uint256 epoch) external',
  'event ClientRewardClaimed(address indexed recipient, uint256 indexed clientAgentId, uint256 indexed epoch, uint256 weightedPoints, uint256 totalWeightedPoints, uint256 grossAmount, uint256 claimableAmount, uint256 reserveAmount)',
] as const;

/**
 * Read/claim client for AntseedClientRewards (the builders program). A client
 * app earns its share of all recognized buyer usage in an epoch, applied to the
 * epoch's bucket, capped at 5% of it with the excess going to the emissions
 * reserve; usage is credited to the app's ERC-8004 agent. Only
 * `ownerOf(clientAgentId)` can claim; there is no batch claim, so several
 * epochs take one transaction each.
 */
export class ClientRewardsClient extends BaseEvmClient {
  constructor(config: ClientRewardsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private contract(): Contract {
    return new Contract(this._contractAddress, CLIENT_REWARDS_ABI, this._provider);
  }

  pendingReward(clientAgentId: number, epoch: number): Promise<bigint> {
    return this.contract().getFunction('pendingClientReward')(clientAgentId, epoch);
  }

  claimed(clientAgentId: number, epoch: number): Promise<boolean> {
    return this.contract().getFunction('clientEpochClaimed')(clientAgentId, epoch);
  }

  async currentEpoch(): Promise<number> {
    const gate = await this.contract().getFunction('emissionsGate')() as string;
    const contract = new Contract(gate, ['function currentEpoch() external view returns (uint256)'], this._provider);
    return Number(await contract.getFunction('currentEpoch')());
  }

  /**
   * Epochs with a non-zero payable reward for `clientAgentId`, scanning the
   * last `lookback` claimable epochs (unclaimed, claimable, budget available).
   */
  async pendingRewards(clientAgentId: number, lookback = 26): Promise<ClientEpochReward[]> {
    return scanEpochRewards(await this.currentEpoch(), (epoch) => this.pendingReward(clientAgentId, epoch), lookback);
  }

  /** Mint the client's share of `epoch` to its agent owner, who must be `signer`. */
  claim(signer: AbstractSigner, clientAgentId: number, epoch: number): Promise<string> {
    return this._execWrite(signer, CLIENT_REWARDS_ABI, 'claimClientReward', clientAgentId, epoch);
  }
}
