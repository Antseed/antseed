import {createElement, type JSX, type ReactNode, type Ref} from 'react';
import clsx from 'clsx';
import styles from './Glass.module.css';

type GlassProps = {
  as?: 'div' | 'p' | 'span' | 'dl' | 'h3';
  /** The lighter window glass. */
  pane?: boolean;
  /** Smoked green in both themes (over a night painting). */
  night?: boolean;
  /** Hidden from assistive technology (the painting's caption says it). */
  decorative?: boolean;
  /** Describes a drawn scene; makes the glass an image. */
  label?: string;
  ref?: Ref<HTMLElement>;
  className?: string;
  children: ReactNode;
};

/** A frosted glass surface over a painting. Place, size and round it with `className`. */
export function Glass({as = 'div', pane, night, decorative, label, ref, className, children}: GlassProps): JSX.Element {
  return createElement(as, {
    ref,
    className: clsx(styles.glass, pane && styles.pane, night && styles.night, className),
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': decorative || undefined,
  }, children);
}

/** The layer glass is drawn on over a painting (put it inside the `Wash`). */
export function GlassLayer({label, children}: {label?: string; children: ReactNode}): JSX.Element {
  return <div className={styles.layer} role={label ? 'img' : undefined} aria-label={label}>{children}</div>;
}

export type GlassRow = {term: ReactNode; value: ReactNode};

type WindowProps = {
  title: ReactNode;
  /** Before the title (an icon or a light). */
  icon?: ReactNode;
  /** Term and value on one line each. */
  rows?: readonly GlassRow[];
  /** A line under the title. */
  text?: ReactNode;
  night?: boolean;
  className?: string;
  children?: ReactNode;
};

/** A small glass window: its title, then rows, a line of text or anything else. */
export function GlassWindow({title, icon, rows, text, night, className, children}: WindowProps): JSX.Element {
  return (
    <Glass night={night} className={clsx(styles.window, styles.small, className)}>
      <p className={styles.windowTitle}>{icon}{title}</p>
      {text && <p className={styles.windowText}>{text}</p>}
      {children}
      {rows && (
        <dl className={styles.rows}>
          {rows.map((r, i) => <div key={i}><dt>{r.term}</dt><dd>{r.value}</dd></div>)}
        </dl>
      )}
    </Glass>
  );
}

/** A glass pill. */
export function GlassChip({night, className, children}: {night?: boolean; className?: string; children: ReactNode}): JSX.Element {
  return <Glass as="p" night={night} className={clsx(styles.chip, styles.small, className)}>{children}</Glass>;
}
