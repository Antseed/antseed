/**
 * Invite-only referrals (AntseedReferrals).
 *
 * Redeeming: the user pastes an invite (or opens an antseed://invite link),
 * we run `previewInvite` for this install's buyer wallet and, if it would
 * bind, save it as pending in `<connect data dir>/referral.json` (shared with
 * the CLI via @antseed/node). The buyer daemon carries it in the metadata it
 * signs until AntseedStatsV2 binds it on a settlement; Antscan reports the
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
  refereeBonus,
  referral,
  referralBindingFromExplorer,
  referredBuyers,
  type AntsChainConfig,
} from '@antseed/ants/service';
import { ensureSecureIdentity, getSecureIdentity } from './identity.js';
import { resolveConnectDataDir } from './runtime/process-manager.js';
import { readConfig } from './runtime/config-io.js';
import { ACTIVE_CONFIG_PATH } from './runtime/active-config.js';
import { resolveStakingChain } from './staking/configuration.js';
import { friendlyNetworkError } from './utils.js';
import { combineInviteReads, NO_INVITES } from './referral-invites.js';
import type {
  CreateInviteResult,
  InviteCheckResult,
  RefereeBonus,
  ReferralInvites,
  ReferralStatus,
} from '../shared/referrals.js';

const DARK_STATUS: ReferralStatus = { configured: false, state: 'none', referrer: null, invite: null };
const NO_BONUS: RefereeBonus = { available: false, indexed: false, weeksLeft: null, payable: '0', claimableEpochs: [] };

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

function scopeOf(context: NonNullable<Awaited<ReturnType<typeof referralContext>>>): ReferralScope {
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

/** Decode an invite or link and run `previewInvite` for this wallet (one view call). */
export async function checkReferralInvite(value: string): Promise<InviteCheckResult> {
  try {
    const context = await referralContext();
    if (!context) return { ok: false, reason: 'Invites are not available on this network.' };
    const client = new AntsContext({ chain: context.chain, address: context.wallet.address }).referrals();
    if (!client) return { ok: false, reason: 'Invites are not available on this network.' };
    const result = await checkInvite(client, context.wallet.address, value);
    return result.ok
      ? { ok: true, referrer: getAddress(result.referrer), invite: result.encoded }
      : { ok: false, reason: result.reason };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/** Check the invite again and save it as pending (replacing an unbound one) so the buyer daemon carries it. */
export async function redeemReferralInvite(value: string): Promise<InviteCheckResult> {
  const checked = await checkReferralInvite(value);
  if (!checked.ok) return checked;
  try {
    const context = await referralContext();
    if (!context) return { ok: false, reason: 'Invites are not available on this network.' };
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
 * invited buyer brought in, from Antscan (never an RPC epoch scan). Without
 * an explorer that lists referrals, the allowance is the contract's own
 * bounded read, and invites keep working even when that read fails.
 */
export async function getReferralInvites(): Promise<ReferralInvites> {
  const context = await referralContext().catch(() => null);
  if (!context) return NO_INVITES;
  const ctx = new AntsContext({ chain: context.chain, address: context.wallet.address });
  const [cardRead, listRead] = await Promise.allSettled([referral(ctx, resolveConnectDataDir()), referredBuyers(ctx)]);
  return combineInviteReads(cardRead, listRead);
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
    // Antscan when it reports the bonus, else the on-chain binding (`referrerOf`) with the amount unknown.
    const view = await refereeBonus(new AntsContext({ chain: context.chain, address: context.wallet.address }));
    if (!view.available || !view.referrer) return NO_BONUS;
    return {
      available: true,
      indexed: view.indexed,
      weeksLeft: view.weeksLeft,
      payable: formatAntsExact(view.payable),
      claimableEpochs: view.claimableEpochs,
    };
  } catch {
    return NO_BONUS;
  }
}
