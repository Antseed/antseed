import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ZeroAddress, getAddress } from 'ethers';
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
import { createIndexer, type IndexedInvites, type IndexedReferralBinding, type IndexedReferrer, type Indexer } from './indexer.js';
import { discoverRefereeEpochs, discoverReferrerEpochs } from './reward-discovery.js';
import { silentReporter, type StepReporter } from './steps.js';

const HIDDEN_REFERRAL: ReferralView = { available: false, indexed: false, payable: '0', claimableEpochs: [], referredCount: 0, invites: null };
const HIDDEN_REFEREE: RefereeView = {
  available: false, indexed: false, referrer: null, boundEpoch: null, windowEnd: null, weeksLeft: null, payable: '0', claimableEpochs: [], canBind: null,
};

/**
 * The buyer account's referral card: it is the referrer, since its wallet
 * signed the invites (Desktop's identity, or the CLI's), even while its
 * authorized operator is the connected wallet. Counts, invites and payable
 * amounts come from Antscan (`explorerApiUrl`), never from per-epoch RPC scans.
 * Without an explorer, or one that does not index referrals or fails (timeout,
 * HTTP error, an older explorer without the endpoint), the card stays
 * available (invites and claims only need the contract): the invite allowance
 * and referred count are bounded on-chain views, and the payable amount is
 * unknown (`indexed: false`); `claimReferralRewards` scans for it on-chain.
 * Failures of those on-chain reads still reject.
 */
export async function referral(ctx: AntsContext, dataDir: string | null = null): Promise<ReferralView> {
  const client = ctx.chain.referralsAddress ? ctx.referrals() : null;
  if (!client) return HIDDEN_REFERRAL;
  const referrer = ctx.buyerAddress;
  const scope = referralScope(ctx, referrer);
  const indexed = await indexedReferrer(ctx.indexer(), referrer).catch(() => null);
  if (!indexed) {
    const [invites, referredCount] = await Promise.all([onChainInvites(client, referrer), client.referredCount(referrer)]);
    return {
      ...HIDDEN_REFERRAL,
      available: true,
      referredCount,
      invites: allowanceView(invites, await issuedIndices(dataDir, scope, invites.epoch)),
    };
  }
  // Antscan may still serve last week after the contract rolled over: its
  // allowance only counts for the contract's current epoch, else the
  // contract's own allowance is read (Antscan's is kept if that read fails).
  const epoch = await client.currentEpoch().catch(() => null);
  const invites = indexed.invites && (epoch === null || indexed.invites.epoch === epoch)
    ? indexed.invites
    : epoch === null ? null : await onChainInvites(client, referrer, epoch).catch(() => indexed.invites);
  return {
    available: true,
    indexed: true,
    payable: indexed.payable,
    claimableEpochs: indexed.claimableEpochs,
    referredCount: indexed.referredCount,
    invites: invites ? allowanceView(invites, await issuedIndices(dataDir, scope, invites.epoch)) : null,
  };
}

/** This epoch's invites from the contract: its quota and which indexes are bound (`inviteUsed`, at most `MAX_INVITES_PER_EPOCH` reads). */
async function onChainInvites(
  client: Pick<ReferralsClient, 'currentEpoch' | 'inviteQuota' | 'inviteUsed'>,
  referrer: string,
  knownEpoch?: number,
): Promise<IndexedInvites> {
  const epoch = knownEpoch ?? await client.currentEpoch();
  const quota = await client.inviteQuota(referrer, epoch);
  const indexes = Array.from({ length: quota }, (_, index) => index);
  const used = await Promise.all(indexes.map((index) => client.inviteUsed(referrer, epoch, index)));
  const usedIndices = indexes.filter((index) => used[index]);
  return { epoch, quota, used: usedIndices.length, usedIndices };
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
async function issuedIndices(dataDir: string | null, scope: ReferralScope | null, epoch: number): Promise<number[]> {
  return dataDir && scope ? readIssuedInviteIndices(dataDir, scope, epoch) : [];
}

/** `wallet`'s local referral state on the Referrals deployment `ctx` points at. */
export function referralScope(ctx: Pick<AntsContext, 'chain'>, wallet: string): ReferralScope | null {
  const { evmChainId, referralsAddress } = ctx.chain;
  return referralsAddress ? { chainId: evmChainId, referralsAddress, wallet } : null;
}

/** Invites gone this epoch: |bound ∪ handed out here| (the bound count alone when Antscan lists no indexes). */
function takenCount(invites: IndexedReferrer['invites'], taken: Set<number>, quota: number): number {
  const inQuota = [...taken].filter((index) => index < quota).length;
  return Math.max(invites?.used ?? 0, inQuota);
}

function allowanceView(invites: IndexedInvites, issued: number[]): InviteAllowanceView {
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
 * The epoch and quota always come from the `currentEpoch` / `inviteQuota`
 * views: an Antscan answer can lag an epoch rollover (reporting last week's
 * quota) or fall far enough behind that its epoch is outside the invite
 * validity window, and the contract checks invites against its own clock.
 * Antscan's bound indexes are used only when they describe that same epoch,
 * else every index is checked with `inviteUsed`. The index is a random free
 * one (see `nextInviteIndex`), checked with `inviteUsed` and remembered in
 * `<dataDir>/referral.json` (per signer and deployment) so this install
 * never hands it out twice. Picking, signing and recording run under one
 * lock per data dir, shared by the CLI, Desktop and the dashboard, so
 * concurrent requests never sign the same index.
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
  const [indexed, epoch] = await Promise.all([
    indexedReferrer(options.indexer, referrer).catch(() => null),
    options.client.currentEpoch(),
  ]);
  const quota = await options.client.inviteQuota(referrer, epoch);
  if (quota === 0) throw new InviteQuotaError(NO_INVITE_QUOTA_MESSAGE, 0);
  const indexedInvites = indexed?.invites?.epoch === epoch ? indexed.invites : null;

  const domain = { chainId: options.chainId, referralsAddress: options.referralsAddress };
  const scope: ReferralScope = { ...domain, wallet: referrer };
  const allocate = async (): Promise<CreatedInviteView> => {
    const issued = await issuedIndices(options.dataDir, scope, epoch);
    const taken = new Set([...(indexedInvites?.usedIndices ?? []), ...issued]);
    // Without Antscan's bound indexes, check every other index once (one view
    // call each) so both the pick and the count left are exact. With them,
    // only the pick is checked, in case Antscan lags a fresh binding.
    if (!indexedInvites) {
      const unknown = Array.from({ length: quota }, (_, index) => index).filter((index) => !taken.has(index));
      const used = await Promise.all(unknown.map((index) => options.client.inviteUsed(referrer, epoch, index)));
      unknown.forEach((index, i) => { if (used[i]) taken.add(index); });
    }
    let index = nextInviteIndex(quota, taken, options.random);
    while (index !== null && indexedInvites && await options.client.inviteUsed(referrer, epoch, index)) {
      taken.add(index);
      index = nextInviteIndex(quota, taken, options.random);
    }
    if (index === null) throw new InviteQuotaError(`All ${quota} invites for this week are taken. More unlock next week.`, quota);

    const invite = await signInvite(options.signer, domain, epoch, index);
    if (options.dataDir) await recordIssuedInvite(options.dataDir, scope, epoch, index);
    const encoded = encodeInvite(invite);
    return {
      invite: encoded,
      link: inviteLink(encoded),
      epoch,
      index,
      quota,
      left: Math.max(0, quota - takenCount(indexedInvites, taken.add(index), quota)),
      expiresEpoch: epoch + INVITE_VALIDITY_EPOCHS,
    };
  };
  if (!options.dataDir) return allocate();
  // The lock file lives in the data dir, which a workspace wallet may not have created yet.
  await mkdir(options.dataDir, { recursive: true });
  return withFileLock(inviteLockPath(options.dataDir), allocate);
}

/**
 * Guards invite allocation in `dataDir` across every process that issues from
 * it (the lock file is `referral-invite.lock`). It is separate from the short
 * `referral.json.lock` that every referral-file update takes
 * (`recordIssuedInvite` takes it inside this one), so a slow allocation
 * never blocks a redemption or a daemon sync. The order is always
 * allocation → file, and file-lock holders never take this one: no deadlock.
 */
function inviteLockPath(dataDir: string): string {
  return join(dataDir, 'referral-invite');
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
    indexed: true,
    referrer: binding.referrer ? getAddress(binding.referrer) : null,
    boundEpoch: binding.boundEpoch,
    windowEnd,
    weeksLeft: windowEnd !== null && currentEpoch !== null ? Math.max(0, windowEnd - currentEpoch + 1) : null,
    payable: binding.refereePayable,
    claimableEpochs: binding.refereeClaimableEpochs,
    canBind: binding.canBind,
  };
}

/**
 * The dashboard's buyer account as a referee. Antscan reports the binding,
 * window and payable bonus. When it is unset, does not index referrals, or
 * fails, the binding is read on-chain (`referrerOf`) and the window and
 * amount are unknown (`indexed: false`); `claimRefereeRewards` then finds
 * the payable epochs on-chain. Hidden without a Referrals contract, or when
 * the on-chain read fails too.
 */
export async function refereeBonus(ctx: AntsContext): Promise<RefereeView> {
  const client = ctx.chain.referralsAddress ? ctx.referrals() : null;
  if (!client) return HIDDEN_REFEREE;
  const binding = await referralBinding(ctx.indexer(), ctx.buyerAddress);
  if (binding) return refereeView(binding);
  let referrer: string;
  try {
    referrer = getAddress(await client.referrerOf(ctx.buyerAddress));
  } catch {
    return HIDDEN_REFEREE;
  }
  return { ...HIDDEN_REFEREE, available: true, referrer: referrer === ZeroAddress ? null : referrer };
}

/**
 * Claim every epoch with a payable referral reward for the buyer account.
 * The epochs come from Antscan; without one (or when it fails) the on-chain
 * discovery pages back through every epoch the program can pay. Antscan can
 * lag a claim that just confirmed, so its epochs are narrowed to those
 * `pendingReward` still pays: `claimEpochs` skips the rest anyway, but a list
 * that is entirely claimed would revert.
 */
export async function claimReferralRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ hash: string; epochs: number[] }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  // The buyer account is the referrer (see `referral`); any wallet may send it.
  // An unreachable explorer falls back to the on-chain discovery, like the referee claim.
  const indexed = await indexedReferrer(ctx.indexer(), ctx.buyerAddress).catch(() => null);
  const epochs = indexed
    ? await stillPayable(indexed.claimableEpochs, (epoch) => client.pendingReward(ctx.buyerAddress, epoch))
    : (await discoverReferrerEpochs(ctx, ctx.buyerAddress)).epochs;
  if (epochs.length === 0) throw new Error('No referral rewards are payable yet.');
  await report(`Claiming referral rewards for ${epochs.length} ${epochs.length === 1 ? 'epoch' : 'epochs'}`);
  const hash = await client.claimEpochs(ctx.requireSigner(), ctx.buyerAddress, epochs);
  await report('Referral rewards claimed', hash);
  return { hash, epochs };
}

/** `epochs` whose on-chain pending reward is still non-zero (zero once claimed), in order. */
async function stillPayable(epochs: number[], pending: (epoch: number) => Promise<bigint>): Promise<number[]> {
  const amounts = await Promise.all(epochs.map(pending));
  return epochs.filter((_, i) => amounts[i]! > 0n);
}

/**
 * Claim the buyer account's referee bonus. The epochs come from Antscan,
 * narrowed to those `pendingRefereeReward` still pays (Antscan can lag a
 * claim that just confirmed); when it is unset, does not index referrals, or
 * is unreachable, the on-chain discovery finds them from the binding epoch
 * on. Permissionless: the dashboard wallet sends it, and the contract always
 * pays the buyer's Deposits operator.
 */
export async function claimRefereeRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ hash: string; epochs: number[] }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  const binding = await referralBinding(ctx.indexer(), ctx.buyerAddress);
  const epochs = binding
    ? await stillPayable(binding.refereeClaimableEpochs, (epoch) => client.pendingRefereeReward(ctx.buyerAddress, epoch))
    : (await discoverRefereeEpochs(ctx, ctx.buyerAddress)).epochs;
  if (epochs.length === 0) throw new Error('No invite bonus is payable yet.');
  await report(`Claiming your invite bonus for ${epochs.length} ${epochs.length === 1 ? 'epoch' : 'epochs'}`);
  const hash = await client.claimRefereeEpochs(ctx.requireSigner(), ctx.buyerAddress, epochs);
  await report('Invite bonus claimed', hash);
  return { hash, epochs };
}
