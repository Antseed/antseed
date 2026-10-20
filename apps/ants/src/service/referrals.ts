import { join } from 'node:path';
import { getAddress } from 'ethers';
import type { AbstractSigner } from 'ethers';
import {
  INVITE_VALIDITY_EPOCHS,
  encodeInvite,
  inviteLink,
  nextInviteIndex,
  readIssuedInviteIndices,
  recordIssuedInvite,
  signInvite,
  withFileLock,
  type ReferralScope,
  type ReferralsClient,
} from '@antseed/node';
import type { CreatedInviteView, InviteAllowanceView, RefereeView, ReferralView, ReferredBuyersView } from '../api-types.js';
import type { AntsContext } from './context.js';
import { createIndexer, type IndexedReferralBinding, type IndexedReferrer, type Indexer } from './indexer.js';
import { silentReporter, type StepReporter } from './steps.js';

const HIDDEN_REFERRAL: ReferralView = { available: false, payable: '0', claimableEpochs: [], referredCount: 0, invites: null };
const HIDDEN_REFEREE: RefereeView = {
  available: false, referrer: null, boundEpoch: null, windowEnd: null, weeksLeft: null, payable: '0', claimableEpochs: [],
};

/**
 * The buyer account's referral card: it is the referrer, since its wallet
 * signed the invites (Desktop's identity, or the CLI's), even while its
 * authorized operator is the connected wallet. Counts, invites and payable
 * amounts come from Antscan (`explorerApiUrl`), never from per-epoch RPC
 * scans; without an explorer, or one that does not index referrals, the card
 * is hidden.
 */
export async function referral(ctx: AntsContext, dataDir: string | null = null): Promise<ReferralView> {
  const indexed = ctx.chain.referralsAddress ? await indexedReferrer(ctx.indexer(), ctx.buyerAddress) : null;
  if (!indexed) return HIDDEN_REFERRAL;
  return {
    available: true,
    payable: indexed.payable,
    claimableEpochs: indexed.claimableEpochs,
    referredCount: indexed.referredCount,
    invites: indexed.invites
      ? allowanceView(indexed.invites, await issuedIndices(dataDir, { wallet: ctx.buyerAddress, chainId: ctx.chain.evmChainId, referralsAddress: ctx.chain.referralsAddress! }, indexed.invites.epoch))
      : null,
  };
}

/** Buyers the buyer account referred, with the points and ANTS each brought in (from Antscan). */
export async function referredBuyers(ctx: AntsContext): Promise<ReferredBuyersView> {
  const indexed = ctx.chain.referralsAddress ? await indexedReferrer(ctx.indexer(), ctx.buyerAddress) : null;
  if (!indexed) return { available: false, buyers: [] };
  return { available: true, buyers: indexed.buyers };
}

async function indexedReferrer(indexer: Indexer | null, address: string): Promise<IndexedReferrer | null> {
  if (!indexer?.referrer) return null;
  const indexed = await indexer.referrer(address);
  return indexed.available ? indexed : null;
}

/** Indices this install handed out for `epoch`, signed by `scope.wallet` on its deployment. */
async function issuedIndices(dataDir: string | null, scope: ReferralScope, epoch: number): Promise<number[]> {
  return dataDir ? readIssuedInviteIndices(dataDir, scope, epoch) : [];
}

/** Invites gone this epoch: |bound ∪ handed out here| (the bound count alone when Antscan lists no indexes). */
function takenCount(invites: IndexedReferrer['invites'], taken: Set<number>, quota: number): number {
  const inQuota = [...taken].filter((index) => index < quota).length;
  return Math.max(invites?.used ?? 0, inQuota);
}

function allowanceView(invites: NonNullable<IndexedReferrer['invites']>, issued: number[]): InviteAllowanceView {
  const used = takenCount(invites, new Set([...invites.usedIndices, ...issued]), invites.quota);
  return { epoch: invites.epoch, quota: invites.quota, used, left: Math.max(0, invites.quota - used) };
}

/** Why `issueInvite` refused: no quota this epoch, or every invite already handed out. */
export class InviteQuotaError extends Error {
  constructor(message: string, readonly quota: number) {
    super(message);
    this.name = 'InviteQuotaError';
  }
}

export const NO_INVITE_QUOTA_MESSAGE = 'Invites unlock after at least 1 USDC of usage or sales in the previous week.';

/**
 * Sign a fresh invite for the current epoch with `signer` (the referrer).
 * Epoch and quota always come from the `currentEpoch` / `inviteQuota` views
 * (issuing is user-triggered, so the RPC is fine): a lagging Antscan could
 * otherwise keep last week's exhausted allowance or sign an expired invite.
 * Antscan's bound indexes are used only when they are for that same epoch,
 * else every index is checked with `inviteUsed`. The index is a random
 * free one (see `nextInviteIndex`), checked with `inviteUsed` and remembered
 * in `<dataDir>/referral.json` (per signer and deployment) so this install
 * never hands it out twice.
 * Picking, signing and recording run under one lock per data dir, shared by
 * the CLI, Desktop and the dashboard, so concurrent requests never sign the
 * same index.
 */
export async function issueInvite(options: {
  client: Pick<ReferralsClient, 'currentEpoch' | 'inviteQuota' | 'inviteUsed'>;
  indexer: Indexer | null;
  signer: AbstractSigner;
  chainId: number;
  referralsAddress: string;
  dataDir: string | null;
  /** Index picker randomness (tests). */
  random?: () => number;
}): Promise<CreatedInviteView> {
  const referrer = await options.signer.getAddress();
  const [epoch, indexed] = await Promise.all([
    options.client.currentEpoch(),
    indexedReferrer(options.indexer, referrer).catch(() => null),
  ]);
  const quota = await options.client.inviteQuota(referrer, epoch);
  if (quota === 0) throw new InviteQuotaError(NO_INVITE_QUOTA_MESSAGE, 0);
  // Antscan's bound indexes, only when they describe the verified epoch.
  const explorer = indexed?.invites?.epoch === epoch ? indexed.invites : null;

  const scope = { wallet: referrer, chainId: options.chainId, referralsAddress: options.referralsAddress };
  const allocate = async (): Promise<CreatedInviteView> => {
    const issued = await issuedIndices(options.dataDir, scope, epoch);
    const taken = new Set([...(explorer?.usedIndices ?? []), ...issued]);
    // Without Antscan's bound indexes, check every other index once (one view
    // call each) so both the pick and the count left are exact. With them,
    // only the pick is checked, in case Antscan lags a fresh binding.
    if (!explorer) {
      const unknown = Array.from({ length: quota }, (_, index) => index).filter((index) => !taken.has(index));
      const used = await Promise.all(unknown.map((index) => options.client.inviteUsed(referrer, epoch, index)));
      unknown.forEach((index, i) => { if (used[i]) taken.add(index); });
    }
    let index = nextInviteIndex(quota, taken, options.random);
    while (index !== null && explorer && await options.client.inviteUsed(referrer, epoch, index)) {
      taken.add(index);
      index = nextInviteIndex(quota, taken, options.random);
    }
    if (index === null) throw new InviteQuotaError(`All ${quota} invites for this week are taken. More unlock next week.`, quota);

    const invite = await signInvite(options.signer, { chainId: options.chainId, referralsAddress: options.referralsAddress }, epoch, index);
    if (options.dataDir) await recordIssuedInvite(options.dataDir, scope, epoch, index);
    const encoded = encodeInvite(invite);
    return {
      invite: encoded,
      link: inviteLink(encoded),
      epoch,
      index,
      quota,
      left: Math.max(0, quota - takenCount(explorer, taken.add(index), quota)),
      expiresEpoch: epoch + INVITE_VALIDITY_EPOCHS,
    };
  };
  return options.dataDir ? withFileLock(inviteLockPath(options.dataDir), allocate) : allocate();
}

/**
 * Guards invite allocation in `dataDir` across every process that issues from
 * it. It is separate from the short `referral.lock` that every referral-file
 * update takes (`recordIssuedInvite` takes it inside this one), so a slow
 * allocation never blocks a redemption or a daemon sync. The order is always
 * allocation → file, and file-lock holders never take this one: no deadlock.
 */
function inviteLockPath(dataDir: string): string {
  return join(dataDir, 'referral-invite.lock');
}

/**
 * `issueInvite` for the buyer account. Only its own wallet can sign its
 * invites: an operator signing them would hand out the operator's invites.
 */
export async function createInvite(ctx: AntsContext, dataDir: string | null = null, report: StepReporter = silentReporter): Promise<CreatedInviteView> {
  const client = ctx.referrals();
  if (!client || !ctx.chain.referralsAddress) throw new Error('Referrals are not configured for this chain.');
  const signer = ctx.requireSigner();
  if ((await signer.getAddress()).toLowerCase() !== ctx.buyerAddress.toLowerCase()) {
    throw new Error(`Invites are signed by ${ctx.buyerAddress}. Create them in Antseed, or connect that wallet.`);
  }
  await report('Signing an invite');
  const created = await issueInvite({
    client, indexer: ctx.indexer(), signer, chainId: ctx.chain.evmChainId, referralsAddress: ctx.chain.referralsAddress, dataDir,
  });
  await report('Invite created');
  return created;
}

/**
 * Who referred `buyer`, from Antscan: the checksummed referrer, null while
 * unbound, or undefined when Antscan is unset, does not index referrals, or
 * is unreachable (callers then keep their local state).
 */
export async function referralBindingFromExplorer(explorerApiUrl: string | undefined, buyer: string, fetchImpl: typeof fetch = fetch): Promise<string | null | undefined> {
  const binding = await referralBinding(createIndexer(explorerApiUrl, fetchImpl), buyer);
  if (!binding) return undefined;
  return binding.referrer ? getAddress(binding.referrer) : null;
}

async function referralBinding(indexer: Indexer | null, buyer: string): Promise<IndexedReferralBinding | null> {
  if (!indexer?.referralBinding) return null;
  try {
    const binding = await indexer.referralBinding(buyer);
    return binding.available ? binding : null;
  } catch {
    return null;
  }
}

/** The buyer's referee bonus from Antscan: who invited it, weeks left in the bonus window, and what is payable. */
export async function refereeBonusFromExplorer(explorerApiUrl: string | undefined, buyer: string, fetchImpl: typeof fetch = fetch): Promise<RefereeView> {
  return refereeView(await referralBinding(createIndexer(explorerApiUrl, fetchImpl), buyer));
}

function refereeView(binding: IndexedReferralBinding | null): RefereeView {
  if (!binding) return HIDDEN_REFEREE;
  const { refereeWindowEnd: windowEnd, currentEpoch } = binding;
  return {
    available: true,
    referrer: binding.referrer ? getAddress(binding.referrer) : null,
    boundEpoch: binding.boundEpoch,
    windowEnd,
    weeksLeft: windowEnd !== null && currentEpoch !== null ? Math.max(0, windowEnd - currentEpoch + 1) : null,
    payable: binding.refereePayable,
    claimableEpochs: binding.refereeClaimableEpochs,
  };
}

/** The dashboard's buyer account as a referee. */
export async function refereeBonus(ctx: AntsContext): Promise<RefereeView> {
  if (!ctx.chain.referralsAddress) return HIDDEN_REFEREE;
  return refereeView(await referralBinding(ctx.indexer(), ctx.buyerAddress));
}

/**
 * Claim every epoch with a payable referral reward for the dashboard wallet.
 * The epochs come from Antscan; the RPC epoch scan is only the fallback when
 * Antscan is unset, does not index referrals, or fails. `claimEpochs` skips
 * epochs with nothing to pay.
 */
export async function claimReferralRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ hash: string; epochs: number[] }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  // The buyer account is the referrer (see `referral`); any wallet may send it.
  const indexed = await indexedReferrer(ctx.indexer(), ctx.buyerAddress).catch(() => null);
  const epochs = indexed ? indexed.claimableEpochs : (await client.pendingRewards(ctx.buyerAddress)).map((entry) => entry.epoch);
  if (epochs.length === 0) throw new Error('No referral rewards are payable yet.');
  await report(`Claiming referral rewards for ${epochs.length} ${epochs.length === 1 ? 'epoch' : 'epochs'}`);
  const hash = await client.claimEpochs(ctx.requireSigner(), ctx.buyerAddress, epochs);
  await report('Referral rewards claimed', hash);
  return { hash, epochs };
}

/** Same window as `ReferralsClient.pendingRewards`: the last 26 claimable epochs. */
const REFEREE_SCAN_LOOKBACK = 26;

/**
 * Epochs with a non-zero referee bonus for `buyer`, from `pendingRefereeReward`
 * per epoch. Costs one read per epoch, so only claims use it, and only when
 * Antscan cannot answer.
 */
async function pendingRefereeEpochs(client: Pick<ReferralsClient, 'currentEpoch' | 'pendingRefereeReward'>, buyer: string): Promise<number[]> {
  const latestClaimable = await client.currentEpoch() - 2; // one finalized epoch plus the settlement grace epoch
  if (latestClaimable < 0) return [];
  const from = Math.max(0, latestClaimable - REFEREE_SCAN_LOOKBACK + 1);
  const epochs = Array.from({ length: latestClaimable - from + 1 }, (_, i) => from + i);
  const amounts = await Promise.all(epochs.map((epoch) => client.pendingRefereeReward(buyer, epoch)));
  return epochs.filter((_, i) => amounts[i]! > 0n);
}

/**
 * Claim the buyer account's referee bonus for the epochs Antscan reports
 * payable, or, when Antscan is unset, does not index referrals, or fails, the
 * epochs an on-chain `pendingRefereeReward` scan finds. An available Antscan
 * answer is authoritative, even when empty. Permissionless: the dashboard
 * wallet sends it, and the contract always pays the buyer's Deposits operator.
 */
export async function claimRefereeRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ hash: string; epochs: number[] }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  const binding = await referralBinding(ctx.indexer(), ctx.buyerAddress);
  const epochs = binding ? binding.refereeClaimableEpochs : await pendingRefereeEpochs(client, ctx.buyerAddress);
  if (epochs.length === 0) throw new Error('No invite bonus is payable yet.');
  await report(`Claiming your invite bonus for ${epochs.length} ${epochs.length === 1 ? 'epoch' : 'epochs'}`);
  const hash = await client.claimRefereeEpochs(ctx.requireSigner(), ctx.buyerAddress, epochs);
  await report('Invite bonus claimed', hash);
  return { hash, epochs };
}
