import type { ReactNode } from 'react';

export type PillTone = 'neutral' | 'accent' | 'danger' | 'amber' | 'muted';

interface Props {
  tone?: PillTone;
  mono?: boolean;
  title?: string;
  children: ReactNode;
}

/** Rounded tinted status badge (accent = positive, amber = pending/warning, danger = failed/slashing, muted = inactive). */
export function Pill({ tone = 'neutral', mono, title, children }: Props) {
  const classes = ['pill', tone !== 'neutral' ? `pill--${tone}` : '', mono ? 'pill--mono' : ''].filter(Boolean).join(' ');
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}
