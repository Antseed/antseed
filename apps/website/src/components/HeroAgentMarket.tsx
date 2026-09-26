import {useEffect, useState, type ReactNode} from 'react';
import ag from './HeroAgentVisual.module.css';
import styles from './HeroAgentMarket.module.css';
import {useMarketplacePicks, type ModelPick, type ShowcaseRow} from '../lib/useMarketplacePrices';
import {VENDOR_GLYPHS} from './PriceBoard';

/**
 * Agent tab hero visual: coding agents routed to a curated set of models —
 * the top free models first, then the frontier models — with the lowest
 * live Antseed offer against the official price. Prices come from the same
 * marketplace feed as the pricing board further down the page.
 */

const ROWS = 7;

/* Fallbacks = last verified live offers (2026-09-25). */
const FREE_PICKS: ModelPick[] = [
  {id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', fallback: {bestUsd: 0, officialUsd: 0.045}},
  {id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', fallback: {bestUsd: 0, officialUsd: 0.047}},
];
const FRONTIER_PICKS: ModelPick[] = [
  {id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', fallback: {bestUsd: 0.16, officialUsd: 4}},
  {id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', fallback: {bestUsd: 0.11, officialUsd: 10}},
];
/* Shown after the fixed frontier picks, ordered by biggest saving. */
const RANKED_PICKS: ModelPick[] = [
  {id: 'openai/gpt-6-sol', name: 'GPT-6 Sol', fallback: {bestUsd: 0.04, officialUsd: 2}},
  {id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', fallback: {bestUsd: 0.0023, officialUsd: 0.1}},
  {id: 'anthropic/claude-fable-5.1', name: 'Claude Fable 5.1', fallback: {bestUsd: 0.4, officialUsd: 10}},
];

const ClaudeGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="#d97757" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" /></svg>
);
const CursorGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5z" /><path d="M4 7l8 4.5L20 7M12 11.5V21.5" /></svg>
);
const DroidGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><ellipse cx="12" cy="12" rx="9" ry="3.5" /><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(120 12 12)" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /></svg>
);
const SquareGlyph = (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M13 7H7v6h6V7zm3 9H4V4h12v12z" /></svg>
);
const PiGlyph = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3.5 6h13" /><path d="M6.5 6v9" /><path d="M13.5 6v6.5c0 1.5.8 2.5 2 2.5" /></svg>
);

/* One coding agent per row, no repeats (the desktop app's Agents list). */
const AGENTS: {name: string; logo?: string; glyph?: ReactNode}[] = [
  {name: 'OpenClaw', logo: '/logos/openclaw.svg'},
  {name: 'Hermes', logo: '/logos/nousresearch.svg'},
  {name: 'Claude', glyph: ClaudeGlyph},
  {name: 'Codex', logo: '/logos/openai.png'},
  {name: 'Cursor', glyph: CursorGlyph},
  {name: 'OpenCode', glyph: SquareGlyph},
  {name: 'Droid', glyph: DroidGlyph},
  {name: 'Pi', glyph: PiGlyph},
];

const isFree = (row: ShowcaseRow) => row.bestUsd === 0;

export function HeroAgentMarket({active}: {active: boolean}) {
  const free = useMarketplacePicks(FREE_PICKS);
  const frontier = useMarketplacePicks(FRONTIER_PICKS);
  const ranked = useMarketplacePicks(RANKED_PICKS);
  const rows = [
    ...free,
    ...frontier,
    ...[...ranked].sort((a, b) => parseInt(b.save, 10) - parseInt(a.save, 10)),
  ].slice(0, ROWS);
  const [on, setOn] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    setOn(0);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const timer = window.setInterval(() => setOn(i => (i + 1) % ROWS), 2400);
    return () => window.clearInterval(timer);
  }, [active]);
  const current = rows[on] ?? rows[0];
  const agent = AGENTS[on % AGENTS.length];
  return (
    <div className={`${ag.card} ${!active ? ag.paused : ''}`}>
      <div className={ag.top}><span><i /> Your agent sets itself up.</span><small className={styles.live}><i />LIVE PRICES</small></div>
      <div className={`${ag.scene} ${styles.scene}`}>
        {rows.map((row, i) => {
          const a = AGENTS[i % AGENTS.length];
          const Glyph = VENDOR_GLYPHS[row.vendorKey];
          const free = isFree(row);
          return (
            <div key={row.model} className={`${styles.row} ${on === i ? styles.on : ''}`}>
              <div className={styles.agent}>{a.logo ? <img src={a.logo} alt="" /> : a.glyph}<span>{a.name}</span></div>
              <div className={styles.arrow} aria-hidden="true" />
              <span className={styles.logo}>{Glyph ? <Glyph size={16} /> : null}</span>
              <span className={styles.name}>{row.model}</span>
              <span className={styles.price}>
                {free ? (
                  <span className={`${styles.pill} ${styles.free}`}>FREE</span>
                ) : (
                  <span className={styles.pill}>{row.best}<small>/M</small></span>
                )}
                <span className={styles.was}>{row.official}</span>
                {!free && <span className={styles.save}>{row.save} off</span>}
              </span>
            </div>
          );
        })}
      </div>
      <div className={ag.activity}><span className={ag.indicator} /><span key={on} className={ag.activityText}>{agent.name} → {current?.model} · {current && isFree(current) ? 'free' : `saving ${current?.save}`}</span><span className={ag.steps}>{rows.map((_, i) => <i key={i} className={on === i ? ag.current : ''} />)}</span></div>
    </div>
  );
}
