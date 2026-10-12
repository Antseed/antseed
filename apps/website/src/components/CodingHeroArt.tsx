import {useEffect, useState} from 'react';
import styles from './CodingHeroArt.module.css';

/**
 * /coding hero animation — the "coding tools" design-system card, brought
 * to life. The plan-based AI app burns through its allowance until it hits
 * LIMIT and a reset countdown appears; underneath, the Antseed row keeps
 * streaming while a token counter and running cost line tick upward with
 * the list price struck through. prefers-reduced-motion shows the end state.
 */

const FILL_MS = 5200; // how long the plan bar takes to hit the limit
const RESET_START = 4 * 3600 + 59 * 60 + 59; // "resets in 4:59:59"
const START = {tokens: 9840, antseed: 0.31, list: 1.42};
const PER_TOKEN = {antseed: 0.0000045, list: 0.000021};

const money = (n: number) => `$${n.toFixed(2)}`;
const hms = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

function LockGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="2" />
      <path d="M5.5 7V5.5a2.5 2.5 0 015 0V7" />
    </svg>
  );
}

export function CodingHeroArt() {
  const [reduced, setReduced] = useState(false);
  const [capped, setCapped] = useState(false);
  const [tokens, setTokens] = useState(START.tokens);
  const [cost, setCost] = useState(START.antseed);
  const [list, setList] = useState(START.list);
  const [reset, setReset] = useState(RESET_START);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) {
      setReduced(true);
      setCapped(true);
      return undefined;
    }
    const cap = window.setTimeout(() => setCapped(true), FILL_MS);
    const tick = window.setInterval(() => {
      const n = 40 + Math.floor(Math.random() * 90);
      setTokens((t) => t + n);
      setCost((c) => c + n * PER_TOKEN.antseed);
      setList((l) => l + n * PER_TOKEN.list);
    }, 160);
    const countdown = window.setInterval(() => setReset((r) => (r > 0 ? r - 1 : r)), 1000);
    return () => {
      window.clearTimeout(cap);
      window.clearInterval(tick);
      window.clearInterval(countdown);
    };
  }, []);

  const saving = Math.max(0, Math.round((1 - cost / list) * 100));

  return (
    <div className={`${styles.well} ${reduced ? styles.reduced : ''} ${capped ? styles.capped : ''}`}>
      <div className={styles.panel} role="img" aria-label="A plan-based AI app hits its usage limit while Antseed keeps going">
        {/* the plan-based app */}
        <div className={`${styles.row} ${styles.plan}`}>
          <span className={styles.chip}><i /></span>
          <span className={styles.name}>AI app</span>
          <span className={styles.bar}><span className={styles.fill} /></span>
          <span className={styles.status}>
            <span className={styles.statusUsing}>PLAN</span>
            <span className={styles.statusLimit}>LIMIT</span>
          </span>
        </div>
        <div className={styles.resetLine}>
          <LockGlyph />
          <span>Resets in <b>{hms(reset)}</b></span>
        </div>

        {/* antseed keeps going */}
        <div className={`${styles.row} ${styles.live}`}>
          <span className={`${styles.chip} ${styles.chipAnt}`}><img src="/logo.svg" alt="" /></span>
          <span className={styles.name}>Antseed</span>
          <span className={styles.stream} aria-hidden="true">
            <i /><i /><i /><i /><i /><i /><i /><i />
          </span>
          <span className={`${styles.status} ${styles.keep}`}>KEEP GOING</span>
        </div>

        <div className={styles.readouts}>
          <span className={styles.pill}><b>{tokens.toLocaleString('en-US')}</b> tokens</span>
          <span className={`${styles.pill} ${styles.pillCost}`}>
            <b>{money(cost)}</b>
            <s>{money(list)}</s>
          </span>
          <span className={`${styles.pill} ${styles.pillSave}`}>Saving {saving}%</span>
        </div>
      </div>
    </div>
  );
}
