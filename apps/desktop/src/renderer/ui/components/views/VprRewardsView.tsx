import { StakingButton } from '../StakingButton';
import { useEffect, useMemo, useState } from 'react';
import { formatCountdown, weekEstimate } from '@antseed/ants/points';
import { paidSellerBoosts } from '../../../modules/catalog/boost-summary';
import { formatBoost } from '../../../modules/catalog/seller-format';
import type { DiscoverRow } from '../../../core/state';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { pointsUrl } from '../../../core/constants';
import { formatCredits } from '../../../core/format';
import type { DesktopPointsSummary } from '../../../types/bridge';
import { VprBadge, VprCard, VprPage } from '../vpr/VprKit';
import styles from './VprRewardsView.module.scss';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const SPEND_PRESETS = [10, 50, 250, 1000];

/** "12,557" from 100 up, "85.2" below. */
const formatAntsAmount = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: value >= 100 ? 0 : 2 });

/** Where `value` sits on a 0…max bar, as a percentage. */
const pct = (value: number, max: number) => (max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0);

/** Re-renders every `ms`, so the time left and the projection stay live. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * "What would you earn?", the Points site's calculator, starting from this
 * wallet's points so far: $ spent × the seller's boost = points, then points ×
 * this week's rate = $ANTS, projected to the week's close from this week's
 * pace. The math is the shared `weekEstimate`, so the numbers match the site
 * and the gateway console. Only paid sellers are offered: free models earn nothing.
 */
export function PointsCalculator({ points, rows, now: fixedNow }: { points: DesktopPointsSummary; rows: readonly DiscoverRow[]; now?: number }) {
  const sellers = useMemo(() => paidSellerBoosts(rows), [rows]);
  const [spend, setSpend] = useState(50);
  const [peerId, setPeerId] = useState<string | null>(null);
  const liveNow = useNow(30_000);
  const now = fixedNow ?? liveNow;
  if (points.potAnts === null || points.totalPoints === null) return null;
  const seller = sellers.find((entry) => entry.peerId === peerId) ?? sellers[0] ?? null;
  const boost = seller?.boost ?? 0;
  const week = weekEstimate({
    potAnts: points.potAnts, totalPoints: points.totalPoints, myPoints: points.points, spendUsd: spend, boost,
    startsAt: points.startsAt, endsAt: points.endsAt, busyPointsPerDay: points.busyPointsPerDay, now,
  });
  const closes = points.endsAt ? new Date(points.endsAt).toLocaleDateString('en-US', { weekday: 'long' }) : 'the end of the week';
  const range = week.range;
  return (
    <VprCard className={styles.calcCard}>
      <div className={styles.calcTop}>
        <span className={styles.calcTitle}>What would you earn?</span>
        <span className={styles.calcLive}><i aria-hidden="true" />{week.leftMs !== null ? `${formatCountdown(week.leftMs)} left` : 'This week'}</span>
      </div>
      <div className={styles.calcQ}>
        <span>If you spend</span>
        <div className={styles.calcOpts} role="group" aria-label="Spend">
          {SPEND_PRESETS.map((value) => (
            <button key={value} type="button" className={styles.calcOpt} aria-pressed={spend === value} onClick={() => setSpend(value)}>
              ${value.toLocaleString('en-US')}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.calcQ}>
        <span>with the seller</span>
        {sellers.length > 0 ? (
          <select className={styles.calcSelect} aria-label="Seller" value={seller?.peerId ?? ''} onChange={(event) => setPeerId(event.target.value)}>
            {sellers.map((entry) => <option key={entry.peerId} value={entry.peerId}>{entry.name} · {formatBoost(entry.boost)}</option>)}
          </select>
        ) : (
          <span className={styles.aboutText}>No paid seller has a boost right now, so more spend earns no points.</span>
        )}
      </div>
      <div className={styles.calcSteps} aria-live="polite">
        <div><span>${spend.toLocaleString('en-US')} × {formatBoost(boost)} boost</span><b>{formatPoints(week.addedPoints)} points</b></div>
        {points.points > 0 && <div><span>+ {formatPoints(points.points)} points you have this week</span><b>{formatPoints(week.points)} points</b></div>}
        <div>
          <span>{formatPoints(week.points)} points × {week.antsPerPoint.toLocaleString('en-US', { maximumFractionDigits: 2 })} $ANTS each right now</span>
          <b>{week.capped ? 'capped at 5%' : `${formatAntsAmount(week.now)} $ANTS`}</b>
        </div>
      </div>
      <div className={styles.calcTotal}>
        <span>By {closes}, about</span>
        <b className={boost === 0 ? styles.calcZero : undefined}>{formatAntsAmount(range?.expected ?? week.now)} $ANTS</b>
      </div>
      {range && range.now > 0 && (
        <div className={styles.calcRange} aria-label="Likely range">
          <div className={styles.calcBar}><i style={{ left: `${pct(range.low, range.now)}%`, right: 0 }} /><b style={{ left: `${pct(range.expected, range.now)}%` }} /></div>
          <div className={styles.calcRangeLabels}><span>Likely {formatAntsAmount(range.low)} – {formatAntsAmount(range.now)} $ANTS</span><span>{formatAntsAmount(range.now)} is the most: today&apos;s rate</span></div>
        </div>
      )}
      <span className={styles.aboutText}>
        {points.endsAt ? `Every ${closes}` : 'At the end of each week'} the week&apos;s pot is shared out by points. Each point is worth less as more people spend before then, so this projects the rest of the week from this week&apos;s pace.
      </span>
    </VprCard>
  );
}

/** Antseed Points, whole: "1,241". */
export function formatPoints(points: number): string {
  return Math.round(points).toLocaleString('en-US');
}

/** "≈ 85.2 $ANTS · final Thu, Oct 22, 09:54"; why there is no number when points can't be read. */
/**
 * The points card's line under the number, on the same projection as the
 * calculator (`weekEstimate`, no extra spend): "By Thursday, about 85 $ANTS ·
 * likely 60–120". Falls back to today's estimate when the week's dates are
 * unknown, and says so when there is nothing to estimate.
 */
export function pointsHint(points: DesktopPointsSummary | null, now = Date.now()): string {
  if (!points) return "Points can't be read right now.";
  if (points.points <= 0) return 'No points yet this week.';
  if (points.potAnts === null || points.totalPoints === null) {
    return points.estimatedAnts === null ? '$ANTS estimate unavailable right now.' : `≈ ${formatAntsAmount(points.estimatedAnts)} $ANTS at today's rate`;
  }
  const week = weekEstimate({
    potAnts: points.potAnts, totalPoints: points.totalPoints, myPoints: points.points, spendUsd: 0, boost: 0,
    startsAt: points.startsAt, endsAt: points.endsAt, busyPointsPerDay: points.busyPointsPerDay, now,
  });
  const capped = week.capped ? ' (5% cap)' : '';
  if (!week.range || points.endsAt === null) return `≈ ${formatAntsAmount(week.now)} $ANTS at today's rate${capped}`;
  const closes = new Date(points.endsAt).toLocaleDateString('en-US', { weekday: 'long' });
  const { expected, low, now: high } = week.range;
  const likely = high - low >= 0.01 ? ` · likely ${formatAntsAmount(low)}–${formatAntsAmount(high)}` : '';
  return `By ${closes}, about ${formatAntsAmount(expected)} $ANTS${capped}${likely}`;
}

/**
 * In-app $ANTS rewards (moved from the browser portal). The summary is
 * read-only; claiming transfers tokens on-chain and needs the authorized
 * wallet's signature, so the claim actions open the shared rewards dashboard.
 */
export function VprRewardsView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    rewards: state.creditsRewards,
    loading: state.creditsSummaryLoading,
    buyerAddress: state.creditsEvmAddress,
    rows: state.vprRoutableRows,
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

  const rewards = snap.rewards;
  const points = rewards?.points ?? null;
  const pending = rewards?.available ? rewards.pendingAnts : '0';
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
              {rewards?.available
                ? `Earned from your usage${rewards.currentEpoch !== null ? ` — epoch ${rewards.currentEpoch}` : ''}.`
                : 'Rewards are not live on this chain yet.'}
            </span>
          </div>
          <div className={styles.heroActions}>
            {rewards?.available && (
              <VprBadge tone={rewards.transfersEnabled ? 'green' : 'neutral'}>
                {rewards.transfersEnabled ? 'Transfers live' : 'Transfers not enabled yet'}
              </VprBadge>
            )}
            <StakingButton page="rewards" className={styles.claimButton} disabled={!rewards?.available || !hasPending} copyDisabled={!rewards?.available}>
              Claim rewards ↗
            </StakingButton>
          </div>
        </VprCard>

        <VprCard className={styles.heroCard}>
          <div className={styles.heroText}>
            <span className={styles.heroLabel}>Antseed Points this week</span>
            <span className={styles.heroValue}>{points ? formatPoints(points.points) : '-'}</span>
            <span className={styles.heroHint}>{pointsHint(points)}</span>
          </div>
          <span className={styles.aboutText}>
            Each $1 you spend earns points times the seller&apos;s boost; free models earn none. When the week ends, the
            buyer $ANTS pot is split by points (at most 5% of it to one buyer) and lands in Pending $ANTS.
          </span>
          <button
            type="button"
            className={styles.textLink}
            onClick={() => void window.antseedDesktop?.openExternalUrl?.(pointsUrl(snap.buyerAddress))}
          >
            Leaderboard and how points work ↗
          </button>
        </VprCard>

        {points && <PointsCalculator points={points} rows={snap.rows ?? []} />}

        <VprCard className={styles.aboutCard}>
          <span className={styles.aboutTitle}>Staking</span>
          <span className={styles.aboutText}>
            Manage positions and staking rewards in your browser. Connect a wallet to approve transactions.
          </span>
          <StakingButton className={styles.claimButton}>Manage staking ↗</StakingButton>
        </VprCard>

        <span className={styles.errorNote}>Copy a link to use your wallet in another browser.</span>

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
