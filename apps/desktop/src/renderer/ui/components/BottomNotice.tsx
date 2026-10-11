import type { ReactNode } from 'react';
import styles from './BottomNotice.module.scss';

export interface BottomNoticeAction {
  label: ReactNode;
  onClick: () => void;
}

interface Props {
  actions?: BottomNoticeAction[];
  align?: 'center' | 'start';
  ariaLive?: 'assertive' | 'polite';
  body?: ReactNode;
  detail?: ReactNode;
  dismissIcon?: ReactNode;
  dismissLabel?: string;
  icon: ReactNode;
  layout?: 'bar' | 'toast';
  onDismiss?: () => void;
  priority?: 'default' | 'overlay';
  role?: 'alert' | 'status';
  title?: ReactNode;
  tone?: 'danger' | 'success' | 'warning';
}

export function BottomNotice({
  actions = [],
  align = 'center',
  ariaLive,
  body,
  detail,
  dismissIcon = '×',
  dismissLabel,
  icon,
  layout = 'bar',
  onDismiss,
  priority = 'default',
  role = 'status',
  title,
  tone = 'success',
}: Props) {
  const className = [
    styles.notice,
    styles[layout],
    styles[tone],
    align === 'start' ? styles.alignStart : '',
    priority === 'overlay' ? styles.overlay : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={className} role={role} aria-live={ariaLive}>
      <span className={styles.icon} aria-hidden="true">{icon}</span>
      <div className={styles.text}>
        {title !== undefined && <span className={styles.title}>{title}</span>}
        {body !== undefined && <span className={styles.body}>{body}</span>}
        {detail}
      </div>
      {actions.map((action, index) => (
        <button key={index} type="button" className={styles.action} onClick={action.onClick}>
          {action.label}
        </button>
      ))}
      {onDismiss && (
        <button
          type="button"
          className={styles.dismiss}
          aria-label={dismissLabel ?? 'Dismiss notification'}
          onClick={onDismiss}
        >
          {dismissIcon}
        </button>
      )}
    </div>
  );
}
