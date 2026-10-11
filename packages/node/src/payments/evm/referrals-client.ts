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

export interface ReferralEpochReward {
  epoch: number;
  amount: bigint;
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
  'function referrerRecipient(address referrer) external view returns (address)',
  'function isClaimable(uint256 epoch) external view returns (bool)',
  'function claimed(address referrer, uint256 epoch) external view returns (bool)',
  'function refereeClaimed(address buyer, uint256 epoch) external view returns (bool)',
  'function pendingReward(address referrer, uint256 epoch) external view returns (uint256)',
  'function pendingRefereeReward(address buyer, uint256 epoch) external view returns (uint256)',
  'function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount, uint256 reserveAmount)',
  'function usageAccounting() external view returns (address)',
  'function claim(address referrer, uint256 epoch) external',
  'function claimEpochs(address referrer, uint256[] epochs) external',
  'function claimReferee(address buyer, uint256 epoch) external',
  'function claimRefereeEpochs(address buyer, uint256[] epochs) external',
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
 * happens on-chain when AntseedStatsV2 decodes the invite the buyer signed
 * into its settlement metadata (see `UsageAttribution` in @antseed/protocol).
 * Rewards are a per-epoch share of the referral emission bucket, pro rata to
 * the recognized usage of referred buyers: the referrer earns on all of it,
 * the referee on its own usage during its bonus window. Claims are
 * permissionless; referee rewards always pay the buyer's Deposits operator.
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

  pendingReward(referrer: string, epoch: number): Promise<bigint> {
    return this.contract().getFunction('pendingReward')(referrer, epoch);
  }

  pendingRefereeReward(buyer: string, epoch: number): Promise<bigint> {
    return this.contract().getFunction('pendingRefereeReward')(buyer, epoch);
  }

  async currentEpoch(): Promise<number> {
    const accounting = await this.contract().getFunction('usageAccounting')() as string;
    const contract = new Contract(accounting, ['function currentEpoch() external view returns (uint256)'], this._provider);
    return Number(await contract.getFunction('currentEpoch')());
  }

  /**
   * Epochs with a non-zero payable reward for `referrer`, scanning the last
   * `lookback` claimable epochs (unclaimed, claimable, budget available).
   * Fallback for when no explorer indexes referrals.
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

  /** Claim a referee's bonus for several epochs; pays the buyer's Deposits operator whoever sends it. */
  claimRefereeEpochs(signer: AbstractSigner, buyer: string, epochs: number[]): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'claimRefereeEpochs', buyer, epochs);
  }
}
