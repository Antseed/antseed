import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ReferralsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

const REFERRALS_ABI = [
  'function referrerOf(address buyer) external view returns (address)',
  'function boundAtEpoch(address buyer) external view returns (uint256)',
  'function nextAccrualEpoch(address buyer) external view returns (uint256)',
  'function claimable(address referrer) external view returns (uint256)',
  'function referredCount(address referrer) external view returns (uint256)',
  'function unallocated() external view returns (uint256)',
  'function REFERRAL_RATE_BPS() external view returns (uint32)',
  'function usageAccounting() external view returns (address)',
  'function accrue(address buyer, uint256 throughEpoch) external',
  'function claim() external',
  'event ReferralBound(address indexed buyer, address indexed referrer, uint256 epoch)',
] as const;

/**
 * Read/accrue/claim client for AntseedReferrals. Binding is not exposed here:
 * it happens on-chain when AntseedStats decodes the referrer the buyer signed
 * into its settlement metadata (see `UsageAttribution` in @antseed/protocol).
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

  nextAccrualEpoch(buyer: string): Promise<bigint> {
    return this.contract().getFunction('nextAccrualEpoch')(buyer);
  }

  claimable(referrer: string): Promise<bigint> {
    return this.contract().getFunction('claimable')(referrer);
  }

  async referredCount(referrer: string): Promise<number> {
    return Number(await this.contract().getFunction('referredCount')(referrer));
  }

  unallocated(): Promise<bigint> {
    return this.contract().getFunction('unallocated')();
  }

  async referralRateBps(): Promise<number> {
    return Number(await this.contract().getFunction('REFERRAL_RATE_BPS')());
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

  /** Buyers still owed accrual for at least one finalized epoch. */
  async accruableBuyers(referrer: string, fromBlock: number | bigint = 0): Promise<Array<{ buyer: string; throughEpoch: number }>> {
    const [buyers, currentEpoch] = await Promise.all([this.referredBuyers(referrer, fromBlock), this.currentEpoch()]);
    const throughEpoch = currentEpoch - 1;
    if (throughEpoch < 0) return [];
    const pending = await Promise.all(buyers.map(async (buyer) => ({
      buyer,
      next: Number(await this.nextAccrualEpoch(buyer)),
    })));
    return pending.filter((p) => p.next <= throughEpoch).map((p) => ({ buyer: p.buyer, throughEpoch }));
  }

  accrue(signer: AbstractSigner, buyer: string, throughEpoch: number): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'accrue', buyer, throughEpoch);
  }

  claim(signer: AbstractSigner): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'claim');
  }
}
