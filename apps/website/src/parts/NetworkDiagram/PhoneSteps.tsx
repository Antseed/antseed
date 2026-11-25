import type {JSX, Ref} from 'react';
import type {NetworkStep} from './steps';
import styles from './PhoneSteps.module.css';

type Props = {
  steps: readonly NetworkStep[];
  step: number;
  onSelect(k: number): void;
  /** Each step's progress bar: its fill is the CSS variable --progress (0..1). */
  barRefs: readonly Ref<HTMLElement>[];
};

/** On a phone, in place of the window and the row of points: a three-part control under the drawing, then the step's line. */
export function PhoneSteps({steps, step, onSelect, barRefs}: Props): JSX.Element {
  const current = steps[step];
  return (
    <>
      <div className={styles.segments}>
        {steps.map((s, i) => (
          <button key={s.name} type="button" className={styles.segment} aria-current={i === step ? 'step' : undefined} onClick={() => onSelect(i)}>
            {s.name}
            <i ref={barRefs[i]} className={styles.bar} aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className={styles.line}><b>{current.name}</b> {current.point}</p>
    </>
  );
}
