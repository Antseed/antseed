import { Contract, id } from 'ethers';
import type { AbstractSigner } from 'ethers';
import type { ReferralInvite } from '@antseed/protocol/signatures';
import { BaseEvmClient } from './base-evm-client.js';

export interface ReferralsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

/** `previewInvite` result: the recovered referrer and the bind failure (null when it would bind). */
export interface InvitePreview {
  referrer: string;
  failure: InviteFailure | null;
}

/** Why an invite would not bind (the AntseedReferrals error names). */
export type InviteFailure =
  | 'InvalidAddress'
  | 'ReferralAlreadyBound'
  | 'InvalidInviteSignature'
  | 'SelfReferral'
  | 'InviteNotActive'
  | 'InviteOverQuota'
  | 'InviteAlreadyUsed'
  | 'NotNewBuyer'
  | 'Unknown';

const REFERRALS_ABI = [
  'function referrerOf(address buyer) external view returns (address)',
  'function boundAtEpoch(address buyer) external view returns (uint256)',
  'function referralOf(address buyer) external view returns (address referrer, uint256 epoch)',
  'function referredCount(address referrer) external view returns (uint256)',
  'function isNewBuyer(address buyer) external view returns (bool)',
  'function inviteQuota(address referrer, uint256 epoch) external view returns (uint256)',
  'function inviteUsed(address referrer, uint256 issuedEpoch, uint256 index) external view returns (bool)',
  'function inviteSigner(uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs) external view returns (address)',
  'function previewInvite(address buyer, uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs) external view returns (address referrer, bytes4 failure)',
  'function rewardRecipient(address wallet) external view returns (address)',
  'function isClaimable(uint256 epoch) external view returns (bool)',
  'function referrerEpochClaimed(address buyer, uint256 epoch) external view returns (bool)',
  'function refereeEpochClaimed(address buyer, uint256 epoch) external view returns (bool)',
  'function pendingReferrerReward(address buyer, uint256 epoch) external view returns (uint256)',
  'function pendingRefereeReward(address buyer, uint256 epoch) external view returns (uint256)',
  'function usageAccounting() external view returns (address)',
  'function claimReferrerRewards(address referrer, address[] buyers, uint256[] epochs) external',
  'function claimRefereeRewards(address buyer, uint256[] epochs) external',
  'event ReferralBound(address indexed buyer, address indexed referrer, uint256 epoch, uint256 inviteEpoch, uint256 inviteIndex)',
] as const;

const FAILURE_BY_SELECTOR = new Map<string, InviteFailure>(
  ([
    'InvalidAddress', 'ReferralAlreadyBound', 'InvalidInviteSignature', 'SelfReferral',
    'InviteNotActive', 'InviteOverQuota', 'InviteAlreadyUsed', 'NotNewBuyer',
  ] as const).map((name) => [id(`${name}()`).slice(0, 10), name]),
);

/** The failure a `previewInvite` selector names; null when the invite would bind. */
export function inviteFailureOf(selector: string): InviteFailure | null {
  if (/^0x0{8}$/.test(selector)) return null;
  return FAILURE_BY_SELECTOR.get(selector.toLowerCase()) ?? 'Unknown';
}

/**
 * Read/claim client for AntseedReferrals. Binding is not exposed here: it
 * happens on-chain when AntseedChannelsMiddleware decodes the invite the buyer signed
 * into its settlement metadata (see `UsageAttribution` in @antseed/protocol).
 * A referred buyer's reward is its share of all recognized buyer usage in the
 * epoch, applied to the referral emission bucket: the referrer earns all of it,
 * or half during the buyer's bonus window, when the referee earns the other
 * half. Each address is capped per epoch at 5% of the bucket, per role, and the
 * excess goes to the emissions reserve. Only the wallet's Deposits operator can
 * send a claim, and it is paid to that operator.
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

  /** The epoch `buyer`'s invite bound; meaningful only when `referrerOf(buyer)` is set. */
  async boundAtEpoch(buyer: string): Promise<number> {
    return Number(await this.contract().getFunction('boundAtEpoch')(buyer));
  }

  async referredCount(referrer: string): Promise<number> {
    return Number(await this.contract().getFunction('referredCount')(referrer));
  }

  async inviteQuota(referrer: string, epoch: number): Promise<number> {
    return Number(await this.contract().getFunction('inviteQuota')(referrer, epoch));
  }

  inviteUsed(referrer: string, epoch: number, index: number): Promise<boolean> {
    return this.contract().getFunction('inviteUsed')(referrer, epoch, index);
  }

  /** Every bind check for `buyer` presenting `invite` now, as one view call. */
  async previewInvite(buyer: string, invite: ReferralInvite): Promise<InvitePreview> {
    const [referrer, selector] = await this.contract().getFunction('previewInvite')(
      buyer, invite.epoch, invite.index, invite.r, invite.vs,
    ) as [string, string];
    return { referrer, failure: inviteFailureOf(selector) };
  }

  /** What the buyer's referrer would receive on this buyer's epoch right now. */
  pendingReward(buyer: string, epoch: number): Promise<bigint> {
    return this.contract().getFunction('pendingReferrerReward')(buyer, epoch);
  }

  pendingRefereeReward(buyer: string, epoch: number): Promise<bigint> {
    return this.contract().getFunction('pendingRefereeReward')(buyer, epoch);
  }

  async currentEpoch(): Promise<number> {
    const accounting = await this.contract().getFunction('usageAccounting')() as string;
    const contract = new Contract(accounting, ['function currentEpoch() external view returns (uint256)'], this._provider);
    return Number(await contract.getFunction('currentEpoch')());
  }

  /** Claim a referrer's rewards on `buyers` for `epochs`, skipping pairs with nothing to pay. `signer` must be the referrer's Deposits operator. */
  claim(signer: AbstractSigner, referrer: string, buyers: string[], epochs: number[]): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'claimReferrerRewards', referrer, buyers, epochs);
  }

  /** Claim a referee's bonus for several epochs. `signer` must be the buyer's Deposits operator. */
  claimReferee(signer: AbstractSigner, buyer: string, epochs: number[]): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'claimRefereeRewards', buyer, epochs);
  }
}
