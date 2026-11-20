import {Fragment, useEffect, useRef, type JSX, type RefObject} from 'react';
import {isStill} from '../lib/motion';

/** Where the line's top is, as a share of the screen's height, when it starts lighting and when it is fully lit. */
const FROM = 0.86;
const TO = 0.46;
/** A word's opacity before it lights. */
const DIM = 0.26;
/** The lit front's softness, in words. */
const SOFT = 5;

/** A sentence that waits dimmed and lights up word by word as it scrolls up the screen. Renders as plain words on the server and in
 *  still mode. */
export function ScrollLitText({text, className}: {text: string; className?: string}): JSX.Element {
  const ref = useRef<HTMLParagraphElement>(null);
  useScrollLit(ref);
  const words = text.trim().split(/\s+/);
  return (
    <p ref={ref} className={className}>
      {words.map((w, i) => <Fragment key={i}>{i ? ' ' : ''}<span>{w}</span></Fragment>)}
    </p>
  );
}

function useScrollLit(ref: RefObject<HTMLParagraphElement | null>): void {
  useEffect(() => {
    const line = ref.current;
    if (!line || isStill() || typeof IntersectionObserver === 'undefined') return;
    const words = [...line.children] as HTMLElement[];
    const paint = () => {
      const top = line.getBoundingClientRect().top / window.innerHeight;
      const k = Math.min(1, Math.max(0, (FROM - top) / (FROM - TO)));
      words.forEach((w, i) => {
        const lit = Math.min(1, Math.max(0, (k * (words.length + SOFT - 1) - i) / SOFT));
        w.style.opacity = (DIM + (1 - DIM) * lit).toFixed(3);
      });
    };
    let near = false;
    let frame = 0;
    const onScroll = () => { if (near && !frame) frame = requestAnimationFrame(() => { frame = 0; paint(); }); };
    // painted once more as it leaves, so a fast jump still lands on the right end state
    const io = new IntersectionObserver(([e]) => { near = e.isIntersecting; paint(); });
    io.observe(line);
    window.addEventListener('scroll', onScroll, {passive: true});
    paint();
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
      words.forEach((w) => w.style.removeProperty('opacity'));
    };
  }, [ref]);
}
