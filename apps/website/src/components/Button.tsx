import type {JSX, MouseEventHandler, ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import type {Reveal} from './Heading';
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

/** A link, an action on the page (a native button), or a faded button with nothing to click yet. */
type Props = Common & (
  | {href: string; onClick?: MouseEventHandler<HTMLAnchorElement>; type?: never; disabled?: false}
  | {type: 'button'; onClick: MouseEventHandler<HTMLButtonElement>; href?: never; disabled?: false}
  | {disabled: true; href?: never; onClick?: never; type?: never}
);

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

/** The site's button: green (primary) or ghost. External links open in a new tab; `type="button"` makes an action on the page. */
export function Button({variant = 'primary', size = 'default', className, children, ...target}: Props): JSX.Element {
  const cls = clsx(styles.button, variant === 'ghost' ? styles.ghost : styles.primary, SIZE_CLASS[size], target.disabled && styles.disabled, className);
  if (target.disabled) return <span className={cls} aria-disabled="true">{children}</span>;
  if (target.type === 'button') return <button type="button" className={cls} onClick={target.onClick}>{children}</button>;
  const {href, onClick} = target;
  return isExternal(href)
    ? <a className={cls} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>{children}</a>
    : <Link className={cls} to={href} onClick={onClick}>{children}</Link>;
}

type ActionsProps = {
  /** On phones, the row takes the full width and its buttons share it. */
  fill?: boolean;
  /** Reveal on scroll, or `'lead'`: in a first screen's offer, fading up after its sub line. */
  reveal?: Reveal;
  className?: string;
  children: ReactNode;
};

export function Actions({fill, reveal, className, children}: ActionsProps): JSX.Element {
  return <div className={clsx(styles.actions, fill && styles.fill, className)} data-rv={reveal === 'lead' ? 'lead' : reveal ? '' : undefined}>{children}</div>;
}
