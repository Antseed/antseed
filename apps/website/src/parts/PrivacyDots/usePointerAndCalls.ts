import {useEffect, type RefObject} from 'react';
import type {DotField} from './field';

/** What a click on the band's background calls the ants past: by default a card, a link or the words. */
const IGNORE = 'a, button, article, h2, p';

type Point = {x: number; y: number};
type Handlers = {
  /** A click on what this matches is left alone. */
  ignore: string;
  move: (p: Point, e: PointerEvent) => void;
  leave: () => void;
  call: (p: Point) => void;
};

/** Wires a dot band's pointer to its animation: moves and leaves over the host's parent (the band), and clicks on its background, in
 *  the host's own px. Returns the teardown. */
export function bindPointerAndCalls(host: HTMLElement, {ignore, move, leave, call}: Handlers): () => void {
  const band = host.parentElement;
  if (!band) return () => {};
  const at = (e: MouseEvent): Point => { const b = host.getBoundingClientRect(); return {x: e.clientX - b.left, y: e.clientY - b.top}; };
  const onMove = (e: PointerEvent) => move(at(e), e);
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element).closest(ignore)) return;
    call(at(e));
  };
  band.addEventListener('pointermove', onMove, {passive: true});
  band.addEventListener('pointerleave', leave);
  band.addEventListener('click', onClick);
  return () => {
    band.removeEventListener('pointermove', onMove);
    band.removeEventListener('pointerleave', leave);
    band.removeEventListener('click', onClick);
  };
}

/** The cursor over the band (the host's parent) warms the dots; a click on its background, not on what `ignore` matches, calls the
 *  ants. */
export function usePointerAndCalls(hostRef: RefObject<HTMLDivElement | null>, fieldRef: RefObject<DotField | null>, ignore = IGNORE): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return bindPointerAndCalls(host, {
      ignore,
      move: (p) => fieldRef.current?.setPointer(p),
      leave: () => fieldRef.current?.setPointer(null),
      call: (p) => fieldRef.current?.callAnts(p),
    });
  }, [hostRef, fieldRef, ignore]);
}
