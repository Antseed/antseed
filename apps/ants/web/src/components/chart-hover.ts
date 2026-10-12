import { useState, type PointerEvent, type RefObject } from 'react';

/** Index of the slot under `x` for evenly spaced slots starting at `left`; null outside the plot. */
export function slotIndex(x: number, left: number, slot: number, count: number): number | null {
  if (count <= 0 || slot <= 0) return null;
  const index = Math.floor((x - left) / slot);
  return index < 0 || index >= count ? null : index;
}

/** Index of the point whose x is closest to `x`; null when there are no points. */
export function nearestIndex(x: number, xs: number[]): number | null {
  let best: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  xs.forEach((value, index) => {
    const d = Math.abs(value - x);
    if (d < distance) { distance = d; best = index; }
  });
  return best;
}

export interface HoverState { index: number; }

/**
 * Pointer position inside an SVG in viewBox units, resolved to a point index
 * by `resolve`. `viewWidth`/`viewHeight` are the viewBox size so the maths
 * holds when the rendered size differs. `clientPoint` maps viewBox
 * coordinates back to the viewport for a fixed-position tooltip.
 */
export function useChartHover(svg: RefObject<SVGSVGElement | null>, viewWidth: number, viewHeight: number, resolve: (x: number) => number | null) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const index = resolve((event.clientX - rect.left) * (viewWidth / rect.width));
    if (index === null) setHover(null);
    else if (index !== hover?.index) setHover({ index });
  };
  const onPointerLeave = () => setHover(null);
  const clientPoint = (x: number, y: number): { left: number; top: number } => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { left: x, top: y };
    return { left: rect.left + x * (rect.width / viewWidth), top: rect.top + y * (rect.height / viewHeight) };
  };
  return { hover, onPointerMove, onPointerLeave, setHover, clientPoint };
}
