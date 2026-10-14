import type {CSSProperties} from 'react';
import styles from '../pages/index.module.css';

/**
 * The dotted line dripping out of the section above — a static dashed line
 * (Figma asset) with each dot along it lighting up in sequence, top to
 * bottom. Place it inside a `position: relative` section; it sits 24px in,
 * centred. Decorative only.
 */

const DROP_TRAIL_DOT_COUNT = 11;
const DROP_TRAIL_CYCLE = 1.6;

/* One dot every 8px from y=3. The line asset fades in top-to-bottom
   (transparent at y=3, solid at y=91), so each dot's peak brightness
   follows that same ramp. */
const DROP_TRAIL_DOT_STYLES: CSSProperties[] = Array.from({length: DROP_TRAIL_DOT_COUNT}, (_, i) => {
  const top = 3 + i * 8;
  return {
    top,
    animationDelay: `${i * (DROP_TRAIL_CYCLE / DROP_TRAIL_DOT_COUNT)}s`,
    ['--dot-peak' as string]: 0.25 + 0.75 * ((top - 3) / 88),
  };
});

export function DropTrail() {
  return (
    <div className={styles.dropTrail} aria-hidden="true">
      <img src="/img/home/dots-down.svg" alt="" width={6} height={94} className={styles.dropTrailLine} />
      {DROP_TRAIL_DOT_STYLES.map((style, i) => (
        <span key={i} className={styles.dropTrailDot} style={style} />
      ))}
    </div>
  );
}
