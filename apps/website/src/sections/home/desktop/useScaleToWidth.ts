import {useEffect, type RefObject} from 'react';

/** Keeps `--scale` on `target` at the frame's width over `base`, so content laid out at `base` px fills the frame. */
export function useScaleToWidth(frame: RefObject<HTMLElement | null>, target: RefObject<HTMLElement | null>, base: number): void {
  useEffect(() => {
    const f = frame.current;
    const t = target.current;
    if (!f || !t) return;
    const ro = new ResizeObserver(() => t.style.setProperty('--scale', (f.clientWidth / base).toFixed(4)));
    ro.observe(f);
    return () => ro.disconnect();
  }, [frame, target, base]);
}
