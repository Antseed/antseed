import type {JSX} from 'react';
import clsx from 'clsx';
import {Glass} from '../../parts/Glass/Glass';
import styles from './Trust.module.css';

const SIGNALS = ['History', 'Model audits', 'Backing', 'Identity'] as const;
type Signal = (typeof SIGNALS)[number];
type Scored = {name: string; verdict: string; above: boolean; signals: readonly Signal[]};

const PROVIDERS: readonly Scored[] = [
  {name: 'Provider A', verdict: 'Above your bar', above: true, signals: SIGNALS},
  {name: 'Provider B', verdict: 'Below your bar · skipped', above: false, signals: ['History', 'Identity']},
];

/** Your device scoring two providers from their public signals. */
export function ScoreWindow(): JSX.Element {
  return (
    <Glass
      pane
      className={styles.window}
      label="Your device scores each provider from public signals: Provider A shows all four, history, model audits, backing and identity, and is above your bar; Provider B shows two and is skipped, below your bar">
      <p className={styles.windowTitle}>Your device</p>
      {PROVIDERS.map((p) => (
        <div key={p.name} className={clsx(styles.provider, !p.above && styles.skipped)}>
          <p className={styles.providerHead}><b>{p.name}</b><span className={clsx(p.above && styles.above)}>{p.verdict}</span></p>
          <ul className={styles.signals}>
            {SIGNALS.map((s) => <li key={s} className={clsx(p.signals.includes(s) && styles.on)}>{s}</li>)}
          </ul>
        </div>
      ))}
    </Glass>
  );
}
