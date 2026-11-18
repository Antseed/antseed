import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {CheckIcon, Cursor, Logo, MiniButton, Stage, Window} from './Scene';
import {usePlayOnView} from '../../../lib/usePlayOnView';
import {useRequestLoop} from './useRequestLoop';
import styles from './RequestWindow.module.css';

const ICONS = '/site/assets/home/icons';
const LABEL = 'An incoming request for claude-haiku-5.5, 2,140 tokens from 0x5e…a2 offering $0.02 per million, with Accept, Decline and Counter at $0.03. The previous request, served, sits behind it';
const PLAYS = {tap: styles.tap, again: styles.again};

/** An incoming request with its terms, over the one served before it; it rises in when seen, then
 *  Accept is pressed every few seconds and the next one arrives. */
export function RequestWindow(): JSX.Element {
  const stage = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLDivElement>(null);
  const accept = useRef<HTMLSpanElement>(null);
  const pending = usePlayOnView(stage);
  useRequestLoop(stage, win, accept, PLAYS);
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
          <p className={styles.model}><img src={`${ICONS}/anthropic.svg`} alt="" width={14} height={14} loading="lazy" />claude-haiku-5.5<span className={styles.tokens}>· 2,140 tokens</span></p>
          <p className={styles.from}>from 0x5e…a2 · offers $0.02/M</p>
        </div>
        <p className={styles.actions}>
          <MiniButton ref={accept} className={styles.action}><CheckIcon /> Accept</MiniButton>
          <MiniButton ghost className={styles.action}>Decline</MiniButton>
          <MiniButton ghost className={styles.action}>Counter at $0.03</MiniButton>
        </p>
      </Window>
      <Cursor className={styles.cursor} />
    </Stage>
  );
}
