import { StakingButton } from '../StakingButton';
import { useCallback, useEffect, useState } from 'react';
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
  // the 55s summary throttle would otherwise show the pre-claim numbers.
  useEffect(() => {
    actions.refreshPaymentSummary(true);
    const timer = window.setInterval(() => actions.refreshPaymentSummary(), PAYMENT_SUMMARY_POLL_MS);
    const onFocus = () => actions.refreshPaymentSummary(true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [actions]);

  const [invites, setInvites] = useState<ReferralInvites | null>(null);
  const [bonus, setBonus] = useState<RefereeBonus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.antseedDesktop?.referralGetInvites?.()
      .then((next) => { if (!cancelled) setInvites(next); })
      .catch(() => {});
    void window.antseedDesktop?.referralGetReferee?.()
      .then((next) => { if (!cancelled) setBonus(next); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

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

        <VprInvitesCard invites={invites} />

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

/**
 * Referrer view: the invite link and what each invited buyer brought in
 * (from Antscan), laid out like the balance breakdown rows with a total.
 * Hidden without referrals; the list is hidden without an explorer.
 */
export function VprInvitesCard({ invites }: { invites: ReferralInvites | null }) {
  const [created, setCreated] = useState<CreateInviteResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!invites?.available) return null;
  const allowance = invites.allowance;
  const link = created?.ok ? created.link : null;
  const left = created?.ok ? created.left : allowance?.left ?? null;
  const noQuota = allowance?.quota === 0 || (created?.ok === false && created.noQuota);
  const create = async () => {
    const createInvite = window.antseedDesktop?.referralCreateInvite;
    if (!createInvite || creating) return;
    setCreating(true);
    try {
      setCreated(await createInvite());
    } catch (error) {
      setCreated({ ok: false, reason: error instanceof Error ? error.message : String(error), noQuota: false });
    } finally {
      setCreating(false);
    }
  };
  const copy = () => {
    if (!link) return;
    void navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const leftHint = left !== null && allowance ? `${formatInt(left)} of ${formatInt(allowance.quota)} left this week.` : null;
  const hint = noQuota
    ? NO_QUOTA_HINT
    : link
      ? [shortInviteLink(link), leftHint].filter(Boolean).join(' · ')
      : leftHint ?? 'Single-use link, valid for 4 weeks.';
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
          <Button size="sm" variant="outline" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void create()} disabled={creating || noQuota || left === 0} aria-busy={creating}>
            {creating ? 'Creating…' : 'Create link'}
          </Button>
        )}
      />
      {created?.ok === false && !created.noQuota ? <span className={styles.errorNote}>{created.reason}</span> : null}
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
