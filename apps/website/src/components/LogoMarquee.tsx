import {useEffect, useRef, useState, type ReactNode} from 'react';
import styles from '../pages/index.module.css';
import {VENDOR_GLYPHS} from './PriceBoard';

/**
 * The ink band with two identical runs of `run` drifting left (CSS keyframes
 * in index.module.css). The animation is paused while the band is scrolled
 * out of view so it costs nothing off-screen; it resumes where it left off.
 */
export function MarqueeBand({ariaLabel, run}: {ariaLabel: string; run: ReactNode}) {
  const ref = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => setPaused(!entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const runStyle = paused ? {animationPlayState: 'paused' as const} : undefined;
  return (
    <section ref={ref} className={styles.marqueeBand} aria-label={ariaLabel}>
      <div className={styles.marquee}>
        <div className={styles.marqueeRun} style={runStyle}>{run}</div>
        <div className={styles.marqueeRun} style={runStyle} aria-hidden="true">{run}</div>
      </div>
    </section>
  );
}

/* ============================================================
   LOGO MARQUEE — model lockups drifting across the ink band
   ============================================================ */
/* Per-logo optical height — normalizes perceived size, not component
   defaults. Wide/flat wordmarks sit a touch shorter; compact icon+text
   marks sit a touch taller, so every lockup reads as roughly the same
   visual weight in the row. Rendered via @lobehub/icons' `.Combine`
   (icon + real wordmark) so every brand gets its official lockup. */
const MARQUEE_LOCKUPS: [string, number][] = [
  ['Anthropic', 16],
  ['OpenAI', 22],
  ['Google', 22],
  ['DeepSeek', 22],
  ['Meta', 22],
  ['Qwen', 22],
  ['Mistral', 20],
  ['Moonshot', 20],
  ['Zhipu', 20],
  ['Minimax', 20],
  ['Cohere', 20],
  ['NousResearch', 18],
];

function lockupContent(name: string, size: number): ReactNode {
  const Icon = VENDOR_GLYPHS[name];
  // Anthropic ships no `.Combine` in this package — `.Text` is its full
  // wordmark (same official mark). Google ships icon-only variants, and
  // Meta's `.Text` here actually draws "Llama" (the model brand), not
  // the Meta wordmark — both fall back to the real fetched SVGs.
  if (name === 'Google' || name === 'Meta') {
    const file = name === 'Google' ? 'google.svg' : 'meta.svg';
    return <img src={`/logos/lockups/${file}`} alt={name} loading="lazy" style={{height: size}} />;
  }
  if (name === 'NousResearch') {
    // The package's NousResearch wordmark reports a 35px box but paints
    // wider, colliding with the next lockup. Icon + a set wordmark instead.
    return (
      <span className={styles.marqueeLockup}>
        <Icon size={size} />
        <span className={styles.marqueeWordmark}>Nous Research</span>
      </span>
    );
  }
  if (Icon.Combine) {
    // Each brand ships its own text/icon ratio (0.45–0.85); normalize
    // to one consistent multiple so no wordmark reads smaller than the rest.
    return <Icon.Combine size={size} textMultiple={0.85} />;
  }
  return <Icon.Text size={size} />;
}

/* Static, so the run is built once at module load rather than per render. */
const MARQUEE_RUN = MARQUEE_LOCKUPS.map(([name, size]) => (
  <span className={styles.marqueeItem} key={name}>
    {lockupContent(name, size)}
  </span>
));

export function LogoMarquee() {
  return <MarqueeBand ariaLabel="Models available on the network" run={MARQUEE_RUN} />;
}
