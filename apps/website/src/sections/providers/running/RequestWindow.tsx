import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {CheckIcon, Logo, Stage, Window} from './Scene';
import {usePlayOnView} from '../../../lib/usePlayOnView';
import {useRequestLoop} from './useRequestLoop';
import styles from './RequestWindow.module.css';

const ICONS = '/site/assets/home/icons';
const LABEL = 'An incoming request for deepseek-v4.1-flash, 2,140 tokens from 0x5e…a2 at your price of $0.02 per million, served automatically and earning $0.000043; every few seconds the next request arrives. The previous request, served, sits behind it';
const PLAYS = {serve: styles.serve, again: styles.again};

/** An incoming request at the provider's price, over the one served before it; it rises in when seen, then every few seconds it is
 *  served and the next one arrives. */
export function RequestWindow(): JSX.Element {
  const stage = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const pending = usePlayOnView(stage);
  useRequestLoop(stage, win, status, PLAYS);
  return (
    <Stage ref={stage} label={LABEL}>
      <Window className={styles.previous}>
        <p className={styles.line}><b>Incoming request</b><span className={styles.served}>Served</span></p>
        <p className={styles.previousModel}>deepseek-v4.1-flash · 860 tokens</p>
      </Window>
      <Window ref={win} className={clsx(styles.current, pending && styles.pending)}>
        <p className={clsx(styles.line, styles.head)}>
          <span className={styles.title}><span className={styles.tile}><Logo src={`${ICONS}/plug.svg`} className={styles.plug} /></span><b>Incoming request</b></span>
          <span className={styles.when}>now</span>
        </p>
        <div className={styles.request}>
          <p className={styles.model}><img src={`${ICONS}/deepseek.svg`} alt="" width={14} height={14} loading="lazy" />deepseek-v4.1-flash<span className={styles.tokens}>· 2,140 tokens</span></p>
          <p className={styles.from}>from 0x5e…a2 · at your $0.02/M</p>
        </div>
        <p ref={status} className={styles.status}>
          <span className={styles.serving}>Serving…</span>
          <span className={styles.done}><CheckIcon className={styles.check} /> Served · earned $0.000043</span>
        </p>
      </Window>
    </Stage>
  );
}
