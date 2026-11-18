import {useCallback, useLayoutEffect, useRef, type RefObject} from 'react';

const DISTANCE = 72;
const OUT = {duration: 170, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards'} as const;
const IN = {duration: 320, easing: 'cubic-bezier(0, 0, .2, 1)'} as const;

function swipeIn(node: HTMLElement, direction: number) {
  node.getAnimations().forEach((a) => a.cancel());
  node.animate([{transform: `translateX(${direction * DISTANCE}px)`, filter: 'blur(6px)', opacity: 0}, {transform: 'none', filter: 'blur(0)', opacity: 1}], IN);
}

/**
 * Swaps `el`'s content with a swipe in the direction the tab moved: the old content slips out blurred and fading, then `commit()`
 * renders `next`, which comes in from the other side and sharpens. `key` is what the content renders from, so the swipe-in plays once
 * it has rendered. A second swipe cuts the first short; one back to the content still on screen brings it straight back in, as no
 * render follows that commit. Without motion it commits at once.
 */
export function useLaneSwipe<K>(el: RefObject<HTMLElement | null>, key: K, still: boolean) {
  const run = useRef(0);
  const incoming = useRef(0);
  const shown = useRef(key);

  const swipe = useCallback((direction: number, next: K, commit: () => void) => {
    const node = el.current;
    if (still || !node) { commit(); return; }
    const me = ++run.current;
    if (next === shown.current) { incoming.current = 0; swipeIn(node, direction); commit(); return; }
    node.getAnimations().forEach((a) => a.cancel());
    node.animate([{transform: 'none', filter: 'blur(0)', opacity: 1}, {transform: `translateX(${-direction * DISTANCE}px)`, filter: 'blur(6px)', opacity: 0}], OUT)
      .finished.then(() => {
        if (me !== run.current) return;
        if (next === shown.current) { swipeIn(node, direction); return; }
        incoming.current = direction;
        commit();
      }, () => {});
  }, [el, still]);

  useLayoutEffect(() => {
    shown.current = key;
    const node = el.current;
    const direction = incoming.current;
    if (!node || !direction) return;
    incoming.current = 0;
    swipeIn(node, direction);
  }, [el, key]);

  return swipe;
}
