import {memo, useRef, type JSX, type ReactNode, type Ref, type RefObject} from 'react';
import clsx from 'clsx';
import {StepWindow} from './StepWindow';
import {PaintedLayers} from './PaintedLayers';
import {useInView} from '../../lib/useInView';
import type {NetworkStep} from './steps';
import type {WindowState} from './useStepCycle';
import styles from './NetworkBoard.module.css';

const STAGE_LABEL = 'The network in three layers. Discovery: providers announce to the Mainline DHT, you look them up and pick one, then talk to it directly. Payments: you deposit USDC on Base, reserve for a provider, sign a running total offchain, and the provider settles. Trust: ANTS holders stake on providers, settled usage is recognized, and your machine computes each provider\'s score.';

// the drawing never re-renders: the animation works on its DOM
const Drawing = memo(function Drawing({step, svgRef}: {step: NetworkStep; svgRef: Ref<SVGSVGElement>}) {
  return <step.Drawing ref={svgRef} className={styles.drawing} aria-hidden="true" />;
});

type Props = {
  steps: readonly NetworkStep[];
  step: number;
  leaving: number | null;
  windows: readonly WindowState[];
  stageRef: RefObject<HTMLDivElement | null>;
  svgRefs: readonly Ref<SVGSVGElement>[];
  className?: string;
  /** Over the drawing (the phone's tags). */
  overlay?: ReactNode;
  /** Under the drawing and the windows (the phone's controls). */
  children?: ReactNode;
};

/** The light card: the step's drawing at the left (the three stacked, cross-fading), its data window at the right. */
export function NetworkBoard({steps, step, leaving, windows, stageRef, svgRefs, className, overlay, children}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const near = useInView(ref, {rootMargin: '1200px', once: true});   // the prints load as a Wash's painting does
  return (
    <div ref={ref} className={clsx(styles.board, className)}>
      <PaintedLayers load={near} />
      <div ref={stageRef} className={styles.stage} role="img" aria-label={STAGE_LABEL}>
        {steps.map((s, i) => (
          <div key={s.name} className={clsx(styles.layer, i === step ? styles.on : i === leaving && styles.leaving, !s.holders && styles.noHolders)}>
            <Drawing step={s} svgRef={svgRefs[i]} />
          </div>
        ))}
        {overlay}
      </div>
      <div className={styles.windows} aria-hidden="true">
        {steps.map((s, i) => <StepWindow key={s.name} step={s} active={i === step} beat={windows[i].beat} instant={windows[i].instant} />)}
      </div>
      {children}
    </div>
  );
}
