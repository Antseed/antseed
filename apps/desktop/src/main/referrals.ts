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
  refereeBonusFromExplorer,
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

/** This wallet as a referee: who invited it, or the invite it carries until bound. */
export type ReferralStatus = {
  /** False when referrals are not deployed on this network (UI hides referral pieces). */
  configured: boolean;
  state: 'none' | 'invited' | 'bound';
  referrer: string | null;
  invite: string | null;
};

export type InviteCheckResult =
  | { ok: true; referrer: string; invite: string }
  | { ok: false; reason: string };

export type InviteAllowance = { epoch: number; quota: number; used: number; left: number };

/** This wallet as a referrer, for the rewards view. ANTS are decimal strings. */
export type ReferralInvites = {
  available: boolean;
  /** False when no Antscan explorer lists this network's referrals. */
  listed: boolean;
  /** Invites for this week; null when Antscan does not report them. */
  allowance: InviteAllowance | null;
  /** `pendingPoints`: usage in weeks that are not claimable yet (no ANTS value yet). */
  buyers: Array<{ buyer: string; points: string; ants: string; pendingPoints: string }>;
  /** Sums over `buyers`. */
  totals: { points: string; ants: string; pendingPoints: string };
  error: string | null;
};

export type CreateInviteResult =
  /** `epoch`: the on-chain week the invite was issued in (it can be ahead of Antscan's allowance). */
  | { ok: true; invite: string; link: string; epoch: number; left: number; quota: number; expiresEpoch: number }
  | { ok: false; reason: string; noQuota: boolean };

/** The two-sided bonus this wallet earns as a referee (from Antscan). Payable is a decimal ANTS string. */
export type RefereeBonus = {
  available: boolean;
  weeksLeft: number | null;
  payable: string;
  claimableEpochs: number[];
};

const DARK_STATUS: ReferralStatus = { configured: false, state: 'none', referrer: null, invite: null };
const NO_TOTALS = { points: '0', ants: '0', pendingPoints: '0' };
const NO_INVITES: ReferralInvites = { available: false, listed: false, allowance: null, buyers: [], totals: NO_TOTALS, error: null };
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
 * invited buyer brought in, all from Antscan (never an RPC scan).
 */
export async function getReferralInvites(): Promise<ReferralInvites> {
  const context = await referralContext().catch(() => null);
  if (!context) return NO_INVITES;
  try {
    const ctx = new AntsContext({ chain: context.chain, address: context.wallet.address });
    const [card, view] = await Promise.all([referral(ctx, resolveConnectDataDir()), referredBuyers(ctx)]);
    if (!view.available) return { ...NO_INVITES, available: true };
    const sum = (key: 'points' | 'ants' | 'pendingPoints') => view.buyers.reduce((total, row) => total + BigInt(row[key]), 0n).toString();
    return {
      available: true,
      listed: true,
      allowance: card.invites,
      buyers: view.buyers.map((row) => ({ buyer: getAddress(row.buyer), points: row.points, ants: formatAntsExact(row.ants), pendingPoints: row.pendingPoints })),
      totals: { points: sum('points'), ants: formatAntsExact(sum('ants')), pendingPoints: sum('pendingPoints') },
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
