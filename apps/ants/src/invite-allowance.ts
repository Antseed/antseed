export const NO_INVITE_QUOTA_MESSAGE = 'Invites unlock after at least 1 USDC of usage or sales in the previous week.';

/** Invites are signed by the buyer account's local key, which a browser wallet session never holds. */
export const BROWSER_WALLET_INVITE_MESSAGE = 'Invites are signed by the local Antseed wallet. Run `antseed referral invite` instead.';

export type InviteAllowanceSnapshot = { epoch: number; quota: number; left: number };

/**
 * The invite allowance to show: Antscan's, lowered by an invite just created
 * for the same epoch (until a refetch counts it). A created invite for a later
 * epoch stands in for an allowance Antscan has not reached, and never for an
 * earlier one.
 */
export function inviteAllowance(
  allowance: InviteAllowanceSnapshot | null,
  created: InviteAllowanceSnapshot | null,
): { quota: number | null; left: number | null } {
  if (!created || (allowance && allowance.epoch > created.epoch)) {
    return { quota: allowance?.quota ?? null, left: allowance?.left ?? null };
  }
  if (!allowance || created.epoch > allowance.epoch) return { quota: created.quota, left: created.left };
  return { quota: allowance.quota, left: Math.min(allowance.left, created.left) };
}

/** `https://antseed.com/invite/<91 chars>` → `antseed.com/invite/AbCdEf…wXyZ`; copying still uses the full link. */
export function shortInviteLink(link: string): string {
  const match = /^https?:\/\/(.*\/invite\/)([A-Za-z0-9_-]+)$/.exec(link);
  return match && match[2]!.length > 14 ? `${match[1]}${match[2]!.slice(0, 6)}…${match[2]!.slice(-4)}` : link;
}
