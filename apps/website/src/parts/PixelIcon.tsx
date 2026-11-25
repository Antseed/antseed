import type {CSSProperties, JSX} from 'react';
import clsx from 'clsx';
import styles from './PixelIcon.module.css';

export type PixelIconName = 'analytics' | 'blocks' | 'check' | 'chevron-right' | 'directions' | 'laptop' | 'lock' | 'message' | 'plug'
  | 'server' | 'sliders-horizontal' | 'user';

const DEFAULT_SIZE = 24;   // each of the icon's pixels a whole 2px

type Props = {name: PixelIconName; size?: number; className?: string};

/** A pixel icon (assets/home/icons/pixel) drawn through its mask in `currentColor`. Decorative. */
export function PixelIcon({name, size = DEFAULT_SIZE, className}: Props): JSX.Element {
  const style = {
    '--icon': `url(/site/assets/home/icons/pixel/${name}.svg)`,
    ...(size !== DEFAULT_SIZE && {'--icon-size': `${size}px`}),
  } as CSSProperties;
  return <i className={clsx(styles.icon, className)} style={style} aria-hidden="true" />;
}
