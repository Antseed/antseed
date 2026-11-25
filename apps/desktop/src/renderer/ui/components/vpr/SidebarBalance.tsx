import { Skeleton } from '@antseed/ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { Wallet01Icon } from '@hugeicons/core-free-icons';
import { formatCredits } from '../../../core/format';
import { useFundingStatus } from '../../hooks/useFundingStatus';
import { useUiSelector } from '../../hooks/useUiSelector';
import styles from './SidebarBalance.module.scss';

/** Balance and Add funds; an amber dot (reason in the tooltip) when something blocks paid use. */
export function SidebarBalance({ credits, onAddFunds, compact = false }: { credits: string; onAddFunds: () => void; compact?: boolean }) {
  const balance = formatCredits(credits);
  const balanceKnown = useUiSelector((state) => state.creditsBalanceKnown);
  const funding = useFundingStatus();
  const blocked = balanceKnown && funding.tone === 'warning';
  if (compact) {
    // Rail form: wallet icon over the amount; the whole tile adds funds.
    const label = balanceKnown ? `Balance $${balance} · Add funds` : 'Add funds';
    return (
      <button
        type="button"
        className={styles.compact}
        onClick={onAddFunds}
        aria-label={blocked ? `${label} · ${funding.title}` : label}
        title={blocked ? `${label}\n${funding.title}` : label}
      >
        <span className={styles.compactIcon}>
          <HugeiconsIcon icon={Wallet01Icon} size={18} strokeWidth={1.7} />
          {blocked ? <span className={`${styles.dot} ${styles.compactDot}`} aria-hidden="true" /> : null}
        </span>
        {balanceKnown ? (
          <span className={styles.compactAmount}>${compactAmount(balance)}</span>
        ) : (
          <Skeleton className={styles.compactSkeleton} />
        )}
      </button>
    );
  }
  return (
    <div className={styles.card}>
      <div className={styles.row} title={blocked ? funding.title : undefined}>
        <span>Balance</span>
        {balanceKnown ? (
          <span className={styles.amount}>
            {blocked ? <span className={styles.dot} role="img" aria-label={funding.title} /> : null}
            ${balance}
          </span>
        ) : (
          // Never a fake $0.00 while the first read is in flight.
          <Skeleton className={styles.skeleton} />
        )}
      </div>
      <button type="button" className={styles.addFunds} onClick={onAddFunds}>
        Add funds
      </button>
    </div>
  );
}

/** Fits the rail: whole dollars from $100, thousands as "1.2k". */
export function compactAmount(formatted: string): string {
  const numeric = Number(formatted);
  if (!Number.isFinite(numeric)) return formatted;
  if (numeric >= 1000) return `${(numeric / 1000).toFixed(numeric >= 10_000 ? 0 : 1)}k`;
  if (numeric >= 100) return numeric.toFixed(0);
  return formatted;
}
