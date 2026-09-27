import type {ReactNode} from 'react';
import styles from '../pages/index.module.css';
import own from './AgentsLogoBar.module.css';
import {MarqueeBand} from './LogoMarquee';

/**
 * Ink logo band for /agents — the same marquee as the homepage, but the
 * run is the agents Antseed supports (one entry per integration page)
 * instead of model vendors. Logos render white at 60% like the homepage.
 */

export const SquareGlyph = (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d="M13 7H7v6h6V7zm3 9H4V4h12v12z" />
  </svg>
);

export const PiGlyph = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M3.5 6h13" />
    <path d="M6.5 6v9" />
    <path d="M13.5 6v6.5c0 1.5.8 2.5 2 2.5" />
  </svg>
);

export type LogoItem = {name: string; logo?: string; glyph?: ReactNode};

const AGENTS: LogoItem[] = [
  {name: 'Hermes', logo: '/logos/nousresearch.svg'},
  {name: 'OpenClaw', logo: '/logos/openclaw.svg'},
  {name: 'Codex', logo: '/logos/openai.png'},
  {name: 'OpenCode', glyph: SquareGlyph},
  {name: 'Claude Code', logo: '/logos/anthropic.png'},
  {name: 'Pi', glyph: PiGlyph},
];

export function AgentsLogoBar() {
  return <LogoBar items={AGENTS} ariaLabel="Agents that work with Antseed" />;
}

export function LogoBar({items, ariaLabel}: {items: LogoItem[]; ariaLabel: string}) {
  // two passes per run so the band never shows a gap at narrow widths
  const run = [...items, ...items].map((a, i) => (
    <span className={`${styles.marqueeItem} ${own.item}`} key={`${a.name}-${i}`}>
      <span className={own.mark}>
        {a.logo ? <img src={a.logo} alt="" loading="lazy" /> : a.glyph}
      </span>
      <span className={own.name}>{a.name}</span>
    </span>
  ));
  return <MarqueeBand ariaLabel={ariaLabel} run={run} />;
}
