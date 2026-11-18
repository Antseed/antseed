import type {CSSProperties, JSX} from 'react';
import clsx from 'clsx';
import styles from './Painting.module.css';

/** Five painted clouds drifting across the sky, each at its own pace. Values are shares of the 16:9 stage, so they stay on the painted
 *  sky at any size; the negative delays start each one mid-way, where the poster has it. */
type Cloud = {id: string; left: number; top: number; width: number; travel: number; duration: number; delay: number};

const CLOUDS: Cloud[] = [
  {id: 'e2', left: -18.3333, top: 21.8519, width: 17.0833, travel: 700, duration: 98.33, delay: -95.422},
  {id: 'e1', left: -14.2188, top: 2.037, width: 12.9688, travel: 890.361, duration: 91.67, delay: -77.857},
  {id: 'c3', left: -16.5104, top: 30.3704, width: 15.2604, travel: 771.672, duration: 100, delay: -55.55},
  {id: 'c2', left: -19.7917, top: 9.6296, width: 18.5417, travel: 652.809, duration: 96.67, delay: -60.687},
  {id: 'c1', left: -39.2708, top: 11.8519, width: 38.0208, travel: 369.589, duration: 93.33, delay: -32.657},
];

const vars = (c: Cloud) => ({
  '--cloud-left': `${c.left}%`, '--cloud-top': `${c.top}%`, '--cloud-width': `${c.width}%`,
  '--cloud-travel': `${c.travel}%`, '--cloud-duration': `${c.duration}s`, '--cloud-delay': `${c.delay}s`,
}) as CSSProperties;

export function Clouds({paused}: {paused: boolean}): JSX.Element {
  return (
    <div className={clsx(styles.clouds, paused && styles.paused)} aria-hidden="true">
      {CLOUDS.map((c) => <img key={c.id} className={styles.cloud} style={vars(c)} src={`/site/assets/hero/clouds/cloud-${c.id}.webp`} alt="" decoding="async" fetchPriority="low" />)}
    </div>
  );
}
