import {useEffect, type RefObject} from 'react';
import {placeTags} from './phone';

/** Keeps the phone's tags under their cubes as the stage resizes; nothing runs while the tags are not shown (above a phone). */
export function usePhoneTags(
  stage: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  drawing: RefObject<(SVGSVGElement | null)[]>,
  tags: RefObject<(HTMLElement | null)[]>,
): void {
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      const svg = drawing.current?.[0];
      if (!svg || !box.current || getComputedStyle(box.current).display === 'none') return;
      placeTags(el, svg, tags.current ?? []);
    };
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); });
    ro.observe(el);
    void document.fonts.ready.then(place);   // a tag's width is measured in its font
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [stage, box, drawing, tags]);
}
