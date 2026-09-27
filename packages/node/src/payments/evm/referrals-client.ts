import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ReferralsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface ReferralEpochReward {
  epoch: number;
  amount: bigint;
}

const REFERRALS_ABI = [
  'function referrerOf(address buyer) external view returns (address)',
  'function boundAtEpoch(address buyer) external view returns (uint256)',
  'function referredCount(address referrer) external view returns (uint256)',
  'function isClaimable(uint256 epoch) external view returns (bool)',
  'function claimed(uint256 epoch, address referrer) external view returns (bool)',
  'function pendingReward(address referrer, uint256 epoch) external view returns (uint256)',
  'function usageAccounting() external view returns (address)',
  'function claim(address referrer, uint256 epoch) external',
  'function claimEpochs(address referrer, uint256[] epochs) external',
  'event ReferralBound(address indexed buyer, address indexed referrer, uint256 epoch)',
] as const;

/**
 * Read/claim client for AntseedReferrals. Binding is not exposed here: it
 * happens on-chain when AntseedStatsV2 decodes the referrer the buyer signed
 * into its settlement metadata (see `UsageAttribution` in @antseed/protocol).
 * Rewards are a per-epoch share of the referral emission bucket, pro rata to
 * the recognized usage of the referrer's buyers.
 */
export class ReferralsClient extends BaseEvmClient {
  constructor(config: ReferralsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private contract(): Contract {
    return new Contract(this._contractAddress, REFERRALS_ABI, this._provider);
  }

  referrerOf(buyer: string): Promise<string> {
    return this.contract().getFunction('referrerOf')(buyer);
  }

  async referredCount(referrer: string): Promise<number> {
    return Number(await this.contract().getFunction('referredCount')(referrer));
  }

  pendingReward(referrer: string, epoch: number): Promise<bigint> {
    return this.contract().getFunction('pendingReward')(referrer, epoch);
  }

  async currentEpoch(): Promise<number> {
    const accounting = await this.contract().getFunction('usageAccounting')() as string;
    const contract = new Contract(accounting, ['function currentEpoch() external view returns (uint256)'], this._provider);
    return Number(await contract.getFunction('currentEpoch')());
  }

  /** Buyers bound to `referrer`, from ReferralBound logs. */
  async referredBuyers(referrer: string, fromBlock: number | bigint = 0): Promise<string[]> {
    const filter = this.contract().filters['ReferralBound']!(null, referrer);
    const logs = await this.contract().queryFilter(filter, fromBlock);
    const buyers = new Set<string>();
    for (const log of logs) {
      if ('args' in log && typeof log.args?.[0] === 'string') buyers.add(log.args[0]);
    }
    return [...buyers];
  }

  /**
   * Epochs with a non-zero payable reward for `referrer`, scanning the last
   * `lookback` claimable epochs (unclaimed, claimable, budget available).
   */
  async pendingRewards(referrer: string, lookback = 26): Promise<ReferralEpochReward[]> {
    const current = await this.currentEpoch();
    const latestClaimable = current - 2; // one finalized epoch plus the settlement grace epoch
    if (latestClaimable < 0) return [];
    const from = Math.max(0, latestClaimable - lookback + 1);
    const epochs = Array.from({ length: latestClaimable - from + 1 }, (_, i) => from + i);
    const amounts = await Promise.all(epochs.map((epoch) => this.pendingReward(referrer, epoch)));
    return epochs.map((epoch, i) => ({ epoch, amount: amounts[i]! })).filter((entry) => entry.amount > 0n);
  }

  claim(signer: AbstractSigner, referrer: string, epoch: number): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'claim', referrer, epoch);
  }

  claimEpochs(signer: AbstractSigner, referrer: string, epochs: number[]): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'claimEpochs', referrer, epochs);
  }
}
