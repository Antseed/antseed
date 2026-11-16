import {useEffect, useState} from 'react';
import styles from './PrivacyHeroArt.module.css';

/**
 * /privacy hero animation — the "anonymity" design-system card, animated.
 * A request travels from you through the no-account node to the provider.
 * Loops; reduced-motion shows the end state.
 */

type Phase = 'leave' | 'strip' | 'deliver' | 'hold';
const TIMINGS: Record<Phase, number> = {leave: 1400, strip: 900, deliver: 1400, hold: 2200};
const NEXT: Record<Phase, Phase> = {leave: 'strip', strip: 'deliver', deliver: 'hold', hold: 'leave'};

export function PrivacyHeroArt() {
  const [phase, setPhase] = useState<Phase>('leave');
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) {
      setReduced(true);
      setPhase('hold');
      return undefined;
    }
    const t = window.setTimeout(() => setPhase((p) => NEXT[p]), TIMINGS[phase]);
    return () => window.clearTimeout(t);
  }, [phase]);

  const cls = [styles.well, styles[phase], reduced ? styles.reduced : ''].join(' ');

  return (
    <div className={cls}>
      <div
        className={styles.panel}
        role="img"
        aria-label="A request travels from you, through the no-account node, to the provider">
        <div className={styles.scene}>
          {/* you */}
          <div className={styles.node}>
            <span className={`${styles.circle} ${styles.you}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="9" r="4" />
                <path d="M4 20c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
              </svg>
            </span>
            <span className={styles.label}>you</span>
          </div>

          {/* leg 1: solid line */}
          <div className={styles.leg}>
            <span className={styles.line} />
            <span className={`${styles.packet} ${styles.packetA}`}>
              <i />
            </span>
          </div>

          {/* no-account node */}
          <div className={styles.node}>
            <span className={`${styles.circle} ${styles.anon}`}>
              <span className={styles.halo} />
              <img src="/img/demo/anonymous-node.svg" alt="" />
            </span>
            <span className={`${styles.label} ${styles.labelGreen}`}>no account</span>
          </div>

          {/* leg 2: dotted line */}
          <div className={styles.leg}>
            <span className={styles.dots}><i /><i /><i /><i /><i /></span>
            <span className={`${styles.packet} ${styles.packetB}`}>
              <i />
            </span>
          </div>

          {/* provider */}
          <div className={styles.node}>
            <span className={`${styles.circle} ${styles.provider}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <rect x="5" y="6" width="14" height="5" rx="1.5" />
                <rect x="5" y="13" width="14" height="5" rx="1.5" />
                <circle cx="8.5" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
                <circle cx="8.5" cy="15.5" r="0.9" fill="currentColor" stroke="none" />
              </svg>
              <span className={styles.lock} aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="7" rx="2" /><path d="M5.5 7V5.5a2.5 2.5 0 015 0V7" /></svg>
              </span>
            </span>
            <span className={styles.label}>provider</span>
          </div>
        </div>

        {/* what the provider sees */}
        <div className={styles.sees}>
          <span className={styles.seesKey}>provider sees</span>
          <span className={styles.seesVal}>
            peer 7f3a… · wallet · <em>prompt sealed (TEE)</em>
          </span>
        </div>
      </div>
    </div>
  );
}
