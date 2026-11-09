/**
 * Invite-only referrals (AntseedReferrals).
 *
 * Redeeming: the user pastes an invite (or opens an antseed://invite link),
 * we run `previewInvite` for this install's buyer wallet and, if it would
 * bind, save it as pending in `<connect data dir>/referral.json` (shared with
 * the CLI via @antseed/node). The buyer daemon carries it in the metadata it
 * signs until AntseedChannelsMiddleware binds it on a settlement; Antscan reports the
 * binding and one `referrerOf` read confirms it. State is scoped to the
 * wallet and the configured referrals deployment. Until it binds, a pending
 * invite can be replaced or removed. Inviting: we sign a fresh invite with the identity wallet (no
 * transaction). Lists and payable amounts come from Antscan only.
 */
import { getAddress } from 'ethers';
import {
  checkInvite,
  clearReferralInvite,
  referrerOfLookup,
  saveReferralInvite,
  syncReferralState,
  type ReferralScope,
} from '@antseed/node';
import {
  AntsContext,
  InviteQuotaError,
  formatAntsExact,
  issueInvite,
  refereeBonusFromExplorer,
  referralBindingFromExplorer,
  referrerOverview,
  type AntsChainConfig,
} from '@antseed/ants/service';
import { ensureSecureIdentity, getSecureIdentity } from './identity.js';
import { resolveConnectDataDir } from './runtime/process-manager.js';
import { readConfig } from './runtime/config-io.js';
import { ACTIVE_CONFIG_PATH } from './runtime/active-config.js';
import { resolveStakingChain } from './staking/configuration.js';
import { friendlyNetworkError } from './utils.js';
import type {
  CreateInviteResult,
  InviteCheckResult,
  RefereeBonus,
  ReferralInvites,
  ReferralStatus,
} from '../shared/referrals.js';

const DARK_STATUS: ReferralStatus = { configured: false, state: 'none', referrer: null, invite: null };
const NO_TOTALS = { points: '0', ants: '0', pendingPoints: '0' };
const NO_INVITES: ReferralInvites = { available: false, listed: false, allowance: null, buyers: [], totals: NO_TOTALS, payable: '0', claimableEpochs: [], error: null };
const NO_BONUS: RefereeBonus = { available: false, weeksLeft: null, payable: '0', claimableEpochs: [] };

function errorText(error: unknown): string {
  return friendlyNetworkError(error);
}

/** The identity wallet and the chain with referrals deployed, or null when referrals are dark. */
async function referralContext(): Promise<{ chain: AntsChainConfig & { referralsAddress: string }; wallet: NonNullable<ReturnType<typeof getSecureIdentity>>['wallet'] } | null> {
  await ensureSecureIdentity();
  const identity = getSecureIdentity();
  if (!identity) return null;
  const chain = resolveStakingChain(await readConfig(ACTIVE_CONFIG_PATH));
  if (!chain.referralsAddress) return null;
  return { chain: chain as AntsChainConfig & { referralsAddress: string }, wallet: identity.wallet };
}

function scopeOf(context: ReferralContext): ReferralScope {
  return { wallet: context.wallet.address, chainId: context.chain.evmChainId, referralsAddress: context.chain.referralsAddress };
}

function statusOf(state: Awaited<ReturnType<typeof syncReferralState>>): ReferralStatus {
  return {
    configured: true,
    state: state?.state ?? 'none',
    referrer: state?.state === 'none' ? null : state?.referrer ?? null,
    invite: state?.state === 'invited' ? state.invite ?? null : null,
  };
}

export async function getReferralStatus(): Promise<ReferralStatus> {
  const context = await referralContext().catch(() => null);
  if (!context) return DARK_STATUS;
  const { chain, wallet } = context;
  // Antscan only hints the binding; `referrerOf` on the configured contract
  // confirms it before the pending invite is dropped, and is also read on a
  // backoff while Antscan is missing, failing or still reports it unbound.
  const client = new AntsContext({ chain, address: wallet.address }).referrals();
  const state = await syncReferralState(resolveConnectDataDir(), scopeOf(context), {
    explorer: (buyer) => referralBindingFromExplorer(chain.explorerApiUrl, buyer),
    chain: client ? referrerOfLookup(client) : null,
  });
  return statusOf(state);
}

type ReferralContext = NonNullable<Awaited<ReturnType<typeof referralContext>>>;

/** Decode an invite or link and run `previewInvite` for this context's wallet (one view call). */
async function checkInContext(context: ReferralContext, value: string): Promise<InviteCheckResult> {
  const client = new AntsContext({ chain: context.chain, address: context.wallet.address }).referrals();
  if (!client) return { ok: false, reason: 'Invites are not available on this network.' };
  const result = await checkInvite(client, context.wallet.address, value);
  return result.ok
    ? { ok: true, referrer: getAddress(result.referrer), invite: result.encoded }
    : { ok: false, reason: result.reason };
}

export async function checkReferralInvite(value: string): Promise<InviteCheckResult> {
  try {
    const context = await referralContext();
    if (!context) return { ok: false, reason: 'Invites are not available on this network.' };
    return await checkInContext(context, value);
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * Check the invite and save it as pending (replacing an unbound one) so the
 * buyer daemon carries it. One context covers both, so a wallet or network
 * change during the check cannot save an invite under a scope it was not
 * checked for.
 */
export async function redeemReferralInvite(value: string): Promise<InviteCheckResult> {
  try {
    const context = await referralContext();
    if (!context) return { ok: false, reason: 'Invites are not available on this network.' };
    const checked = await checkInContext(context, value);
    if (!checked.ok) return checked;
    const saved = await saveReferralInvite(resolveConnectDataDir(), scopeOf(context), checked.invite, checked.referrer);
    if (saved.state === 'bound') return { ok: false, reason: 'This wallet already has an inviter.' };
    return checked;
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/** Drop the pending invite (expired, or used by someone else first). A binding is kept. */
export async function clearPendingReferralInvite(): Promise<ReferralStatus> {
  const context = await referralContext().catch(() => null);
  if (!context) return DARK_STATUS;
  return statusOf(await clearReferralInvite(resolveConnectDataDir(), scopeOf(context)));
}

/**
 * This wallet as a referrer: this week's invite allowance and what each
 * invited buyer brought in, all from Antscan (never an RPC scan).
 */
export async function getReferralInvites(): Promise<ReferralInvites> {
  const context = await referralContext().catch(() => null);
  if (!context) return NO_INVITES;
  try {
    const ctx = new AntsContext({ chain: context.chain, address: context.wallet.address });
    const { referral: card, buyers: view } = await referrerOverview(ctx, resolveConnectDataDir());
    if (!view.available) return { ...NO_INVITES, available: true };
    const sum = (key: 'points' | 'ants' | 'pendingPoints') => view.buyers.reduce((total, row) => total + BigInt(row[key]), 0n).toString();
    return {
      available: true,
      listed: true,
      allowance: card.invites,
      buyers: view.buyers.map((row) => ({ buyer: getAddress(row.buyer), points: row.points, ants: formatAntsExact(row.ants), pendingPoints: row.pendingPoints })),
      totals: { points: sum('points'), ants: formatAntsExact(sum('ants')), pendingPoints: sum('pendingPoints') },
      payable: formatAntsExact(card.payable),
      claimableEpochs: card.claimableEpochs,
      error: null,
    };
  } catch (error) {
    return { ...NO_INVITES, available: true, listed: true, error: errorText(error) };
  }
}

/** Sign a fresh invite for this week with the identity wallet (off-chain, no transaction). */
export async function createReferralInvite(): Promise<CreateInviteResult> {
  try {
    const context = await referralContext();
    if (!context) return { ok: false, reason: 'Invites are not available on this network.', noQuota: false };
    const ctx = new AntsContext({ chain: context.chain, address: context.wallet.address });
    const client = ctx.referrals();
    if (!client) return { ok: false, reason: 'Invites are not available on this network.', noQuota: false };
    const created = await issueInvite({
      client,
      indexer: ctx.indexer(),
      signer: context.wallet,
      chainId: context.chain.evmChainId,
      referralsAddress: context.chain.referralsAddress,
      dataDir: resolveConnectDataDir(),
    });
    return { ok: true, invite: created.invite, link: created.link, epoch: created.epoch, left: created.left, quota: created.quota, expiresEpoch: created.expiresEpoch };
  } catch (error) {
    return { ok: false, reason: errorText(error), noQuota: error instanceof InviteQuotaError && error.quota === 0 };
  }
}

/** The referee bonus (weeks left, payable) from Antscan; hidden without it or while not bound. */
export async function getRefereeBonus(): Promise<RefereeBonus> {
  const context = await referralContext().catch(() => null);
  if (!context) return NO_BONUS;
  try {
    const view = await refereeBonusFromExplorer(context.chain.explorerApiUrl, context.wallet.address);
    if (!view.available || !view.referrer) return NO_BONUS;
    return {
      available: true,
      weeksLeft: view.weeksLeft,
      payable: formatAntsExact(view.payable),
      claimableEpochs: view.claimableEpochs,
    };
  } catch {
    return NO_BONUS;
  }
}
