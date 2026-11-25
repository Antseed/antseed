import {useId, useState, type CSSProperties, type JSX} from 'react';
import {ELSH_STOPS} from './typefaces';
import styles from './PixelAxis.module.css';

const ELSH_MIN = 1;
const ELSH_MAX = 100;
const ELSH_START = 40;

/** Geist Pixel's ELSH axis: a word redrawn as the slider moves, and the three settings the site uses. */
export function PixelAxis(): JSX.Element {
  const [elsh, setElsh] = useState<number>(ELSH_START);
  const id = useId();
  return (
    <div className={styles.axis}>
      <p className={styles.word} style={{'--elsh': elsh} as CSSProperties} aria-hidden="true">Antseed</p>
      <div className={styles.control}>
        <label htmlFor={id} className={styles.label}>ELSH <output htmlFor={id}>{elsh}</output></label>
        <input
          id={id}
          className={styles.range}
          type="range"
          min={ELSH_MIN}
          max={ELSH_MAX}
          value={elsh}
          onChange={(e) => setElsh(Number(e.target.value))}
        />
      </div>
      <ul className={styles.stops}>
        {ELSH_STOPS.map((s) => (
          <li key={s.value}>
            <button type="button" className={styles.stop} aria-pressed={elsh === s.value} onClick={() => setElsh(s.value)}>
              <b>{s.value}</b> {s.use}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
