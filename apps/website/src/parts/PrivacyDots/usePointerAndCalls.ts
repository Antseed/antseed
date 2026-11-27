import {useEffect, type RefObject} from 'react';
import type {DotField} from './field';

/** What a click on the band's background calls the ants past: by default a card, a link or the words. */
const IGNORE = 'a, button, article, h2, p';

/** The cursor over the band (the host's parent) warms the dots; a click on its background, not on what `ignore` matches, calls the
 *  ants. */
export function usePointerAndCalls(hostRef: RefObject<HTMLDivElement | null>, fieldRef: RefObject<DotField | null>, ignore = IGNORE): void {
  useEffect(() => {
    const band = hostRef.current?.parentElement;
    const host = hostRef.current;
    if (!band || !host) return;
    const at = (e: MouseEvent) => { const b = host.getBoundingClientRect(); return {x: e.clientX - b.left, y: e.clientY - b.top}; };
    const move = (e: PointerEvent) => fieldRef.current?.setPointer(at(e));
    const leave = () => fieldRef.current?.setPointer(null);
    const click = (e: MouseEvent) => {
      if ((e.target as Element).closest(ignore)) return;
      fieldRef.current?.callAnts(at(e));
    };
    band.addEventListener('pointermove', move, {passive: true});
    band.addEventListener('pointerleave', leave);
    band.addEventListener('click', click);
    return () => {
      band.removeEventListener('pointermove', move);
      band.removeEventListener('pointerleave', leave);
      band.removeEventListener('click', click);
    };
  }, [hostRef, fieldRef, ignore]);
}
