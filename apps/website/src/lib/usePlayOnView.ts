import {useEffect, useState, type RefObject} from 'react';
import {isStill} from './motion';

const DEFAULT_SHARE = 0.35;

/**
 * A one-off entrance for a card: true while the card waits off screen, false once `share` of it has been seen. It starts (and, in
 * still mode, stays) false, so the server render and still captures show the end state.
 *
 * Put the start state on the pending class and the transition on the base rule only, so hiding on hydration is instant and only the
 * entrance animates:
 *   .menu { transition: opacity .35s .35s; }   .pending .menu { opacity: 0; transition: none; }
 */
export function usePlayOnView<T extends Element>(ref: RefObject<T | null>, share = DEFAULT_SHARE): boolean {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || isStill() || typeof IntersectionObserver === 'undefined') return;
    setPending(true);
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      setPending(false);
    }, {threshold: share});
    io.observe(el);
    return () => io.disconnect();
  }, [ref, share]);
  return pending;
}
