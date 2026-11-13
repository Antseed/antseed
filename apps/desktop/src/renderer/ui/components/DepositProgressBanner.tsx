import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, ArrowUpRight01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useUiSelector } from '../hooks/useUiSelector';
import { useActions } from '../hooks/useActions';
import type { DepositWatchStatus } from '../../types/bridge';
import { BottomNotice } from './BottomNotice';
import { formatUsd, shortfallBaseUnits } from './views/funding-status';
import styles from './DepositProgressBanner.module.scss';

const CREDITED_AUTO_HIDE_MS = 10_000;

function baseUnitsToUsd(baseUnits: string | undefined): string {
  if (!baseUnits) return '0';
  const value = Number(baseUnits) / 1e6;
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function explorerTxUrl(txHash: string): string {
  return `https://basescan.org/tx/${txHash}`;
}

/**
 * App-wide deposit progress notification — same bottom-bar presentation as
 * UpdateBanner. The main-process deposit watcher keeps running (at a slower
 * cadence) after the deposit view closes, so a card/Fun delivery landing
 * minutes later is still swept; this banner is how that progress stays
 * visible from any view.
 */
export function DepositProgressBanner({ onAddFunds, onDepositView = false }: {
  onAddFunds?: () => void;
  /** The deposit view's own status line already says it; don't repeat. */
  onDepositView?: boolean;
} = {}) {
  const networkAlert = useUiSelector((state) => state.networkAlert);
  const actions = useActions();
  const [status, setStatus] = useState<DepositWatchStatus | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const bridge = window.antseedDesktop;
    if (!bridge?.onDepositsWatchStatus) return undefined;
    const unsubscribe = bridge.onDepositsWatchStatus((data) => {
      if (hideTimer.current) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      // A wallet short of the deposit minimum needs the user to act — keep
      // it on screen. Other deferrals (credit limit) resolve on their own.
      if (data.phase === 'deferred' && data.reason !== 'below-minimum') {
        setStatus((current) => current?.phase === 'credited' ? current : null);
        return;
      }
      if (data.phase !== 'sweeping') actions.refreshCredits();
      setStatus(data);
      if (data.phase === 'credited') {
        hideTimer.current = window.setTimeout(() => setStatus(null), CREDITED_AUTO_HIDE_MS);
      }
    });
    return () => {
      unsubscribe();
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [actions]);

  // The network alert owns the slot.
  if (networkAlert !== 'none' || !status) return null;
  if (onDepositView && status.phase === 'deferred') return null;

  const { phase } = status;
  const amount = baseUnitsToUsd(status.amountBaseUnits);
  const belowMinimum = phase === 'deferred' && status.minRequiredBaseUnits != null;
  const need = BigInt(status.minRequiredBaseUnits ?? '0');
  const short = shortfallBaseUnits(need, BigInt(status.amountBaseUnits ?? '0'));

  let tone: 'danger' | 'success' | 'neutral' = 'success';
  if (phase === 'error') tone = 'danger';
  else if (belowMinimum) tone = 'neutral';

  let body: string | undefined;
  if (belowMinimum) body = `A first deposit is at least ${formatUsd(need)}, including the network fee. Your USDC is safe meanwhile.`;
  else if (phase === 'received') body = 'Preparing the deposit…';
  else if (phase === 'error') body = status.error;

  const title = belowMinimum
    ? `Received $${amount} · send ${formatUsd(short, 'up')} more to finish your deposit`
    : phase === 'received'
    ? `Received $${amount}`
    : phase === 'sweeping'
      ? `Depositing $${amount} to your credits…`
      : phase === 'credited'
        ? `$${amount} added to your balance`
        : 'Deposit needs attention';

  // Portaled to <body>: the banner must escape the app's stacking contexts to
  // paint above overlays — most importantly the Fun checkout modal, which
  // sits at z-index 2147483646 while a deposit is in flight.
  return createPortal(
    <BottomNotice
      actions={belowMinimum && onAddFunds ? [{
        label: 'Add funds',
        onClick: onAddFunds,
      }] : phase === 'credited' && status.txHash ? [{
        label: (
          <>
            <span>View transaction</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={2} />
          </>
        ),
        onClick: () => void window.antseedDesktop?.openExternalUrl?.(explorerTxUrl(status.txHash!)),
      }] : []}
      body={body}
      dismissLabel="Dismiss deposit status"
      icon={phase === 'credited' ? (
        <HugeiconsIcon icon={Tick02Icon} size={18} strokeWidth={2.5} />
      ) : phase === 'error' ? (
        <HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.8} />
      ) : (
        <span
          className={styles.pulse}
          style={{ background: phase === 'sweeping' ? 'var(--accent-green)' : '#f59e0b' }}
        />
      )}
      onDismiss={() => setStatus(null)}
      priority="overlay"
      role={phase === 'error' ? 'alert' : 'status'}
      title={title}
      tone={tone}
    />,
    document.body,
  );
}
