import { Alert, Button } from '@antseed/ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { formatUsd, type FundingStatus } from './funding-status';
import styles from './FundingStatusNotice.module.scss';

/**
 * Explains why paid use is blocked (or what is in flight) and offers the one
 * or two actions that clear it. Renders nothing when funding is fine.
 */
export function FundingStatusNotice({ status, onAddFunds, onManageSessions, onDismiss, includeInfo = true, className }: {
  status: FundingStatus;
  /** Omit where the user is already adding funds. */
  onAddFunds?: () => void;
  onManageSessions?: () => void;
  onDismiss?: () => void;
  /** false: only surface blockers (warnings), not in-flight info. */
  includeInfo?: boolean;
  className?: string;
}): JSX.Element | null {
  if (status.tone === 'ok') return null;
  if (status.tone === 'info' && !includeInfo) return null;

  const showAddFunds = Boolean(onAddFunds) && status.actions.includes('add-funds');
  const showManage = Boolean(onManageSessions) && status.actions.includes('manage-sessions');
  const showSessions = status.kind === 'all-reserved' && status.sessions.length > 0;

  return (
    <Alert
      tone={status.tone === 'warning' ? 'warning' : 'info'}
      title={status.title}
      className={`${styles.notice}${className ? ` ${className}` : ''}`}
      action={onDismiss ? (
        <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
          <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
        </button>
      ) : undefined}
    >
      <p className={styles.body}>{status.body}</p>
      {showSessions ? (
        <ul className={styles.sessions}>
          {status.sessions.map((session, index) => (
            <li key={`${session.sellerName}-${index}`}>
              <span className={styles.sessionName}>{session.sellerName}</span>
              <span>
                {formatUsd(session.heldBaseUnits)} held
                {session.unusedBaseUnits > 0n ? ` · ${formatUsd(session.unusedBaseUnits)} unused` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {showAddFunds || showManage ? (
        <div className={styles.actions}>
          {showAddFunds ? (
            <Button size="sm" variant="primary" onClick={onAddFunds}>
              {status.sendMoreBaseUnits ? `Add ${formatUsd(status.sendMoreBaseUnits, 'up')}+` : 'Add funds'}
            </Button>
          ) : null}
          {showManage ? (
            <Button size="sm" variant="outline" onClick={onManageSessions}>
              Manage sessions
            </Button>
          ) : null}
        </div>
      ) : null}
    </Alert>
  );
}
