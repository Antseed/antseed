import {useEffect, useRef, type RefObject} from 'react';
import {isStill} from './motion';
import {atShare, countAt, countShare, parse, START_SHARE} from './countUp';

/** It counts once a third of it is on screen. */
const VISIBLE_SHARE = 0.33;

type Phase = 'waiting' | 'counting' | 'done';

/**
 * Writes `text` into `ref`'s element, counting up to it the first time the element is seen: from 70% of its value, fast then slowing
 * hard. A new `text` (a live value) arriving before the count is where the count starts from; during it, where it heads; after it, it
 * replaces the text. In still mode, or once the motion gate has lifted, the text is just written. The element's text must not be
 * rendered by React after mount.
 */
export function useCountUp(ref: RefObject<HTMLElement | null>, text: string): void {
  const phase = useRef<Phase>('waiting');
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    const el = ref.current;
    // the motion gate lifted (the page hydrated after its 4s timeout): the full figure is already on screen, so it stays
    const gateLifted = !document.documentElement.hasAttribute('data-motion');
    if (!el || isStill() || gateLifted || typeof IntersectionObserver === 'undefined') {
      phase.current = 'done';
      if (el) el.dataset.ready = '';
      return undefined;
    }
    el.textContent = atShare(target.current, START_SHARE);
    // shown from here (Tally.module.css): the eye never reads the server's full figure, then sees it drop to 70%
    el.dataset.ready = '';
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      phase.current = 'counting';
      // 70% of where it heads, which is what the element shows while it waits, so the first frame never steps down
      const from = (parse(target.current)?.value ?? 0) * START_SHARE;
      const t0 = performance.now();
      const frame = (now: number) => {
        const f = parse(target.current);
        if (!f || countShare(now, t0) >= 1) {
          el.textContent = target.current;
          phase.current = 'done';
          return;
        }
        el.textContent = countAt(f, from, now, t0);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }, {threshold: VISIBLE_SHARE});
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      el.textContent = target.current;
    };
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (phase.current === 'done') el.textContent = text;
    else if (phase.current === 'waiting') el.textContent = atShare(text, START_SHARE);
  }, [ref, text]);
}
