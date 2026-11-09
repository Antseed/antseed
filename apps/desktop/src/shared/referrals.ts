/**
 * The referral IPC contract between the main process (main/referrals.ts) and
 * the renderer (renderer/types/bridge.ts re-exports it).
 */

import type { CreatedInviteView, InviteAllowanceView } from '@antseed/ants/service';

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

export type InviteAllowance = InviteAllowanceView;

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
  /** Inviter rewards payable now, claimed on the rewards dashboard. */
  payable: string;
  /** Epochs with a payable inviter reward; empty when nothing is claimable. */
  claimableEpochs: number[];
  error: string | null;
};

export type CreateInviteResult =
  /** `epoch`: the on-chain week the invite was issued in (it can be ahead of Antscan's allowance). */
  | ({ ok: true } & Omit<CreatedInviteView, 'index'>)
  | { ok: false; reason: string; noQuota: boolean };

/** The two-sided bonus this wallet earns as a referee (from Antscan). Payable is a decimal ANTS string. */
export type RefereeBonus = {
  available: boolean;
  weeksLeft: number | null;
  payable: string;
  claimableEpochs: number[];
};
