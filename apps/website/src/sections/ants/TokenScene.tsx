import {useRef, type CSSProperties, type JSX} from 'react';
import clsx from 'clsx';
import {useInView} from '../../lib/useInView';
import {usePageVisible} from '../../lib/usePageVisible';
import {useStill} from '../../lib/useStill';
import styles from './TokenScene.module.css';

const ART = '/site/assets/home';

type Pupil = {src: string; left: string; top: string; width: string};
const PUPILS: readonly Pupil[] = [
  {src: `${ART}/ants-token-pupil-l.webp`, left: '45.04%', top: '28.35%', width: '10.66%'},
  {src: `${ART}/ants-token-pupil-r.webp`, left: '72.24%', top: '26.79%', width: '9.38%'},
];

/** Over the field painting: the $ANTS coin floating, an ant looking up at it in awe, its pupils trembling. Moves only while on screen. */
export function TokenScene(): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const onScreen = useInView(ref);
  const visible = usePageVisible();
  const still = useStill();
  return (
    <span ref={ref} className={clsx(styles.scene, onScreen && visible && !still && styles.moving)}>
      <span className={styles.ant}>
        <img src={`${ART}/ants-token-ant.webp`} width={544} height={769} alt="" decoding="async" />
        {PUPILS.map((p) => (
          <img key={p.src} className={styles.pupil} src={p.src} style={{left: p.left, top: p.top, width: p.width} as CSSProperties} alt="" decoding="async" />
        ))}
      </span>
      <img className={styles.coin} src={`${ART}/ants-coin-cut.webp`} width={557} height={603} alt="A green $ANTS coin, tilted, the Antseed ant raised in white on its face, in watercolour" decoding="async" />
    </span>
  );
}
