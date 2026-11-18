import type {JSX, MouseEventHandler, ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import styles from './Button.module.css';

/**
 * `default` 44px; `large` 48px; `page` 44px, 40px from 1200px (the secondary pages' wide scale); `compact` 40px; `small` 36px in the
 * UI face (the nav's row).
 */
export type ButtonSize = 'default' | 'large' | 'page' | 'compact' | 'small';

type Common = {
  variant?: 'primary' | 'ghost';
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
};

/** A link, or a faded button with nothing to click yet. */
type Props = Common & ({href: string; onClick?: MouseEventHandler<HTMLAnchorElement>; disabled?: false} | {disabled: true; href?: never; onClick?: never});

/** A button as data, for lists of actions. */
export type ActionLink = {href: string; label: string; variant?: 'primary' | 'ghost'};

const SIZE_CLASS: Record<ButtonSize, string | undefined> = {
  default: undefined,
  large: styles.large,
  page: styles.page,
  compact: styles.compact,
  small: styles.small,
};

const isExternal = (href: string) => /^https?:\/\//.test(href);

/** The site's button: green (primary) or ghost. External links open in a new tab. */
export function Button({variant = 'primary', size = 'default', className, children, ...target}: Props): JSX.Element {
  const cls = clsx(styles.button, variant === 'ghost' && styles.ghost, SIZE_CLASS[size], target.disabled && styles.disabled, className);
  if (target.disabled) return <span className={cls} aria-disabled="true">{children}</span>;
  const {href, onClick} = target;
  return isExternal(href)
    ? <a className={cls} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>{children}</a>
    : <Link className={cls} to={href} onClick={onClick}>{children}</Link>;
}

type ActionsProps = {
  /** On phones, the row takes the full width and its buttons share it. */
  fill?: boolean;
  /** Reveal on scroll. */
  reveal?: boolean;
  className?: string;
  children: ReactNode;
};

export function Actions({fill, reveal, className, children}: ActionsProps): JSX.Element {
  return <div className={clsx(styles.actions, fill && styles.fill, className)} data-rv={reveal ? '' : undefined}>{children}</div>;
}
