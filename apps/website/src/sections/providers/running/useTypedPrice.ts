import {useEffect, type RefObject} from 'react';
import {isStill} from '../../../lib/motion';
import {useInView} from '../../../lib/useInView';
import {usePageVisible} from '../../../lib/usePageVisible';
import {useStill} from '../../../lib/useStill';

const SHOWN_AT_FIRST = 3;     // "$0." waits, the rest types in
const TYPE_DELAY_MS = 700;
const KEY_MS = 180;
const SEEN_SHARE = 0.35;

/** Types `text` into `target` once a third of `scene` is on screen (the start of it shown until then). Returns whether the caret should
 *  blink: while the scene is on screen, the tab visible and motion allowed. */
export function useTypedPrice(scene: RefObject<HTMLElement | null>, target: RefObject<HTMLElement | null>, text: string): boolean {
  const onScreen = useInView(scene);
  const visible = usePageVisible();
  const still = useStill();

  useEffect(() => {
    const root = scene.current;
    const el = target.current;
    if (!root || !el || isStill() || text.length <= SHOWN_AT_FIRST) return undefined;
    el.textContent = text.slice(0, SHOWN_AT_FIRST);
    const timers: number[] = [];
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      for (let n = SHOWN_AT_FIRST + 1; n <= text.length; n++) {
        timers.push(window.setTimeout(() => { el.textContent = text.slice(0, n); }, TYPE_DELAY_MS + (n - SHOWN_AT_FIRST - 1) * KEY_MS));
      }
    }, {threshold: SEEN_SHARE});
    io.observe(root);
    return () => { io.disconnect(); timers.forEach(clearTimeout); el.textContent = text; };
  }, [scene, target, text]);

  return onScreen && visible && !still;
}
