import {useCallback, useEffect, useRef, useState, type RefObject} from 'react';
import {isStill} from '../../lib/motion';
import {usePageVisible} from '../../lib/usePageVisible';
import {createClock} from './clock';
import {createStepCycle, type StepCycle} from './cycle';
import {prepareDrawing} from './drawing';

const SEEN_THRESHOLD = 0.35;

export type WindowState = {beat: number; instant: boolean};

type Options = {
  stage: RefObject<HTMLElement | null>;
  drawings: RefObject<(SVGSVGElement | null)[]>;
  /** Sets of progress bars, one bar per step in each: its fill is the CSS variable --progress (0..1). */
  bars: readonly RefObject<(HTMLElement | null)[]>[];
  /** Beats per step: the windows start complete (the server render and still mode). */
  beats: readonly number[];
};

/**
 * Plays the network board: the step on show and each step window's beat are React state (they change a few times a second at most);
 * the drawings and the progress bars are animated directly. Time passes only while the stage is on screen and the tab is visible;
 * in still mode the steps show complete and only `select` changes them.
 */
export function useStepCycle({stage, drawings, bars, beats}: Options): {step: number; leaving: number | null; windows: WindowState[]; select(k: number): void} {
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [windows, setWindows] = useState<WindowState[]>(() => beats.map((n) => ({beat: n - 1, instant: false})));
  const cycle = useRef<StepCycle | null>(null);
  const [clock] = useState(createClock);
  const visible = usePageVisible();
  const seen = useRef(false);

  useEffect(() => {
    const svgs = drawings.current;
    if (!svgs || svgs.some((s) => !s)) return;
    const prepared = (svgs as SVGSVGElement[]).map(prepareDrawing);
    const setProgress = (k: number, p: number) => bars.forEach((set) => set.current?.[k]?.style.setProperty('--progress', Math.min(1, p).toFixed(3)));
    cycle.current = createStepCycle(prepared, clock, isStill(), {
      step: setStep,
      leaving: setLeaving,
      beat: (k, beat, instant) => setWindows((ws) => ws.map((w, i) => (i === k ? {beat, instant} : w))),
      progress: setProgress,
    });
    const io = new IntersectionObserver(([e]) => {
      seen.current = e.isIntersecting;
      clock.setLive(seen.current && !document.hidden);
      cycle.current?.setSeen(seen.current);
    }, {threshold: SEEN_THRESHOLD});
    if (stage.current) io.observe(stage.current);
    return () => {
      io.disconnect();
      clock.cancel();
      cycle.current = null;
      seen.current = false;
      prepared.forEach((d) => d.dispose());
    };
  }, [stage, drawings, bars, clock]);

  useEffect(() => clock.setLive(seen.current && visible), [clock, visible]);

  const select = useCallback((k: number) => cycle.current?.select(k), []);
  return {step, leaving, windows, select};
}
