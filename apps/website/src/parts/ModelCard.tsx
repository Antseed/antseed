import type {CSSProperties, JSX, ReactNode} from 'react';
import clsx from 'clsx';
import type {LaneModel as Model, Medium} from '../lib/antscan';
import styles from './ModelCard.module.css';

const ICONS = '/site/assets/home/icons/';

const UNIT: Record<Medium, string> = {text: '/M', image: '/image', video: '/s', voice: '/M chars'};

/** Two decimals from ten cents up, two significant digits below (`$0.0031`). */
const formatUsd = (v: number) => `$${v >= 0.1 ? v.toFixed(2) : +v.toPrecision(2)}`;
const providersLabel = (n: number) => `provider${n === 1 ? '' : 's'}`;

type Props = {
  model: Model;
  medium: Medium;
  /** A repeat for the loop: hidden from assistive tech. */
  repeat?: boolean;
  /** Carried by an ant: the tile is drawn under `children` (the ant) so the ant can sit between its layers. */
  carried?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & {[data: `data-${string}`]: string | boolean | undefined};

/** A model's card: maker's mark and saving, then its name, price (when sellers publish one) and how many providers serve it. */
export function ModelCard({model, medium, repeat, carried, className, style, children, ...data}: Props): JSX.Element {
  const label = providersLabel(model.providers);
  return (
    <li className={clsx(styles.card, carried && styles.carried, className)} style={style} aria-hidden={repeat || undefined} {...data}>
      {children}
      <div className={styles.top}>
        <i className={clsx(styles.mark, model.logo.startsWith('labs-color/') && styles.inColour)} style={{'--mark': `url(${ICONS}${model.logo})`} as CSSProperties} />
        {model.save != null && <em className={styles.save}>−{model.save}%</em>}
      </div>
      <b className={styles.name}>{model.name}</b>
      <p className={styles.meta}>
        {model.price !== null && <code className={styles.price}>{formatUsd(model.price)}<span className={styles.unit}>{UNIT[medium]}</span></code>}
        <span className={styles.providers} title={`${model.providers} ${label}`}>
          <i className={styles.nodes} aria-hidden="true" />{model.providers}<span className={styles.srOnly}> {label}</span>
        </span>
      </p>
    </li>
  );
}
