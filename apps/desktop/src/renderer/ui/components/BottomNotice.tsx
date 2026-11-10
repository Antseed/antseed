import { useLayoutEffect, useRef, type ReactNode } from 'react';
import styles from './BottomNotice.module.scss';
import { createBarHeights } from './bottom-notice-height.js';

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
  tone?: 'danger' | 'success' | 'neutral';
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

  const ref = useBarHeight(layout === 'bar');

  return (
    <div ref={ref} className={className} role={role} aria-live={ariaLive} data-bottom-notice={layout}>
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

/**
 * A bar lies over the window's last rows; its height goes to
 * `--bottom-notice-height` so the layout can end right above it.
 */
const barHeights = createBarHeights((height) => {
  const root = document.documentElement;
  if (height === null) root.style.removeProperty('--bottom-notice-height');
  else root.style.setProperty('--bottom-notice-height', `${height}px`);
});

function useBarHeight(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return undefined;
    const apply = () => barHeights.set(element, Math.ceil(element.getBoundingClientRect().height));
    apply();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      barHeights.remove(element);
    };
  }, [enabled]);
  return ref;
}
