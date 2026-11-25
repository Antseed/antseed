import {useRef, type JSX} from 'react';
import {useInView} from '../../lib/useInView';
import {usePageVisible} from '../../lib/usePageVisible';
import {useAntsToken, useEpoch} from '../../lib/antscan';
import {Tally} from '../../components';
import styles from './TokenFigures.module.css';

const millions = (v: number) => `${(v / 1e6).toFixed(1)}M`;

/** Supply, burned and the epoch, from Antscan's emission figures; the countdown ticks while the figures are on screen. */
export function TokenFigures(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useInView(ref);
  const visible = usePageVisible();
  const ants = useAntsToken();
  const clock = useEpoch(onScreen && visible);
  const figures = [
    {id: 'supply', value: millions(ants.supply), caption: 'in supply, of the 1.04B hard cap'},
    {id: 'burned', value: millions(ants.burned), caption: 'ANTS burned so far'},
    {id: 'epoch', value: `Epoch ${clock.epoch}`, caption: clock.countdown ?? 'Epochs run weekly'},
  ];
  return (
    <div ref={ref} className={styles.figures} role="group" aria-label="$ANTS, live">
      {figures.map((f) => (
        <div key={f.id} className={styles.figure}>
          <Tally className={styles.value} value={f.value} />
          <p className={styles.caption}>{f.caption}</p>
        </div>
      ))}
    </div>
  );
}
