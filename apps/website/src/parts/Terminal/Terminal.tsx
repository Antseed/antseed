import {useRef, type CSSProperties, type JSX} from 'react';
import clsx from 'clsx';
import {useInView} from '../../lib/useInView';
import {usePageVisible} from '../../lib/usePageVisible';
import {useStill} from '../../lib/useStill';
import {usePlayOnView} from '../../lib/usePlayOnView';
import styles from './Terminal.module.css';

export type TokenKind = 'prompt' | 'command' | 'sub' | 'flag' | 'value' | 'string' | 'plain';
export type Token = {text: string; kind?: TokenKind};
export type CodeLine = readonly Token[];
/** A comment line, then the lines of code under it. */
export type TerminalBlock = {comment: string; lines: readonly CodeLine[]};

type Props = {
  blocks: readonly TerminalBlock[];
  /** The connection label in the title bar, beside a green dot. */
  status: string;
  /** Right of the title bar. */
  tagline?: string;
  /** Type each line in, one after another, the first time the window is seen; otherwise the code is shown as it is. */
  typed?: boolean;
  label?: string;
  className?: string;
};

const MS_PER_CHAR = 18;
const LINE_PAUSE = 120;

type Line = {key: string; comment: boolean; gap: boolean; tokens: CodeLine; chars: number; delay: number};

/** Each line with its length and when it starts typing, one after the other. */
function lay(blocks: readonly TerminalBlock[]): {lines: Line[]; total: number} {
  const lines: Line[] = [];
  let at = 0;
  blocks.forEach((b, i) => {
    for (const [j, tokens] of [[{text: b.comment}], ...b.lines].entries()) {
      const chars = tokens.reduce((n, t) => n + t.text.length, 0);
      lines.push({key: `${i}-${j}`, comment: j === 0, gap: i > 0 && j === 0, tokens, chars, delay: at});
      at += chars * MS_PER_CHAR + LINE_PAUSE;
    }
  });
  return {lines, total: at};
}

/** A dark terminal window: a title bar, then commented code in the site's mono face. */
export function Terminal({blocks, status, tagline, typed = false, label, className}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const pending = usePlayOnView(ref);
  const inView = useInView(ref);
  const visible = usePageVisible();
  const still = useStill();
  const {lines, total} = lay(blocks);

  return (
    <div
      ref={ref}
      className={clsx(styles.window, typed && styles.typed, pending && styles.pending, inView && visible && !still && styles.live, className)}
      style={{'--done': `${total}ms`} as CSSProperties}>
      <div className={styles.bar}>
        <span className={styles.lights} aria-hidden="true"><i /><i /><i /></span>
        <span className={styles.status}><i className={styles.dot} aria-hidden="true" />{status}</span>
        {tagline && <span className={styles.tagline}>{tagline}</span>}
      </div>
      <pre className={styles.body} tabIndex={0} aria-label={label}>
        <code className={styles.code}>
          {lines.map((l) => (
            <span
              key={l.key}
              className={clsx(styles.line, l.comment && styles.comment, l.gap && styles.gap)}
              style={{'--n': l.chars, '--delay': `${l.delay}ms`} as CSSProperties}>
              {l.tokens.map((t, i) => <span key={i} className={t.kind && styles[t.kind]}>{t.text}</span>)}
            </span>
          ))}
          <span className={styles.cursor} aria-hidden="true" />
        </code>
      </pre>
    </div>
  );
}
