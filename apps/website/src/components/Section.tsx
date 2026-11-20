import {useRef, type CSSProperties, type JSX, type ReactNode} from 'react';
import clsx from 'clsx';
import useBrokenLinks from '@docusaurus/useBrokenLinks';
import {useGridSnap} from '../lib/useGridSnap';
import styles from './Section.module.css';

export type Outline = {top?: boolean; right?: boolean; bottom?: boolean; left?: boolean};

type Props = {
  /** Comparison key, `<page>/<section>`; the visual diff tool selects `[data-cmp]`. */
  cmp: string;
  id?: string;
  className?: string;
  /** Class for the 1312px rail inside the section. */
  railClassName?: string;
  /** Render children directly, without the rail. */
  bare?: boolean;
  /** Dotted outline sides on the rail. Default: top, right, left (the next section's top closes the bottom). */
  outline?: Outline;
  /** Round the height up to the 8px dot grid: always (default), never (blocks that keep their own grid), or `narrow`: below 1200px
   *  only, for a block that is exactly the screen on wider ones. */
  snap?: boolean | 'narrow';
  /** Inner padding of the rail: `all` (120 / 72 on phones), `x` (side margin only), `y`, or none. */
  pad?: 'all' | 'x' | 'y';
  label?: string;
  labelledBy?: string;
  style?: CSSProperties;
  children: ReactNode;
};

const NARROW = '(max-width: 1199px)';
const DEFAULT_OUTLINE: Outline = {top: true, right: true, left: true};

export function Section({cmp, id, className, railClassName, bare, outline = DEFAULT_OUTLINE, snap = true, pad, label, labelledBy, style, children}: Props): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  // registers the id, so the build's anchor check accepts links to it
  useBrokenLinks().collectAnchor(id);
  useGridSnap(ref, {enabled: snap !== false, media: snap === 'narrow' ? NARROW : undefined});
  return (
    <section ref={ref} id={id} className={clsx(styles.section, className)} data-cmp={cmp} aria-label={label} aria-labelledby={labelledBy} style={style}>
      {bare ? children : (
        <div
          className={clsx(
            styles.rail,
            outline.top && styles.outlineTop,
            outline.right && styles.outlineRight,
            outline.bottom && styles.outlineBottom,
            outline.left && styles.outlineLeft,
            pad === 'all' && styles.padAll,
            pad === 'x' && styles.padX,
            pad === 'y' && styles.padY,
            railClassName,
          )}>
          {children}
        </div>
      )}
    </section>
  );
}
