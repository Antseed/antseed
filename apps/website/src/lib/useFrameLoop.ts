import {useEffect} from 'react';

/** Runs `tick(now)` on every animation frame while `active`, and only then (pass `active = inView && !still && visible`). */
export function useFrameLoop(active: boolean, tick: (now: number) => void): void {
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = (now: number) => { tick(now); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
