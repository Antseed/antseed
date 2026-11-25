import type {JSX, ReactNode, Ref} from 'react';
import clsx from 'clsx';
import {Point, PointsRow} from '../PointsRow';
import type {NetworkStep} from './steps';
import styles from './StepPoints.module.css';

type Props = {
  steps: readonly NetworkStep[];
  step: number;
  /** The cycle has started: the steps not on show step back. */
  ready: boolean;
  onSelect(k: number): void;
  barRefs: readonly Ref<HTMLSpanElement>[];
  /** A last cell after the steps (a link onwards). */
  extra?: ReactNode;
  className?: string;
  pointClassName?: string;
};

/** The board's controls: one point per step, the one on show marked, each with a progress bar along its top edge. On a phone the
    board has its own control (PhoneSteps), so only the extra cell stays. */
export function StepPoints({steps, step, ready, onSelect, barRefs, extra, className, pointClassName}: Props): JSX.Element {
  return (
    <PointsRow className={clsx(styles.steps, ready && styles.ready, className)}>
      {steps.map((s, i) => (
        <Point key={s.name} className={clsx(styles.step, pointClassName)}>
          <span ref={barRefs[i]} className={styles.bar} aria-hidden="true" />
          <button type="button" className={styles.button} aria-current={i === step ? 'step' : undefined} onClick={() => onSelect(i)}>
            <b>{s.name}</b> {s.point}
          </button>
        </Point>
      ))}
      {extra && <Point className={clsx(styles.extra, pointClassName)}>{extra}</Point>}
    </PointsRow>
  );
}
