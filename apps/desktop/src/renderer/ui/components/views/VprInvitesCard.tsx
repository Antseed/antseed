import { useState } from 'react';
import { inviteAllowance } from '@antseed/ants/invite-allowance';
import { Button, CopyButton } from '@antseed/ui';
import { formatCredits, formatInt, shortAddress } from '../../../core/format';
import type { CreateInviteResult, ReferralInvites } from '../../../types/bridge';
import { StakingButton } from '../StakingButton';
import { VprCard, VprSettingRow } from '../vpr/VprKit';
import breakdown from './BalanceBreakdown.module.scss';
import styles from './VprRewardsView.module.scss';

/** `https://antseed.com/invite/AbC…xyz` → `antseed.com/invite/AbCdEf…wxyz`. */
function shortInviteLink(link: string): string {
  const match = /^https?:\/\/(.*\/invite\/)([A-Za-z0-9_-]+)$/.exec(link);
  return match && match[2]!.length > 14 ? `${match[1]}${match[2]!.slice(0, 6)}…${match[2]!.slice(-4)}` : link;
}

const NO_QUOTA_HINT = 'Invites unlock after at least 1 USDC of usage or sales in the previous week.';

/** "12,500 pts" plus "· 250 pts pending" when part of it is in weeks not claimable yet. */
function invitePoints(points: string, pendingPoints: string): string {
  return BigInt(pendingPoints || '0') > 0n
    ? `${formatInt(points)} pts · ${formatInt(pendingPoints)} pts pending`
    : `${formatInt(points)} pts`;
}

/** The latest create attempt on this card, with the allowance week it was made in. */
export type CreatedInvite = { result: CreateInviteResult; epoch: number | null };

/** The card's create history: the latest created invite, and the latest failure since (with the allowance week it was tried in). */
export type InviteCreation = {
  latest: Extract<CreateInviteResult, { ok: true }> | null;
  failure: { reason: string; noQuota: boolean; epoch: number | null } | null;
};

export const NO_INVITE_CREATION: InviteCreation = { latest: null, failure: null };

/** Fold a create attempt in: a new link replaces the old one; a failure keeps it. */
export function nextInviteCreation(current: InviteCreation, attempt: CreatedInvite): InviteCreation {
  const result = attempt.result;
  return result.ok
    ? { latest: result, failure: null }
    : { latest: current.latest, failure: { reason: result.reason, noQuota: result.noQuota, epoch: attempt.epoch } };
}

/**
 * Create one invite; a failure becomes a result the card shows. A created
 * invite is dated by the on-chain week it was issued in; a failure by the
 * allowance week shown when it was tried.
 */
export async function createInviteOnce(
  createInvite: () => Promise<CreateInviteResult>,
  epoch: number | null,
): Promise<CreatedInvite> {
  try {
    const result = await createInvite();
    return { result, epoch: result.ok ? result.epoch : epoch };
  } catch (error) {
    return { result: { ok: false, reason: error instanceof Error ? error.message : String(error), noQuota: false }, epoch };
  }
}

/** Whether the latest failure still describes the allowance week shown; a newer week's allowance supersedes it. */
export function inviteFailureCurrent(invites: ReferralInvites, creation: InviteCreation): boolean {
  const failure = creation.failure;
  const allowance = invites.allowance;
  return !!failure && (!allowance || failure.epoch === null || failure.epoch >= allowance.epoch);
}

/**
 * What the invite row shows: the latest link, the invites left this week and
 * whether another can be created. The count from the latest creation wins
 * over a lagging Antscan allowance for the same week; a new week resets it,
 * and clears a no-quota answer from an earlier week. None of this is final:
 * when creation looks unavailable the card still offers "Check again", since
 * the main process reads the epoch and quota on-chain before signing.
 */
export function inviteCardState(invites: ReferralInvites, creation: InviteCreation): {
  link: string | null;
  left: number | null;
  quota: number | null;
  noQuota: boolean;
  canCreate: boolean;
} {
  const allowance = invites.allowance;
  const result = creation.latest;
  const link = result?.link ?? null;
  const { left, quota } = inviteAllowance(allowance, result);
  // A creation in a later week than Antscan has reached answers for that week's quota too.
  const laterWeek = !!result && (!allowance || result.epoch > allowance.epoch);
  const noQuota = (!laterWeek && allowance?.quota === 0) || (inviteFailureCurrent(invites, creation) && !!creation.failure?.noQuota);
  return { link, left, quota, noQuota, canCreate: !noQuota && left !== 0 };
}

/**
 * Referrer view: the invite link and what each invited buyer brought in
 * (from Antscan), laid out like the balance breakdown rows with a total.
 * Hidden without referrals; the list is hidden without an explorer. Each
 * link is single-use, so another can be created while invites are left.
 */
export function VprInvitesCard({ invites, onCreated }: { invites: ReferralInvites | null; onCreated?: () => void }) {
  const [creation, setCreation] = useState<InviteCreation>(NO_INVITE_CREATION);
  const [creating, setCreating] = useState(false);
  if (!invites?.available) return null;
  const create = async () => {
    const createInvite = window.antseedDesktop?.referralCreateInvite;
    if (!createInvite || creating) return;
    setCreating(true);
    try {
      const attempt = await createInviteOnce(createInvite, invites.allowance?.epoch ?? null);
      setCreation((current) => nextInviteCreation(current, attempt));
      if (attempt.result.ok) onCreated?.();
    } finally {
      setCreating(false);
    }
  };
  return (
    <VprInvitesCardBody
      invites={invites}
      creation={creation}
      creating={creating}
      onCreate={() => void create()}
    />
  );
}

export function VprInvitesCardBody({ invites, creation, creating, onCreate }: {
  invites: ReferralInvites;
  creation: InviteCreation;
  creating: boolean;
  onCreate: () => void;
}) {
  const { link, left, quota, noQuota, canCreate } = inviteCardState(invites, creation);
  const leftHint = left !== null && quota !== null ? `${formatInt(left)} of ${formatInt(quota)} left this week.` : null;
  const hint = noQuota
    ? NO_QUOTA_HINT
    : link
      ? [shortInviteLink(link), leftHint].filter(Boolean).join(' · ')
      : leftHint ?? 'Single-use link, valid for 4 weeks.';
  const failure = creation.failure && !creation.failure.noQuota && inviteFailureCurrent(invites, creation) ? creation.failure.reason : null;
  const count = invites.buyers.length;
  let createLabel = 'Check again';
  if (creating) createLabel = canCreate ? 'Creating…' : 'Checking…';
  else if (canCreate) createLabel = link ? 'Create another' : 'Create link';
  // The allowance can lag a new week, so "Check again" stays available: the main process checks it on-chain.
  const createButton = (
    <Button size="sm" variant={!link && canCreate ? 'outline' : 'link'} onClick={onCreate} disabled={creating} aria-busy={creating}>
      {createLabel}
    </Button>
  );
  return (
    <VprCard className={styles.aboutCard}>
      <span className={styles.aboutTitle}>Your invites</span>
      <span className={styles.aboutText}>
        Invite someone new. You both earn bonus $ANTS from their usage for 12 weeks, then you keep earning.
      </span>
      <VprSettingRow
        title="Invite someone"
        hint={hint}
        control={link ? (
          <span className={styles.inviteActions}>
            {createButton}
            {/* Keyed by the link, so a new link starts at Copy again. */}
            <CopyButton key={link} value={link} size="sm" variant="outline" />
          </span>
        ) : createButton}
      />
      {failure ? <span className={styles.errorNote}>{failure}</span> : null}
      {invites.listed && count > 0 ? (
        <div className={`${breakdown.breakdown} ${styles.invites}`} role="table" aria-label="Invited wallets">
          <div className={`${breakdown.row} ${styles.inviteHeader}`} role="row">
            <span role="columnheader">Invited wallet</span>
            <span role="columnheader">Earned</span>
          </div>
          {invites.buyers.map((row) => (
            <div key={row.buyer} className={`${breakdown.row} ${styles.inviteRow}`} role="row" data-buyer={row.buyer}>
              <span className={styles.inviteWallet} role="cell">
                <span title={row.buyer}>{shortAddress(row.buyer)}</span>
                <span className={styles.inviteMeta}>{invitePoints(row.points, row.pendingPoints)}</span>
              </span>
              <span role="cell" title={row.ants}>{formatCredits(row.ants)} $ANTS</span>
            </div>
          ))}
          <div className={`${breakdown.row} ${breakdown.totalRow}`} role="row">
            <span role="cell">Total · {count} {count === 1 ? 'wallet' : 'wallets'}</span>
            <span role="cell" title={invites.totals.ants}>{formatCredits(invites.totals.ants)} $ANTS</span>
          </div>
          <span className={styles.inviteMeta}>
            Earned is claimed plus claimable now. Pending points earn $ANTS once their week becomes claimable.
          </span>
        </div>
      ) : null}
      {invites.claimableEpochs.length > 0 ? (
        // Inviter rewards are not in the buyer summary behind "Claim rewards".
        <VprSettingRow
          title={`${formatCredits(invites.payable)} $ANTS payable`}
          hint="From your invites. Paid to your authorized wallet."
          control={(
            <StakingButton page="rewards" className={styles.claimButton}>
              Claim ↗
            </StakingButton>
          )}
        />
      ) : null}
      {invites.listed && count === 0 && !invites.error
        ? <span className={styles.aboutText}>No one has joined with your invites yet.</span>
        : null}
      {invites.error ? <span className={styles.errorNote}>{invites.error}</span> : null}
    </VprCard>
  );
}
