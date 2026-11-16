import type { ReactNode } from 'react';
import { Button, Skeleton } from '@antseed/ui';
import { formatCredits } from '../../../core/format';
import { VprCard } from '../vpr/VprKit';
import { useUiSelector } from '../../hooks/useUiSelector';
import { balanceSplit, type BalanceBreakdownValues } from './balance-breakdown';
import styles from './BalanceSummaryCard.module.scss';

export function BalanceSummaryCard({ values, actions, notice, onShowSessions }: {
  values: BalanceBreakdownValues;
  actions?: ReactNode;
  /** Footer line explaining a funding blocker (FundingStatusNotice). */
  notice?: ReactNode;
  /** Opens the payment channels in the gateway console; "held in sessions" links there. */
  onShowSessions?: () => void;
}): JSX.Element {
  const balanceKnown = useUiSelector((state) => state.creditsBalanceKnown);
  // The headline is everything the buyer owns; when part of it can't start a
  // new session (held, or still in the deposit wallet), spell out the split.
  const split = balanceKnown ? balanceSplit(values) : null;
  return (
    <VprCard className={styles.card}>
      <span className={styles.labelRow}>
        <span className={styles.label}>Your balance</span>
      </span>
      {balanceKnown ? (
        <span className={styles.valueRow}>
          <span className={styles.value}>${formatCredits(values.totalOwned)}</span>
        </span>
      ) : (
        <Skeleton className={styles.valueSkeleton} aria-label="Loading balance" />
      )}
      {split ? (
        <span className={styles.split}>
          {split.map((part, index) => (
            <span key={part.label}>
              {index > 0 ? <span className={styles.splitSep} aria-hidden="true">·</span> : null}
              <strong>${formatCredits(part.value)}</strong>{' '}
              {part.opensSessions && onShowSessions ? (
                <Button variant="link" size="sm" onClick={onShowSessions} title="See and close your sessions in your gateway">
                  {part.label}
                </Button>
              ) : part.label}
            </span>
          ))}
        </span>
      ) : null}
      {notice}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </VprCard>
  );
}
