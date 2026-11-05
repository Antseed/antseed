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
