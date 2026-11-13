import { join } from 'node:path';
import { getAddress, isAddress } from 'ethers';
import type { AbstractSigner } from 'ethers';
import {
  INVITE_VALIDITY_EPOCHS,
  encodeInvite,
  inviteLink,
  nextInviteIndex,
  readIssuedInviteIndices,
  recordIssuedInvite,
  scanEpochRewards,
  signInvite,
  withFileLock,
  type ReferralsClient,
} from '@antseed/node';
import { MAX_REFERRAL_CLAIM_PAIRS, type CreatedInviteView, type InviteAllowanceView, type RefereeView, type ReferralClaimRequest, type ReferralView, type ReferredBuyersView } from '../api-types.js';
import type { AntsContext } from './context.js';
import { createIndexer, type IndexedReferralBinding, type IndexedReferrer, type Indexer } from './indexer.js';
import { NO_INVITE_QUOTA_MESSAGE } from '../invite-allowance.js';
import { buyerOperator } from './rewards.js';
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
export async function referral(ctx: AntsContext, dataDir: string): Promise<ReferralView> {
  return referralFromIndexed(ctx, dataDir, await referrerFromExplorer(ctx));
}

/** Buyers the buyer account referred, with the points and ANTS each brought in (from Antscan). */
export async function referredBuyers(ctx: AntsContext): Promise<ReferredBuyersView> {
  return referredBuyersFromIndexed(await referrerFromExplorer(ctx));
}

function referrerFromExplorer(ctx: AntsContext): Promise<IndexedReferrer | null> {
  return ctx.chain.referralsAddress ? indexedReferrer(ctx.indexer(), ctx.buyerAddress) : Promise.resolve(null);
}

async function referralFromIndexed(ctx: AntsContext, dataDir: string, indexed: IndexedReferrer | null): Promise<ReferralView> {
  if (!indexed) return HIDDEN_REFERRAL;
  return {
    available: true,
    payable: indexed.payable,
    claimableEpochs: indexed.claimableEpochs,
    referredCount: indexed.referredCount,
    invites: indexed.invites
      ? allowanceView(indexed.invites, await readIssuedInviteIndices(dataDir, { wallet: ctx.buyerAddress, chainId: ctx.chain.evmChainId, referralsAddress: ctx.chain.referralsAddress! }, indexed.invites.epoch))
      : null,
  };
}

function referredBuyersFromIndexed(indexed: IndexedReferrer | null): ReferredBuyersView {
  return indexed ? { available: true, buyers: indexed.buyers } : { available: false, buyers: [] };
}

async function indexedReferrer(indexer: Indexer | null, address: string): Promise<IndexedReferrer | null> {
  if (!indexer?.referrer) return null;
  const indexed = await indexer.referrer(address);
  return indexed.available ? indexed : null;
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

export { NO_INVITE_QUOTA_MESSAGE };

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
  dataDir: string;
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
    const issued = await readIssuedInviteIndices(options.dataDir, scope, epoch);
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
    await recordIssuedInvite(options.dataDir, scope, epoch, index);
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
export async function createInvite(ctx: AntsContext, dataDir: string, report: StepReporter = silentReporter): Promise<CreatedInviteView> {
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

/** The connected signer, once it is the buyer account's Deposits operator: the contract accepts claims only from it. */
async function requireOperatorSigner(ctx: AntsContext): Promise<AbstractSigner> {
  const signer = ctx.requireSigner();
  const operator = await buyerOperator(ctx);
  if (!operator || operator.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error(`Connect the authorized wallet for buyer ${ctx.buyerAddress}.${operator ? ` Current operator: ${operator}.` : ''}`);
  }
  return signer;
}

/**
 * Claim every payable referral reward for the dashboard wallet. Rewards are
 * per referred buyer, and only Antscan lists a referrer's buyers (never an RPC
 * scan), so by default this takes them from Antscan. Without it, the caller
 * can pass the buyers and epochs itself. Either way each buyer and epoch pair
 * is checked with `pendingReferrerReward`, and only payable pairs are sent, in
 * transactions of at most MAX_REFERRAL_CLAIM_PAIRS pairs each (the contract
 * loops over buyers × epochs). Only the buyer account's Deposits operator can
 * send them.
 */
export async function claimReferralRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
  request: ReferralClaimRequest = {},
): Promise<{ hash: string; epochs: number[] }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  // The buyer account is the referrer (see `referral`).
  const signer = await requireOperatorSigner(ctx);
  const explicit = request.buyers !== undefined || request.epochs !== undefined;
  const { buyers, epochs } = explicit ? explicitClaim(request) : await indexedClaim(ctx);
  const batches = referralClaimBatches(await payablePairs(client, buyers, epochs));
  if (batches.length === 0) throw new Error('No referral rewards are payable yet.');
  const claimed = new Set<number>();
  let hash = '';
  for (const [i, batch] of batches.entries()) {
    const part = batches.length > 1 ? ` (transaction ${i + 1} of ${batches.length})` : '';
    await report(`Claiming referral rewards for ${batch.epochs.length} ${batch.epochs.length === 1 ? 'epoch' : 'epochs'}${part}`);
    try {
      hash = await client.claim(signer, ctx.buyerAddress, batch.buyers, batch.epochs);
    } catch (error) {
      if (i === 0) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${i} of ${batches.length} referral claim transactions went through; the rest failed (${reason}). Claim again for the rest.`);
    }
    await report('Referral rewards claimed', hash);
    for (const epoch of batch.epochs) claimed.add(epoch);
  }
  return { hash, epochs: [...claimed].sort((x, y) => x - y) };
}

type ClaimPair = { buyer: string; epoch: number };

async function indexedClaim(ctx: AntsContext): Promise<{ buyers: string[]; epochs: number[] }> {
  const indexed = await indexedReferrer(ctx.indexer(), ctx.buyerAddress).catch(() => null);
  if (!indexed) {
    throw new Error('Claiming referral rewards needs Antscan, which lists your referred buyers. Try again later, or pass the buyers and epochs to claim.');
  }
  return { buyers: indexed.buyers.map(({ buyer }) => buyer), epochs: indexed.claimableEpochs };
}

/** The caller's buyers and epochs, validated. */
function explicitClaim(request: ReferralClaimRequest): { buyers: string[]; epochs: number[] } {
  const buyers = [...new Set((request.buyers ?? []).map((buyer) => {
    if (typeof buyer !== 'string' || !isAddress(buyer)) throw new Error(`Not a buyer address: ${String(buyer)}`);
    return getAddress(buyer);
  }))];
  const epochs = [...new Set(request.epochs ?? [])];
  if (epochs.some((epoch) => !Number.isSafeInteger(epoch) || epoch < 0)) throw new Error('Epochs must be whole numbers.');
  if (buyers.length === 0 || epochs.length === 0) throw new Error('Pass at least one buyer and one epoch to claim.');
  if (buyers.length * epochs.length > MAX_REFERRAL_CLAIM_PAIRS) {
    throw new Error(`Claim at most ${MAX_REFERRAL_CLAIM_PAIRS} buyer and epoch pairs at a time.`);
  }
  return { buyers, epochs };
}

/** Pairs paying something now, read `PAIR_READS_AT_ONCE` at a time. */
async function payablePairs(client: Pick<ReferralsClient, 'pendingReward'>, buyers: string[], epochs: number[]): Promise<ClaimPair[]> {
  const pairs = buyers.flatMap((buyer) => epochs.map((epoch) => ({ buyer, epoch })));
  const payable: ClaimPair[] = [];
  for (let i = 0; i < pairs.length; i += PAIR_READS_AT_ONCE) {
    const chunk = pairs.slice(i, i + PAIR_READS_AT_ONCE);
    const pending = await Promise.all(chunk.map(({ buyer, epoch }) => client.pendingReward(buyer, epoch)));
    chunk.forEach((pair, j) => { if (pending[j]! > 0n) payable.push(pair); });
  }
  return payable;
}

const PAIR_READS_AT_ONCE = 25;

/**
 * Payable pairs as claim transactions of at most `maxPairs` buyers × epochs:
 * one transaction when they fit, else one or more per epoch.
 */
export function referralClaimBatches(pairs: ClaimPair[], maxPairs = MAX_REFERRAL_CLAIM_PAIRS): Array<{ buyers: string[]; epochs: number[] }> {
  const epochs = [...new Set(pairs.map(({ epoch }) => epoch))].sort((x, y) => x - y);
  const buyers = [...new Set(pairs.map(({ buyer }) => buyer))];
  if (pairs.length === 0) return [];
  if (buyers.length * epochs.length <= maxPairs) return [{ buyers, epochs }];
  const buyersByEpoch = new Map<number, Set<string>>();
  for (const { buyer, epoch } of pairs) {
    const group = buyersByEpoch.get(epoch) ?? new Set<string>();
    group.add(buyer);
    buyersByEpoch.set(epoch, group);
  }
  return epochs.flatMap((epoch) => {
    const epochBuyers = [...(buyersByEpoch.get(epoch) ?? [])];
    return Array.from({ length: Math.ceil(epochBuyers.length / maxPairs) }, (_, i) => ({
      buyers: epochBuyers.slice(i * maxPairs, (i + 1) * maxPairs),
      epochs: [epoch],
    }));
  });
}

/**
 * Epochs with a non-zero referee bonus for `buyer`, from `pendingRefereeReward`
 * per epoch. Costs one read per epoch, so only claims use it, and only when
 * Antscan cannot answer.
 */
async function pendingRefereeEpochs(client: Pick<ReferralsClient, 'currentEpoch' | 'pendingRefereeReward'>, buyer: string): Promise<number[]> {
  const rewards = await scanEpochRewards(await client.currentEpoch(), (epoch) => client.pendingRefereeReward(buyer, epoch));
  return rewards.map(({ epoch }) => epoch);
}

/**
 * Claim the buyer account's referee bonus for the epochs Antscan reports
 * payable, or, when Antscan is unset, does not index referrals, or fails, the
 * epochs an on-chain `pendingRefereeReward` scan finds. An available Antscan
 * answer is authoritative, even when empty. Only the buyer's Deposits operator
 * can send it, and the contract pays that operator.
 */
export async function claimRefereeRewards(
  ctx: AntsContext,
  report: StepReporter = silentReporter,
): Promise<{ hash: string; epochs: number[] }> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  const signer = await requireOperatorSigner(ctx);
  const binding = await referralBinding(ctx.indexer(), ctx.buyerAddress);
  const epochs = binding ? binding.refereeClaimableEpochs : await pendingRefereeEpochs(client, ctx.buyerAddress);
  if (epochs.length === 0) throw new Error('No invite bonus is payable yet.');
  await report(`Claiming your invite bonus for ${epochs.length} ${epochs.length === 1 ? 'epoch' : 'epochs'}`);
  const hash = await client.claimReferee(signer, ctx.buyerAddress, epochs);
  await report('Invite bonus claimed', hash);
  return { hash, epochs };
}
