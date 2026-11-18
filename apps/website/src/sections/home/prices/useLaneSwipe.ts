import {useCallback, useLayoutEffect, useRef, type RefObject} from 'react';

const DISTANCE = 72;
const OUT = {duration: 170, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards'} as const;
const IN = {duration: 320, easing: 'cubic-bezier(0, 0, .2, 1)'} as const;

/**
 * Swaps `el`'s content with a swipe in the direction the tab moved: the old content slips out blurred and fading, then `commit()`
 * renders the new one, which comes in from the other side and sharpens. A second swipe cuts the first short. `key` is what the
 * content renders from, so the swipe-in plays once it has rendered. Without motion it commits at once.
 */
export function useLaneSwipe<K>(el: RefObject<HTMLElement | null>, key: K, still: boolean) {
  const run = useRef(0);
  const incoming = useRef(0);

  const swipe = useCallback((direction: number, commit: () => void) => {
    const node = el.current;
    if (still || !node) { commit(); return; }
    const me = ++run.current;
    node.getAnimations().forEach((a) => a.cancel());
    node.animate([{transform: 'none', filter: 'blur(0)', opacity: 1}, {transform: `translateX(${-direction * DISTANCE}px)`, filter: 'blur(6px)', opacity: 0}], OUT)
      .finished.then(() => {
        if (me !== run.current) return;
        incoming.current = direction;
        commit();
      }, () => {});
  }, [el, still]);

  useLayoutEffect(() => {
    const node = el.current;
    const direction = incoming.current;
    if (!node || !direction) return;
    incoming.current = 0;
    node.getAnimations().forEach((a) => a.cancel());
    node.animate([{transform: `translateX(${direction * DISTANCE}px)`, filter: 'blur(6px)', opacity: 0}, {transform: 'none', filter: 'blur(0)', opacity: 1}], IN);
  }, [el, key]);

  return swipe;
}
