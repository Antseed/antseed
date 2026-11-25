import {useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject} from 'react';
import {NetworkBoard} from './NetworkBoard';
import {PhoneSteps} from './PhoneSteps';
import {PhoneTags} from './PhoneTags';
import {StepPoints} from './StepPoints';
import {NETWORK_STEPS} from './steps';
import {useLabelFit} from './useLabelFit';
import {useStepCycle} from './useStepCycle';

type Props = {
  boardClassName?: string;
  pointsClassName?: string;
  pointClassName?: string;
  /** A last cell after the step points. */
  extra?: ReactNode;
};

/** One element per step, kept in a ref list by stable callback refs. */
function useStepRefs<T>(): [RefObject<(T | null)[]>, ((el: T | null) => void)[]] {
  const list = useRef<(T | null)[]>([]);
  const refs = useMemo(() => NETWORK_STEPS.map((_, i) => (el: T | null) => { list.current[i] = el; }), []);
  return [list, refs];
}

/** The network in three layers (Discovery, Payments, Trust): the animated board and, under it, the points that choose a step. */
export default function NetworkDiagram({boardClassName, pointsClassName, pointClassName, extra}: Props): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const [svgs, svgRefs] = useStepRefs<SVGSVGElement>();
  const [pointBars, pointBarRefs] = useStepRefs<HTMLElement>();
  const [phoneBars, phoneBarRefs] = useStepRefs<HTMLElement>();
  const bars = useMemo(() => [pointBars, phoneBars], [pointBars, phoneBars]);
  const beats = useMemo(() => NETWORK_STEPS.map((s) => s.blocks.length), []);
  const {step, leaving, windows, select} = useStepCycle({stage: stageRef, drawings: svgs, bars, beats});
  useLabelFit(stageRef, svgs);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  return (
    <>
      <NetworkBoard
        steps={NETWORK_STEPS}
        step={step}
        leaving={leaving}
        windows={windows}
        stageRef={stageRef}
        svgRefs={svgRefs}
        className={boardClassName}
        overlay={<PhoneTags stage={stageRef} drawings={svgs} holders={!!NETWORK_STEPS[step].holders} />}>
        <PhoneSteps steps={NETWORK_STEPS} step={step} onSelect={select} barRefs={phoneBarRefs} />
      </NetworkBoard>
      <StepPoints steps={NETWORK_STEPS} step={step} ready={ready} onSelect={select} barRefs={pointBarRefs} extra={extra} className={pointsClassName} pointClassName={pointClassName} />
    </>
  );
}
