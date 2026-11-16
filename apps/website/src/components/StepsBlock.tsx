import type {ReactNode} from 'react';
import styles from '../pages/index.module.css';
import {Reveal} from './ui';

/**
 * "You're 3 steps from…" — numbered illustrated cards over the dotted ant,
 * shared by the homepage and /agents. Copy and the CTA are passed in.
 */

export type Step = {num: string; title: string; body: string; illo: ReactNode};

export function StepsBlock({
  title,
  lead,
  steps,
  cta,
}: {
  title: ReactNode;
  lead: ReactNode;
  steps: Step[];
  cta?: ReactNode;
}) {
  return (
    <section className={styles.stepsSection}>
      <img className={styles.stepsAnt} src="/img/home/ant-v-dots.png" alt="" aria-hidden="true" />
      <div className={styles.sectionInner}>
        <Reveal>
          <h2 className={styles.stepsTitle}>{title}</h2>
          <p className={styles.stepsLead}>{lead}</p>
        </Reveal>
        <div className={`${styles.cardGrid3} ${styles.stepsGrid}`}>
          {steps.map((step, i) => (
            <Reveal key={step.num} className={`${styles.runsCard} ${styles.stepCard}`} delay={i * 100}>
              <div className={styles.runsIlloWell}>{step.illo}</div>
              <div className={styles.featureCopy}>
                <div className={styles.stepHead}>
                  <span className={styles.stepNum}>{step.num}</span>
                  <h3>{step.title}</h3>
                </div>
                <p>{step.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
        {cta && (
          <Reveal className={styles.stepsCta} delay={140}>
            {cta}
          </Reveal>
        )}
      </div>
    </section>
  );
}
