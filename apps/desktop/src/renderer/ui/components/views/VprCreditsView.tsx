import { useCallback, useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, CreditCardIcon, Download01Icon, SquareLock01Icon, Upload01Icon, Wallet01Icon } from '@hugeicons/core-free-icons';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { shortAddress } from '../../../core/format';
import { formatCompactTokens, VprCard, VprPage, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { BalanceSummaryCard } from './BalanceSummaryCard';
import { ExportSignerKeyDialog, ImportSignerKeyDialog } from './SignerKeyDialogs';
import styles from './VprCreditsView.module.scss';
import { recordUserAction } from '../../../modules/telemetry/actions';

const PAYMENT_SUMMARY_POLL_MS = 60_000;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

export function VprCreditsView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    available: state.creditsAvailableUsdc,
    reserved: state.creditsReservedUsdc,
    total: state.creditsTotalUsdc,
    pending: state.creditsPendingUsdc,
    wallet: state.creditsWalletUsdc,
    totalOwned: state.creditsTotalOwnedUsdc,
    creditLimit: state.creditsCreditLimitUsdc,
    evmAddress: state.creditsEvmAddress,
    operatorAddress: state.creditsOperatorAddress,
    usage: state.creditsBuyerUsage,
  }), shallowEqual);
  // Local to the button: background pollers (floating pill, payment events)
  // also refresh the summary, and mirroring their in-flight state here made
  // the button flip to "Refreshing..." constantly while traffic flowed.
  const [refreshing, setRefreshing] = useState(false);
  const [exportKeyOpen, setExportKeyOpen] = useState(false);
  const [importKeyOpen, setImportKeyOpen] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([actions.refreshCredits(), actions.refreshPaymentSummary(true)]);
    } finally {
      setRefreshing(false);
    }
  }, [actions]);

  // Drive the payment-summary poll only while this view is mounted. The
  // module-level 55s self-throttle absorbs mount/focus bursts while still
  // letting a fresh mount after staleness refresh immediately.
  useEffect(() => {
    actions.refreshPaymentSummary();
    const timer = window.setInterval(() => actions.refreshPaymentSummary(), PAYMENT_SUMMARY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [actions]);


  const balanceValues = {
    available: snap.available,
    reserved: snap.reserved,
    pending: snap.pending,
    wallet: snap.wallet,
    totalOwned: snap.totalOwned,
    creditLimit: snap.creditLimit,
    deposited: snap.total,
  };

  return (
    <section className={`view view-vpr-credits view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Profile">
      <div className={styles.stack}>

        <div className={styles.balanceGroup}>
          <BalanceSummaryCard
            values={balanceValues}
            actions={(
              <div className={styles.payButtons}>
                <button type="button" onClick={() => onSelectView?.('deposit')}>
                  <HugeiconsIcon icon={CreditCardIcon} size={16} strokeWidth={2} />
                  <HugeiconsIcon icon={Wallet01Icon} size={16} strokeWidth={2} />
                  <span>Add Credits</span>
                </button>
              </div>
            )}
          />

          <div className={styles.secureNote}>
            <HugeiconsIcon icon={SquareLock01Icon} size={12} strokeWidth={2} />
            <span>Encrypted &amp; secure checkout</span>
          </div>

          <button
            type="button"
            className={styles.withdraw}
            onClick={() => {
              recordUserAction('withdraw_start', 'credits');
              void window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'withdraw' });
            }}
          >
            Withdraw unused credits
          </button>
        </div>

        <VprStatRow>
          <VprStatTile label="Requests" value={(snap.usage?.totalRequests ?? 0).toLocaleString('en-US')} />
          <VprStatTile
            label="Tokens"
            value={formatCompactTokens(snap.usage?.totalInputTokens, snap.usage?.totalOutputTokens)}
          />
          <VprStatTile label="Sellers" value={snap.usage?.uniqueSellers ?? 0} />
        </VprStatRow>

        <VprCard className={styles.rewardsCard}>
          <span className={styles.rewardsText}>
            <strong>Payment channels</strong>{' '}
            {`${snap.usage?.activeChannels ?? 0} active — see settlements or close a channel.`}
          </span>
          <button
            type="button"
            className={styles.rewardsLink}
            onClick={() => onSelectView?.('activity')}
          >
            <span>Activity</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} />
          </button>
        </VprCard>

        <VprCard className={styles.detailsCard}>
          <div className={styles.detailRow}>
            <span>Signer</span>
            <span className={styles.signerValue}>
              <button
                type="button"
                className={styles.keyAction}
                title="Back up private key"
                aria-label="Back up private key"
                onClick={() => setExportKeyOpen(true)}
              >
                <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={styles.keyAction}
                title="Import private key"
                aria-label="Import private key"
                onClick={() => setImportKeyOpen(true)}
              >
                <HugeiconsIcon icon={Upload01Icon} size={14} strokeWidth={2} />
              </button>
              {shortAddress(snap.evmAddress)}
            </span>
          </div>
          <div className={styles.detailRow}>
            <span>Wallet</span>
            {snap.operatorAddress ? (
              <span>{shortAddress(snap.operatorAddress)}</span>
            ) : (
              <button
                type="button"
                className={styles.inlineLink}
                onClick={() => window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'authorize' })}
              >
                Authorize a wallet
              </button>
            )}
          </div>
          {/* <div className={styles.detailActions}>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => { void refresh(); }}
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div> */}
        </VprCard>

        <VprCard className={styles.rewardsCard}>
          <span className={styles.rewardsText}>
            <strong>Help &amp; support</strong>{' '}
            Guides, troubleshooting, and diagnostics.
          </span>
          <button
            type="button"
            className={styles.rewardsLink}
            onClick={() => onSelectView?.('help')}
          >
            <span>Help</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} />
          </button>
        </VprCard>
      </div>
      </VprPage>
      <ExportSignerKeyDialog isOpen={exportKeyOpen} onClose={() => setExportKeyOpen(false)} />
      <ImportSignerKeyDialog
        isOpen={importKeyOpen}
        onClose={() => setImportKeyOpen(false)}
        onImported={() => { void refresh(); }}
      />
    </section>
  );
}
