import {forwardRef, type JSX, type ReactNode, type Ref} from 'react';
import clsx from 'clsx';
import {Glass} from '../../../parts/Glass/Glass';
import styles from './Scene.module.css';

/** A product screen drawn over a painting: a fixed-size stage centred on its panel, holding glass windows and a pointer. */
export const Stage = forwardRef<HTMLDivElement, {label: string; className?: string; children: ReactNode}>(function Stage({label, className, children}, ref) {
  return <div ref={ref} className={clsx(styles.stage, className)} role="img" aria-label={label}>{children}</div>;
});

export function Window({ref, className, children}: {ref?: Ref<HTMLElement>; className?: string; children: ReactNode}): JSX.Element {
  return <Glass pane ref={ref} className={clsx(styles.window, className)}>{children}</Glass>;
}

export function Cursor({className}: {className?: string}): JSX.Element {
  return (
    <svg className={clsx(styles.cursor, className)} viewBox="0 0 15 20.5" aria-hidden="true">
      <path d="M1.2 1.2V16.4l3.7-3.5 2.4 5.7 2.5-1.1-2.4-5.5h5.2z" />
    </svg>
  );
}

export function CheckIcon({className}: {className?: string}): JSX.Element {
  return <svg className={clsx(styles.check, className)} viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.6l3 3 6.6-7" /></svg>;
}

type MiniButtonProps = {className?: string; children: ReactNode};

/** A picture of the site's button at the scene's size: never a control. */
export function MiniButton({className, children}: {className?: string; children: ReactNode}): JSX.Element {
  return <span className={clsx(styles.button, className)}>{children}</span>;
}

/** A logo on a small glass tile (or bare, for logos with their own background). */
export function Logo({src, glass = true, className}: {src: string; glass?: boolean; className?: string}): JSX.Element {
  return <span className={clsx(glass ? styles.glassLogo : styles.logo, className)}><img src={src} alt="" width={16} height={16} loading="lazy" /></span>;
}
