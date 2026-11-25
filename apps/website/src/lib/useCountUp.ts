import {useEffect, useRef, type RefObject} from 'react';
import {isStill} from './motion';

/** A figure is its text: a number with an optional prefix and suffix ("19,252", "742.8B", "$397.1K", "Epoch 30"). */
const COUNT_MS = 2200;
/** A figure waits at 70% of its value, never at 0. */
const START_SHARE = 0.7;
/** It counts once a third of it is on screen. */
const VISIBLE_SHARE = 0.33;
const ease = (k: number) => (k >= 1 ? 1 : 1 - 2 ** (-10 * k));

type Figure = {pre: string; post: string; value: number; decimals: number; grouped: boolean};

function parse(text: string): Figure | null {
  const m = text.match(/^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
  if (!m) return null;
  const [, pre, num, post] = m;
  const value = +num.replace(/,/g, '');
  return {pre, post, value, decimals: (num.split('.')[1] || '').length, grouped: num.includes(',') || value >= 1e4};
}

const format = (f: Figure, v: number) =>
  f.pre + v.toLocaleString('en-US', {minimumFractionDigits: f.decimals, maximumFractionDigits: f.decimals, useGrouping: f.grouped}) + f.post;

const atShare = (text: string, share: number) => {
  const f = parse(text);
  return f ? format(f, f.value * share) : text;
};

type Phase = 'waiting' | 'counting' | 'done';

/**
 * Writes `text` into `ref`'s element, counting up to it the first time the element is seen: from 70% of its value, fast then slowing
 * hard. A new `text` (a live value) arriving before the count is where the count starts from; during it, where it heads; after it, it
 * replaces the text. In still mode the text is just written. The element's text must not be rendered by React after mount.
 */
export function useCountUp(ref: RefObject<HTMLElement | null>, text: string): void {
  const phase = useRef<Phase>('waiting');
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    const el = ref.current;
    if (!el || isStill() || typeof IntersectionObserver === 'undefined') {
      phase.current = 'done';
      return undefined;
    }
    el.textContent = atShare(target.current, START_SHARE);
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      phase.current = 'counting';
      const from = parse(el.textContent ?? '')?.value ?? 0;
      const t0 = performance.now();
      const frame = (now: number) => {
        const f = parse(target.current);
        const k = Math.min(1, (now - t0) / COUNT_MS);
        if (!f || k >= 1) {
          el.textContent = target.current;
          phase.current = 'done';
          return;
        }
        el.textContent = format(f, from + (f.value - from) * ease(k));
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
