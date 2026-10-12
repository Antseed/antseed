import { Contract, ZeroAddress, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface SellerRewardsPoolClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }

const ABI = [
  'function lockedRewards(address seller) external view returns (uint256)',
  'function totalLockedRewards() external view returns (uint256)',
  'function sellerClaimPolicy() external view returns (address)',
  'function claim(address recipient) external',
] as const;

const POLICY_ABI = ['function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256)'] as const;

/** Legacy locked seller rewards pool (`AntseedSellerRewardsPool`). Releases are gated by the M002 claim policy. */
export class SellerRewardsPoolClient extends BaseEvmClient {
  constructor(config: SellerRewardsPoolClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }

  lockedRewards(seller: string): Promise<bigint> { return this.contract().getFunction('lockedRewards')(seller); }
  totalLockedRewards(): Promise<bigint> { return this.contract().getFunction('totalLockedRewards')(); }
  sellerClaimPolicy(): Promise<string> { return this.contract().getFunction('sellerClaimPolicy')(); }
  /** Amount the configured policy would release now; zero when no policy is installed. */
  async claimable(seller: string): Promise<{ locked: bigint; claimable: bigint; policy: string }> {
    const [locked, policy] = await Promise.all([this.lockedRewards(seller), this.sellerClaimPolicy()]);
    if (policy === ZeroAddress || locked === 0n) return { locked, claimable: 0n, policy };
    const allowed = await new Contract(policy, POLICY_ABI, this._provider).getFunction('claimableSellerRewards')(seller, locked) as bigint;
    return { locked, claimable: allowed > locked ? locked : allowed, policy };
  }
  claim(signer: AbstractSigner, recipient: string): Promise<string> { return this._execWrite(signer, ABI, 'claim', recipient); }
}
