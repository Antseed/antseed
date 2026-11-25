import {useEffect, type RefObject} from 'react';

/** The margin's dot pitch. */
const DOT_GRID = 8;
/** A height within this share of a grid row below a multiple is treated as that multiple (sub-pixel rounding). */
const TOLERANCE = 0.02;

type Options = {
  enabled?: boolean;
  /** Snap only while this media query matches (`(max-width: 1199px)` for a block that is exactly the screen on wide ones). */
  media?: string;
  grid?: number;
};

/** The element and the two levels inside it (a section, its rail, the rail's blocks). */
const observed = (el: HTMLElement): Element[] => [el, ...el.children, ...[...el.children].flatMap((c) => [...c.children])];

/**
 * Gives an element a min-height that is the next multiple of `grid` (the 8px dot grid by default), so every section's top (and its
 * dotted edge) lands on a row of the margin's dots at any width. The section's rail stretches into it (flex). Re-measured in the next
 * frame after any resize of the element or of its content: min-height is cleared, the natural height read, the new min-height set,
 * all in one frame, so the observer settles instead of looping. The content is watched too, because content that shrinks (a font
 * arriving, a closed FAQ answer) leaves the pinned element itself the same size.
 */
export function useGridSnap(ref: RefObject<HTMLElement | null>, {enabled = true, media, grid = DOT_GRID}: Options = {}): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return;
    const query = media ? window.matchMedia(media) : null;
    let frame = 0;
    const snap = () => {
      el.style.minHeight = '';
      if (query && !query.matches) return;
      const natural = el.getBoundingClientRect().height;
      const target = Math.ceil(natural / grid - TOLERANCE) * grid;
      if (target > natural) el.style.minHeight = `${target}px`;
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(snap);
    });
    observed(el).forEach((node) => ro.observe(node));
    query?.addEventListener('change', snap);
    return () => {
      ro.disconnect();
      query?.removeEventListener('change', snap);
      cancelAnimationFrame(frame);
      el.style.minHeight = '';
    };
  }, [ref, enabled, media, grid]);
}
