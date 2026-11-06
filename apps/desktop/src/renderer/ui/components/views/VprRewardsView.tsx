import { StakingButton } from '../StakingButton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatCredits, formatInt } from '../../../core/format';
import type { RendererUiState } from '../../../core/state';
import type { RefereeBonus, ReferralInvites, ReferralStatus } from '../../../types/bridge';
import { useReferralStatus } from '../../hooks/useReferralStatus';
import { ReferralStatusRow } from '../ReferralStatusRow';
import { VprBadge, VprCard, VprPage, VprSettingRow } from '../vpr/VprKit';
import { VprFreeTierCard } from './VprFreeTierCard';
import { VprInvitesCard } from './VprInvitesCard';
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
  const { status: referral, reload: loadReferral } = useReferralStatus();

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
        <VprFreeTierCard />

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
