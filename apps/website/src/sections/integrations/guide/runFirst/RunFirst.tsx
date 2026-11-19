import type {JSX} from 'react';
import {Glossary} from './Glossary';
import {SetupSteps} from './SetupSteps';
import styles from './RunFirst.module.css';

/** The shared setup before any guide, folded away until asked for (its text stays in the page for search and agents). */
export function RunFirst(): JSX.Element {
  return (
    <details id="run-first" className={styles.card}>
      <summary className={styles.summary}>
        <span className={styles.head}>
          <span className={styles.kicker}><i className={styles.dot} aria-hidden="true" />Run Antseed first</span>
          <span className={styles.lede}>
            Every integration needs an Antseed endpoint: a gateway, best on a small server so every tool on every machine can reach
            it, or the local buyer proxy (same computer only). One-time setup, a few minutes.
          </span>
        </span>
        <span className={styles.toggle} aria-hidden="true">
          <span className={styles.show}>Show steps ↓</span>
          <span className={styles.hide}>I’ve done this ↑</span>
        </span>
      </summary>
      <div className={styles.content}>
        <Glossary />
        <SetupSteps />
      </div>
    </details>
  );
}
