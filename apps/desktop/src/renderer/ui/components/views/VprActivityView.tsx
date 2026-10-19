import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon } from '@hugeicons/core-free-icons';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { shortAddress } from '../../../core/format';
import { computeMeasuredSavings, formatSavedUsd } from '../../../modules/catalog/measured-savings';
import { ensureOpenRouterPrices, getCachedOpenRouterPrices } from '../../../modules/catalog/openrouter-baseline';
import { formatCompactTokens, VprCard, VprPage, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { VprSpendingChart } from './VprSpendingChart';
import {
  channelCloseAction,
  channelRecoverableBaseUnits,
  compareChannelsByLockedAmount,
  formatChannelLockedAmount,
  isFundedCurrentChannel,
  requestSellerAssistedClose,
  type ChannelCloseFeedback,
} from './vpr-activity-close';
import styles from './VprActivityView.module.scss';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

function baseUnitsToUsd(value: string | undefined): string {
  try {
    const units = BigInt(value ?? '0');
    const whole = units / 1_000_000n;
    const cents = (units % 1_000_000n) / 10_000n;
    return `${whole}.${cents.toString().padStart(2, '0')}`;
  } catch {
    return '0.00';
  }
}

function sumBaseUnits(values: Array<string | undefined>): string {
  let total = 0n;
  for (const value of values) {
    try {
      total += BigInt(value ?? '0');
    } catch {
      // skip malformed row
    }
  }
  return total.toString();
}

function isActiveStatus(status: string): boolean {
  return status === 'active' || status === 'open';
}

function statusTone(status: string): 'active' | 'pending' | 'closed' {
  if (isActiveStatus(status) || status === 'withdrawable') return 'active';
  if (status === 'closing' || status === 'close_requested' || status === 'pending') return 'pending';
  return 'closed';
}

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

/** In-app payment-channel activity and channel-close actions. */
export function VprActivityView({ onSelectView }: Props) {
  const actions = useActions();
  const [pendingChannelIds, setPendingChannelIds] = useState<Set<string>>(() => new Set());
  const [onChainFallbackChannelIds, setOnChainFallbackChannelIds] = useState<Set<string>>(() => new Set());
  const [closeFeedback, setCloseFeedback] = useState<Record<string, ChannelCloseFeedback>>({});
  const snap = useUiSelector((state) => ({
    channels: state.creditsChannels,
    loading: state.creditsSummaryLoading,
    reserved: state.creditsReservedUsdc,
    spendHistory: state.creditsBuyerSpendHistory,
    usage: state.creditsBuyerUsage,
  }), shallowEqual);
  const [referencePrices, setReferencePrices] = useState(getCachedOpenRouterPrices);

  // Force-refresh on entry and whenever the window regains focus — the user
  // typically lands here right after an on-chain action in the browser pay
  // popup, so the 55s summary throttle would otherwise serve stale data.
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

  useEffect(() => {
    if (referencePrices) return;
    let cancelled = false;
    void ensureOpenRouterPrices().then((prices) => {
      if (!cancelled && prices) setReferencePrices(prices);
    });
    return () => { cancelled = true; };
  }, [referencePrices]);

  const allRows = useMemo(
    () => [...snap.channels].sort((a, b) => (b.reservedAt || 0) - (a.reservedAt || 0)),
    [snap.channels],
  );
  const rows = useMemo(
    () => allRows
      .filter(isFundedCurrentChannel)
      .sort(compareChannelsByLockedAmount),
    [allRows],
  );
  const totalSpent = sumBaseUnits(allRows.map((row) => row.cumulativeSigned));
  // Header total = what the displayed rows can actually recover, so it always
  // matches their sum. The Deposits contract's raw `reserved` overstates this:
  // it still counts spend that is signed but not yet settled by the seller.
  const totalRowsLocked = useMemo(
    () => rows.reduce((acc, row) => acc + channelRecoverableBaseUnits(row), 0n),
    [rows],
  );
  const measuredSavings = useMemo(
    () => computeMeasuredSavings(snap.usage?.services, referencePrices),
    [snap.usage?.services, referencePrices],
  );
  const totalSavings = measuredSavings
    ? formatSavedUsd(measuredSavings.baselineUsd - measuredSavings.actualUsd)
    : (snap.usage?.totalRequests ?? 0) === 0 ? '$0' : '-';

  const openOnChainClose = (channelId: string) => {
    void window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'close-channel', channelId });
  };

  const askSellerToClose = async (channelId: string, peerId: string) => {
    setPendingChannelIds((current) => new Set(current).add(channelId));
    setCloseFeedback((current) => {
      const next = { ...current };
      delete next[channelId];
      return next;
    });
    const feedback = await requestSellerAssistedClose(peerId, window.antseedDesktop, {
      credits: () => actions.refreshCredits(),
      summary: () => actions.refreshPaymentSummary(true),
    }, channelId);
    setCloseFeedback((current) => ({ ...current, [channelId]: feedback }));
    if (feedback.tone === 'error') {
      setOnChainFallbackChannelIds((current) => new Set(current).add(channelId));
    }
    setPendingChannelIds((current) => {
      const next = new Set(current);
      next.delete(channelId);
      return next;
    });
  };

  return (
    <section className={`view view-vpr-activity view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Activity" backFallback="credits">
      <div className={styles.stack}>

        <VprStatRow>
          <VprStatTile
            label="Tokens"
            value={formatCompactTokens(snap.usage?.totalInputTokens, snap.usage?.totalOutputTokens)}
          />
          <VprStatTile label="Spent" value={`$${baseUnitsToUsd(totalSpent)}`} />
          <VprStatTile
            label="Saved"
            value={(
              <span title={measuredSavings
                ? `Measured against retail reference prices across ${measuredSavings.matchedServices} matched services`
                : undefined}
              >
                {totalSavings}
              </span>
            )}
          />
        </VprStatRow>

        <VprSpendingChart history={snap.spendHistory} loading={snap.loading} />

        <div className={styles.sectionIntro}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Active channels</h2>
            <span className={styles.sectionValue}>${baseUnitsToUsd(totalRowsLocked.toString())} locked</span>
          </div>
        </div>

        {rows.length === 0 ? (
          <VprCard className={styles.emptyCard}>
            <span className={styles.emptyTitle}>{snap.loading ? 'Loading activity...' : 'No open channels'}</span>
            <span className={styles.emptyHint}>
              Channels open automatically when you start using the network.
            </span>
          </VprCard>
        ) : (
          <VprCard className={styles.listCard}>
            {rows.map((row) => {
              const closeAction = channelCloseAction(
                row.status,
                row.cooperativeCloseSupported,
                onChainFallbackChannelIds.has(row.channelId),
              );
              const pending = pendingChannelIds.has(row.channelId);
              const feedback = closeFeedback[row.channelId];
              return (
                <div key={row.channelId} className={styles.row}>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>
                      <span className={styles.rowSellerGroup}>
                        <span className={styles.rowSeller}>{row.sellerDisplayName || shortAddress(row.seller || row.peerId || null)}</span>
                      </span>
                      {!isActiveStatus(row.status) && (
                        <span className={`${styles.statusPill} ${styles[`status_${statusTone(row.status)}`]}`}>
                          {row.status}
                        </span>
                      )}
                    </div>
                    {feedback && (
                      <span className={`${styles.closeFeedback} ${styles[`closeFeedback_${feedback.tone}`]}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
                        {feedback.message}
                      </span>
                    )}
                  </div>
                  <span className={styles.rowLocked}>
                    {formatChannelLockedAmount(row)}
                  </span>
                  <div className={styles.rowSide}>
                    {closeAction === 'seller-and-on-chain' && (
                      <button
                        type="button"
                        className={styles.rowAction}
                        disabled={pending}
                        onClick={() => { void askSellerToClose(row.channelId, row.peerId); }}
                      >
                        {pending ? 'Closing…' : 'Close channel'}
                      </button>
                    )}
                    {closeAction === 'on-chain' && (
                      <button type="button" className={styles.rowActionSecondary} onClick={() => openOnChainClose(row.channelId)}>
                        <span>Request on-chain close</span>
                        <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                      </button>
                    )}
                    {closeAction === 'withdraw' && (
                      <button type="button" className={styles.rowAction} onClick={() => openOnChainClose(row.channelId)}>
                        <span>Withdraw</span>
                        <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </VprCard>
        )}

        {rows.length > 0 && (
          <p className={styles.channelFootnote}>
            Active channels hold funds that cannot be spent elsewhere. Close a channel to release
            them.
          </p>
        )}

      </div>
      </VprPage>
    </section>
  );
}
