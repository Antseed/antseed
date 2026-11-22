import type {CSSProperties, JSX} from 'react';
import {Cursor} from '@lobehub/icons';
import styles from './ToolMark.module.css';

export type ToolName = 'Claude Code' | 'Codex' | 'Cursor' | 'Hermes' | 'OpenClaw' | 'OpenCode' | 'Pi';

/** Logos drawn in their own colours, and marks drawn in the text colour through a mask. */
const COLOUR: Partial<Record<ToolName, string>> = {
  'Claude Code': '/site/assets/home/icons/labs-color/anthropic.svg',
  OpenClaw: '/logos/openclaw.svg',
};
const MONO: Partial<Record<ToolName, string>> = {
  Codex: '/site/assets/home/icons/labs/openai.svg',
  Hermes: '/logos/nousresearch.svg',
};

function SquareGlyph(): JSX.Element {
  return <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M13 7H7v6h6V7zm3 9H4V4h12v12z" /></svg>;
}

function PiGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3.5 6h13" /><path d="M6.5 6v9" /><path d="M13.5 6v6.5c0 1.5.8 2.5 2 2.5" />
    </svg>
  );
}

/** A logo file drawn in the text colour through its mask, 22px, decorative. */
export function MonoMark({src}: {src: string}): JSX.Element {
  return <i className={styles.mono} style={{'--mark': `url(${src})`} as CSSProperties} />;
}

/** A coding tool's or agent's logo, 22px, decorative. */
export function ToolMark({name}: {name: ToolName}): JSX.Element {
  const colour = COLOUR[name];
  const mono = MONO[name];
  if (colour) return <img className={styles.mark} src={colour} alt="" width={22} height={22} loading="lazy" decoding="async" />;
  if (mono) return <MonoMark src={mono} />;
  if (name === 'Cursor') return <Cursor size={22} />;
  return name === 'Pi' ? <PiGlyph /> : <SquareGlyph />;
}
