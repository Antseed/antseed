import {useEffect, useRef, type RefObject} from 'react';
import {prefersReducedMotion} from '../../../lib/motion';

const SEEN_THRESHOLD = 0.35;

const panels = (stage: HTMLElement) => [...stage.querySelectorAll<HTMLElement>('[data-panel]')];

/** Back to its start at once (no transitions), then its play two frames later. */
function playAgain(panel: HTMLElement) {
  panel.setAttribute('data-reset', '');
  panel.removeAttribute('data-played');
  void panel.offsetWidth;
  panel.removeAttribute('data-reset');
  requestAnimationFrame(() => requestAnimationFrame(() => panel.setAttribute('data-played', '')));
}

/**
 * Each chosen screen plays its scene (bars growing, the enclave lighting, rows landing, the result coming): the first one as the stage
 * comes into view, then each time a point is chosen. `data-motion` on the stage turns the plays on;
 * without it (reduced motion) every screen shows its end state. Stacked, each screen plays once as it comes into view.
 */
export function useScenePlay(stage: RefObject<HTMLElement | null>, current: number, stacked: boolean): void {
  const seen = useRef(false);
  const first = useRef(true);

  useEffect(() => {
    const st = stage.current;
    if (!st || prefersReducedMotion()) return;
    st.setAttribute('data-motion', '');
    if (stacked) {
      const each = new IntersectionObserver((entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return;
        each.unobserve(e.target);
        playAgain(e.target as HTMLElement);
      }), {threshold: SEEN_THRESHOLD});
      panels(st).forEach((p) => each.observe(p));
      return () => { each.disconnect(); st.removeAttribute('data-motion'); };
    }
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      seen.current = true;
      const on = panels(st).find((p) => p.hasAttribute('data-on'));
      if (on) playAgain(on);
    }, {threshold: SEEN_THRESHOLD});
    io.observe(st);
    return () => { io.disconnect(); st.removeAttribute('data-motion'); };
  }, [stage, stacked]);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (stacked) return;
    const st = stage.current;
    const panel = st && panels(st)[current];
    if (!panel) return;
    if (seen.current && st.hasAttribute('data-motion')) playAgain(panel);
  }, [stage, current, stacked]);
}
