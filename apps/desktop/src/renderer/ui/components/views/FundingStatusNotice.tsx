import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon } from '@hugeicons/core-free-icons';
import type { FundingStatus } from './funding-status';
import styles from './FundingStatusNotice.module.scss';

/**
 * A quiet line explaining why paid use is blocked (or what is in flight),
 * with the one or two actions that clear it. Renders nothing when funding
 * is fine.
 *
 * card  — a footer row inside the balance card: headline plus a short why.
 * strip — one muted line (chat), the why in the tooltip.
 */
export function FundingStatusNotice({
  status,
  variant = 'card',
  onAddFunds,
  onManageSessions,
  onDismiss,
  includeInfo = true,
}: {
  status: FundingStatus;
  variant?: 'card' | 'strip';
  /** Omit where the user is already adding funds. */
  onAddFunds?: () => void;
  onManageSessions?: () => void;
  onDismiss?: () => void;
  /** false: only surface blockers, not in-flight info. */
  includeInfo?: boolean;
}): JSX.Element | null {
  if (status.tone === 'ok') return null;
  if (status.tone === 'info' && !includeInfo) return null;

  const showAddFunds = Boolean(onAddFunds) && status.actions.includes('add-funds');
  const showManage = Boolean(onManageSessions) && status.actions.includes('manage-sessions');
  const strip = variant === 'strip';

  return (
    <div
      className={`${styles.notice} ${strip ? styles.strip : styles.card}`}
      role="status"
      title={strip ? status.body : undefined}
    >
      <span
        className={`${styles.dot} ${status.tone === 'warning' ? styles.dotWarning : styles.dotInfo}`}
        aria-hidden="true"
      />
      <span className={styles.text}>
        <span className={styles.title}>{status.title}</span>
        {!strip && status.body ? <span className={styles.body}>{status.body}</span> : null}
      </span>
      {showAddFunds || showManage ? (
        <span className={styles.actions}>
          {showAddFunds ? (
            <button type="button" className={styles.link} onClick={onAddFunds}>Add funds</button>
          ) : null}
          {showManage ? (
            <button type="button" className={styles.link} onClick={onManageSessions}>Manage sessions</button>
          ) : null}
        </span>
      ) : null}
      {onDismiss ? (
        <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
