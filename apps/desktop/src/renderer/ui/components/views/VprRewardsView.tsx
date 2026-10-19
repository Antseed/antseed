import { StakingButton } from '../StakingButton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@antseed/ui';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatCredits, formatInt, shortAddress } from '../../../core/format';
import type { RendererUiState } from '../../../core/state';
import type { CreateInviteResult, RefereeBonus, ReferralInvites, ReferralStatus } from '../../../types/bridge';
import { ReferralStatusRow } from '../ReferralStatusRow';
import { VprBadge, VprCard, VprPage, VprSettingRow } from '../vpr/VprKit';
import breakdown from './BalanceBreakdown.module.scss';
import styles from './VprRewardsView.module.scss';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

/**
 * In-app $ANTS rewards (moved from the browser portal). The summary is
 * read-only; claiming transfers tokens on-chain and needs the authorized
 * wallet's signature, so the claim actions open the shared rewards dashboard.
 */
/** Headline subtitle: usage rewards and/or the invite bonus, or not live yet. */
function heroHint(rewards: RendererUiState['creditsRewards'], bonusPayable: number): string {
  if (!rewards?.available) {
    return bonusPayable > 0 ? 'Earned from your invite bonus.' : 'Rewards are not live on this chain yet.';
  }
  const source = bonusPayable > 0 ? 'your usage and invite bonus' : 'your usage';
  const epoch = rewards.currentEpoch !== null ? ` — epoch ${rewards.currentEpoch}` : '';
  return `Earned from ${source}${epoch}.`;
}

export function VprRewardsView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    rewards: state.creditsRewards,
    loading: state.creditsSummaryLoading,
  }), shallowEqual);

  // Force-refresh on entry and whenever the window regains focus — after
  // claiming in the browser pay popup the user lands straight back here, and
  // the 55s summary throttle would otherwise show the pre-claim numbers. The
  // invite bonus and invites are claimed and created the same way, so they
  // follow the summary.
  const [invites, setInvites] = useState<ReferralInvites | null>(null);
  const [bonus, setBonus] = useState<RefereeBonus | null>(null);
  const invitesLoader = useRef<LatestOnly | null>(null);
  useEffect(() => {
    const loadInvites = latestOnly(() => window.antseedDesktop?.referralGetInvites?.(), setInvites);
    const loadBonus = latestOnly(() => window.antseedDesktop?.referralGetReferee?.(), setBonus);
    invitesLoader.current = loadInvites;
    const stop = startRewardsRefresh((force) => {
      actions.refreshPaymentSummary(force);
      loadInvites.run();
      loadBonus.run();
    }, PAYMENT_SUMMARY_POLL_MS);
    return () => {
      stop();
      loadInvites.dispose();
      loadBonus.dispose();
      invitesLoader.current = null;
    };
  }, [actions]);
  const reloadInvites = useCallback(() => invitesLoader.current?.run(), []);

  // Re-read after redeeming: the field gives way to the pending inviter.
  const [referral, setReferral] = useState<ReferralStatus | null>(null);
  const loadReferral = useCallback(() => {
    let cancelled = false;
    void window.antseedDesktop?.referralGetStatus?.()
      .then((status) => { if (!cancelled) setReferral(status); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(loadReferral, [loadReferral]);

  const rewards = snap.rewards;
  const { pending, bonusPayable } = pendingHeadline(rewards, bonus);
  const hasPending = Number(pending) > 0;

  return (
    <section className={`view view-vpr-rewards view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Rewards" backFallback="credits">
      <div className={styles.stack}>

        <VprCard className={styles.heroCard}>
          <div className={styles.heroText}>
            <span className={styles.heroLabel}>Pending $ANTS</span>
            <span className={styles.heroValue}>{formatCredits(pending)}</span>
            <span className={styles.heroHint}>
              {heroHint(rewards, bonusPayable)}
            </span>
          </div>
          <div className={styles.heroActions}>
            {rewards?.available && (
              <VprBadge tone={rewards.transfersEnabled ? 'green' : 'neutral'}>
                {rewards.transfersEnabled ? 'Transfers live' : 'Transfers not enabled yet'}
              </VprBadge>
            )}
            <StakingButton page="rewards" className={styles.claimButton} disabled={!hasPending} copyDisabled={!rewards?.available && bonusPayable === 0}>
              Claim rewards ↗
            </StakingButton>
          </div>
        </VprCard>

        <VprReferralCard status={referral} onRedeemed={loadReferral} />

        <VprRefereeBonusCard bonus={bonus} />

        <VprCard className={styles.aboutCard}>
          <span className={styles.aboutTitle}>Staking</span>
          <span className={styles.aboutText}>
            Manage positions and staking rewards in your browser. Connect a wallet to approve transactions.
          </span>
          <StakingButton className={styles.claimButton}>Manage staking ↗</StakingButton>
        </VprCard>

        <span className={styles.errorNote}>Copy a link to use your wallet in another browser.</span>

        <VprInvitesCard invites={invites} onCreated={reloadInvites} />

        <VprCard className={styles.aboutCard}>
          <span className={styles.aboutTitle}>About $ANTS</span>
          <span className={styles.aboutText}>
            $ANTS are emitted every epoch to the buyers and sellers who moved real USDC volume on
            the network — no lockups, no staking requirement. Claiming settles on-chain and needs
            your authorized wallet&apos;s signature, so it opens in a secure browser window.
          </span>
        </VprCard>

        {rewards?.error && <span className={styles.errorNote}>{rewards.error}</span>}
      </div>
      </VprPage>
    </section>
  );
}

type RefreshTarget = Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'>;

/**
 * Run `refresh(true)` now and whenever the window regains focus, and
 * `refresh(false)` every `intervalMs`. Returns the cleanup.
 */
export function startRewardsRefresh(refresh: (force: boolean) => void, intervalMs: number, target: RefreshTarget = window): () => void {
  refresh(true);
  const timer = target.setInterval(() => refresh(false), intervalMs);
  const onFocus = () => refresh(true);
  target.addEventListener('focus', onFocus);
  return () => {
    target.clearInterval(timer);
    target.removeEventListener('focus', onFocus);
  };
}

export type LatestOnly = { run(): void; dispose(): void };

/**
 * Re-runnable read whose result is applied only when it is the latest one
 * started and the view is still mounted, so a slow earlier response cannot
 * overwrite a newer one. Failures keep the current value.
 */
export function latestOnly<T>(load: () => Promise<T> | undefined, apply: (value: T) => void): LatestOnly {
  let generation = 0;
  let disposed = false;
  return {
    run() {
      const current = ++generation;
      void load()
        ?.then((value) => { if (!disposed && current === generation) apply(value); })
        .catch(() => {});
    },
    dispose() { disposed = true; },
  };
}

/**
 * The "Pending $ANTS" headline: buyer rewards plus the invite bonus, which is
 * claimed on the same rewards page (display only, decimal ANTS strings).
 */
export function pendingHeadline(
  rewards: { available: boolean; pendingAnts: string } | null | undefined,
  bonus: RefereeBonus | null,
): { pending: string; bonusPayable: number } {
  const bonusPayable = bonus?.available ? Number(bonus.payable) || 0 : 0;
  const usage = rewards?.available ? Number(rewards.pendingAnts) || 0 : 0;
  return { pending: String(usage + bonusPayable), bonusPayable };
}

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

/** The card's create history: the latest link, and the latest failure since (with the allowance week it was tried in). */
export type InviteCreation = {
  latest: CreatedInvite | null;
  failure: { reason: string; noQuota: boolean; epoch: number | null } | null;
};

export const NO_INVITE_CREATION: InviteCreation = { latest: null, failure: null };

/** Fold a create attempt in: a new link replaces the old one; a failure keeps it. */
export function nextInviteCreation(current: InviteCreation, attempt: CreatedInvite): InviteCreation {
  return attempt.result.ok
    ? { latest: attempt, failure: null }
    : { latest: current.latest, failure: { reason: attempt.result.reason, noQuota: attempt.result.noQuota, epoch: attempt.epoch } };
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
    return { result, epoch: result.ok && typeof result.epoch === 'number' ? result.epoch : epoch };
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
  const latest = creation.latest;
  const result = latest?.result.ok ? latest.result : null;
  const link = result?.link ?? null;
  // A creation for the allowance's week, or a later one Antscan has not reached, stands in for it.
  const createdWeek = latest?.epoch ?? null;
  const sameWeek = !!allowance && createdWeek === allowance.epoch;
  const laterWeek = !!result && (!allowance || (createdWeek !== null && createdWeek > allowance.epoch));
  const left = result && sameWeek ? Math.min(result.left, allowance!.left)
    : result && laterWeek ? result.left
      : allowance?.left ?? null;
  const quota = result && laterWeek ? result.quota : allowance?.quota ?? null;
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
  const [copied, setCopied] = useState(false);
  if (!invites?.available) return null;
  const create = async () => {
    const createInvite = window.antseedDesktop?.referralCreateInvite;
    if (!createInvite || creating) return;
    setCreating(true);
    try {
      const attempt = await createInviteOnce(createInvite, invites.allowance?.epoch ?? null);
      setCreation((current) => nextInviteCreation(current, attempt));
      if (attempt.result.ok) {
        setCopied(false);
        onCreated?.();
      }
    } finally {
      setCreating(false);
    }
  };
  const copy = (link: string) => {
    void navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <VprInvitesCardBody
      invites={invites}
      creation={creation}
      creating={creating}
      copied={copied}
      onCreate={() => void create()}
      onCopy={copy}
    />
  );
}

export function VprInvitesCardBody({ invites, creation, creating, copied, onCreate, onCopy }: {
  invites: ReferralInvites;
  creation: InviteCreation;
  creating: boolean;
  copied: boolean;
  onCreate: () => void;
  onCopy: (link: string) => void;
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
            <Button size="sm" variant="link" onClick={onCreate} disabled={creating} aria-busy={creating}>
              {creating ? (canCreate ? 'Creating…' : 'Checking…') : canCreate ? 'Create another' : 'Check again'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onCopy(link)}>{copied ? 'Copied' : 'Copy'}</Button>
          </span>
        ) : canCreate ? (
          <Button size="sm" variant="outline" onClick={onCreate} disabled={creating} aria-busy={creating}>
            {creating ? 'Creating…' : 'Create link'}
          </Button>
        ) : (
          // The allowance can lag a new week; the main process checks it on-chain.
          <Button size="sm" variant="link" onClick={onCreate} disabled={creating} aria-busy={creating}>
            {creating ? 'Checking…' : 'Check again'}
          </Button>
        )}
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
      {invites.listed && count === 0 && !invites.error
        ? <span className={styles.aboutText}>No one has joined with your invites yet.</span>
        : null}
      {invites.error ? <span className={styles.errorNote}>{invites.error}</span> : null}
    </VprCard>
  );
}

/**
 * "Have an invite?": the invite field while this wallet has neither an
 * inviter nor a pending invite (an antseed://invite link prefills it), then
 * who invited it. Hidden until known and on networks without referrals.
 */
export function VprReferralCard({ status, onRedeemed }: { status: ReferralStatus | null; onRedeemed?: () => void }) {
  if (!status?.configured) return null;
  return (
    <VprCard className={styles.aboutCard}>
      <ReferralStatusRow status={status} onRedeemed={onRedeemed} />
    </VprCard>
  );
}

/**
 * Referee view: the bonus this wallet earns for being invited (from Antscan).
 * Claiming pays the authorized wallet (operator), so like the buyer rewards
 * it opens the shared rewards dashboard. Hidden until bound.
 */
export function VprRefereeBonusCard({ bonus }: { bonus: RefereeBonus | null }) {
  if (!bonus?.available) return null;
  const claimable = bonus.claimableEpochs.length > 0;
  const windowHint = bonus.weeksLeft === null
    ? 'From your inviter.'
    : bonus.weeksLeft > 0
      ? `${formatInt(bonus.weeksLeft)} ${bonus.weeksLeft === 1 ? 'week' : 'weeks'} left.`
      : 'Bonus window ended.';
  return (
    <VprCard className={styles.aboutCard}>
      <span className={styles.aboutTitle}>Invite bonus</span>
      <VprSettingRow
        title={`${formatCredits(bonus.payable)} $ANTS payable`}
        hint={`${windowHint} Paid to your authorized wallet.`}
        control={(
          <StakingButton page="rewards" className={styles.claimButton} disabled={!claimable}>
            Claim ↗
          </StakingButton>
        )}
      />
    </VprCard>
  );
}
