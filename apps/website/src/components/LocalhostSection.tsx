import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import styles from '../pages/index.module.css';
import {Button, Reveal} from './ui';

/**
 * "Point your tools at localhost." — the dark section with the self-typing
 * terminal and the request→network→provider→response flow. Shared between
 * the homepage and /agents; all copy (title, lead, points, terminal blocks,
 * CTA) is passed in so each page frames it for its own audience.
 */

export type PointItem = {icon: string; text: string};
export type TToken = {text: string; cls?: keyof typeof styles};
export type TBlock = {comment: string; tokens: TToken[]};

/** Random per-character delay — fast, with the odd human-like hesitation. */
function keystrokeDelay(ch: string) {
  if (ch === '\n') return 100;
  if (ch === ' ') return 10 + Math.random() * 10;
  const jitter = Math.random();
  if (jitter > 0.94) return 35 + Math.random() * 50; // rare pause
  return 5 + Math.random() * 10;
}

const commandText = (tokens: TToken[]) => tokens.map((t) => t.text).join('');

function Cursor({style}: {style?: CSSProperties}) {
  return <span className={styles.tCursor} style={style} aria-hidden="true" />;
}

/**
 * Renders every token in full so the block's box never resizes as it types —
 * characters not yet "typed" are kept in the layout via visibility:hidden.
 */
function renderTokens(tokens: TToken[], typed: number, cursor: ReactNode) {
  const nodes: ReactNode[] = [];
  let remaining = typed;
  let cursorPlaced = false;
  for (let i = 0; i < tokens.length; i++) {
    const {text, cls} = tokens[i];
    const visibleLen = Math.max(0, Math.min(text.length, remaining));
    const visible = text.slice(0, visibleLen);
    const hidden = text.slice(visibleLen);
    const placeCursorHere = !cursorPlaced && visibleLen < text.length;
    if (placeCursorHere) cursorPlaced = true;
    nodes.push(
      <span key={i} className={cls ? styles[cls] : undefined}>
        {visible}
        {placeCursorHere && cursor}
        {hidden && <span style={{visibility: 'hidden'}}>{hidden}</span>}
      </span>
    );
    remaining -= text.length;
  }
  if (!cursorPlaced) nodes.push(<span key="cursor">{cursor}</span>);
  return nodes;
}

function TerminalCard({blocks}: {blocks: TBlock[]}) {
  const ref = useRef<HTMLDivElement>(null);
  const [blockIndex, setBlockIndex] = useState(0);
  const [phase, setPhase] = useState<'comment' | 'command' | 'done'>('comment');
  const [typed, setTyped] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setBlockIndex(blocks.length - 1);
      setPhase('done');
      setTyped(commandText(blocks[blocks.length - 1].tokens).length);
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function sleep(ms: number) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    }

    async function typeOut(text: string) {
      for (let i = 1; i <= text.length; i++) {
        if (cancelled) return;
        await sleep(keystrokeDelay(text[i - 1]));
        if (cancelled) return;
        setTyped(i);
      }
    }

    async function run() {
      for (let b = 0; b < blocks.length; b++) {
        if (cancelled) return;
        setBlockIndex(b);
        setPhase('comment');
        setTyped(0);
        const {comment, tokens} = blocks[b];
        await typeOut(comment);
        if (cancelled) return;
        await sleep(60);
        setPhase('command');
        setTyped(0);
        await typeOut(commandText(tokens));
        if (cancelled) return;
        await sleep(150);
      }
      if (!cancelled) setPhase('done');
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          run();
        }
      },
      {threshold: 0.35}
    );
    observer.observe(el);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [blocks]);

  return (
    <div className={styles.terminal} ref={ref}>
      <div className={styles.terminalBar}>
        <span className={styles.tDots}>
          <i style={{background: '#EF4444'}} />
          <i style={{background: '#F59E0B'}} />
          <i style={{background: '#676663'}} />
        </span>
        <span className={styles.terminalStatus}>
          <span className={styles.statusDot} aria-hidden="true" />
          Connected Localhost:8377
        </span>
        <span className={styles.terminalTagline}>ONE ENDPOINT · EVERY TOOL</span>
      </div>
      {blocks.map((block, i) => {
        const isCurrent = i === blockIndex && phase !== 'done';
        const showCommentCursor = isCurrent && phase === 'comment';
        const showCommandCursor = isCurrent && phase === 'command';
        const commentDone = i < blockIndex || phase === 'done' || showCommandCursor;
        const commandDone = i < blockIndex || phase === 'done';
        let commentTyped = 0;
        if (commentDone) commentTyped = block.comment.length;
        else if (showCommentCursor) commentTyped = typed;
        let commandTyped = 0;
        if (commandDone) commandTyped = commandText(block.tokens).length;
        else if (showCommandCursor) commandTyped = typed;
        const commentHidden = block.comment.slice(commentTyped);
        return (
          <div className={styles.terminalBlock} key={i}>
            <span className={styles.tComment}>
              {block.comment.slice(0, commentTyped)}
              {showCommentCursor && <Cursor />}
              {commentHidden && <span style={{visibility: 'hidden'}}>{commentHidden}</span>}
            </span>
            <span>
              {renderTokens(block.tokens, commandTyped, showCommandCursor ? <Cursor /> : null)}
            </span>
          </div>
        );
      })}
      <Cursor
        style={{visibility: phase === 'done' && blockIndex === blocks.length - 1 ? 'visible' : 'hidden'}}
      />
    </div>
  );
}

const FLOW_CHIPS = [
  {icon: 'flow-flash', label: 'REQUEST'},
  {icon: 'flow-internet', label: 'ANTSEED NETWORK'},
  {icon: 'flow-user', label: 'BEST PROVIDER'},
  {icon: 'flow-check', label: 'RESPONSE'},
];

function FlowChips() {
  return (
    <div className={styles.flowRow}>
      <span className={styles.flowLine} aria-hidden="true" />
      {FLOW_CHIPS.map((chip) => (
        <span key={chip.label} className={styles.flowChip}>
          <img src={`/img/home/${chip.icon}.svg`} alt="" width="20" height="20" />
          {chip.label}
        </span>
      ))}
    </div>
  );
}

export function LocalhostSection({
  id,
  title,
  lead,
  points,
  blocks,
  ctaLabel,
  ctaTo,
}: {
  /** Anchor id so in-page links (hero "use it from the CLI") can jump here. */
  id?: string;
  title: ReactNode;
  lead: ReactNode;
  points: PointItem[];
  blocks: TBlock[];
  ctaLabel: string;
  ctaTo: string;
}) {
  return (
    <section className={styles.darkSection} id={id}>
      <img className={styles.darkAnt} src="/img/home/antdots-green.png" alt="" aria-hidden="true" />
      <div className={styles.sectionInner}>
        <div className={styles.localhostGrid}>
          <Reveal className={styles.localhostCopy}>
            <h2 className={styles.darkTitle}>{title}</h2>
            <p className={styles.darkLead}>{lead}</p>
            <ul className={styles.pointList}>
              {points.map((p) => (
                <li key={p.icon}>
                  <span className={styles.pointIcon}>
                    <img src={`/img/home/${p.icon}.svg`} alt="" width="24" height="24" />
                  </span>
                  {p.text}
                </li>
              ))}
            </ul>
            <Button to={ctaTo} variant="light" arrow>{ctaLabel}</Button>
          </Reveal>
          <Reveal delay={140}>
            <TerminalCard blocks={blocks} />
            <FlowChips />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
