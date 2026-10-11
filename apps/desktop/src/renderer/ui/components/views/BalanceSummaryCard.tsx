import { useContext, type ReactNode } from 'react';
import { formatCredits } from '../../../core/format';
import { VprCard } from '../vpr/VprKit';
import { VprNavContext } from '../vpr/VprNavContext';
import { BalanceInfoPopover, BalanceWarning } from './BalanceBreakdown';
import { hasPositiveAmount, type BalanceBreakdownValues } from './balance-breakdown';
import styles from './BalanceSummaryCard.module.scss';

export function BalanceSummaryCard({ values, actions }: {
  values: BalanceBreakdownValues;
  actions?: ReactNode;
}): JSX.Element {
  const nav = useContext(VprNavContext);
  // The headline is everything the buyer owns; when part of it can't start a
  // new session (held, or still in the deposit wallet), spell out the split.
  const split = hasPositiveAmount(values.reserved) || hasPositiveAmount(values.wallet)
    ? [
      { label: 'available', value: values.available },
      ...(hasPositiveAmount(values.reserved) ? [{ label: 'held in sessions', value: values.reserved }] : []),
      ...(hasPositiveAmount(values.wallet) ? [{ label: 'not deposited yet', value: values.wallet }] : []),
    ]
    : null;
  return (
    <VprCard className={styles.card}>
      <span className={styles.labelRow}>
        <span className={styles.label}>Your balance</span>
        <BalanceInfoPopover values={values} onManageOpenSessions={() => nav?.navigate('activity')} />
      </span>
      <span className={styles.valueRow}>
        <span className={styles.value}>${formatCredits(values.totalOwned)}</span>
        <BalanceWarning values={values} />
      </span>
      {split ? (
        <span className={styles.split}>
          {split.map((part, index) => (
            <span key={part.label}>
              {index > 0 ? <span className={styles.splitSep} aria-hidden="true">·</span> : null}
              <strong>${formatCredits(part.value)}</strong> {part.label}
            </span>
          ))}
        </span>
      ) : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </VprCard>
  );
}
