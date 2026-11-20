import {useCallback, useEffect, useRef, useState, type RefObject} from 'react';
import {prefersReducedMotion} from '../../../lib/motion';
import {antRoom, fitList, fitScreens} from './fitPoints';

const STEP_SHARE = 0.8;   // the page scrolls this share of a screen per point while the frame holds
const AUTO_MS = 7000;     // unpinned, the next point is chosen this often
const SETTLE_MS = 160;    // a scroll of ours has ended once the page is still this long
const ROOMY = '(min-width: 900px) and (min-height: 600px)';

export type PointsRefs = {
  /** The frame and the run after it; carries `data-pinned`, `data-seen` and the layout variables. */
  hold: RefObject<HTMLElement | null>;
  /** The frame that sticks. */
  pin: RefObject<HTMLElement | null>;
  list: RefObject<HTMLElement | null>;
  stage: RefObject<HTMLElement | null>;
  ant: RefObject<HTMLElement | null>;
};
export type ChooseHow = 'click' | 'key' | 'scroll' | 'auto';

/**
 * The privacy points' choice. Where the list stands beside the panel and the frame fits the screen, the frame sticks (`data-pinned` on
 * the hold) and the page's scroll chooses: each point owns STEP_SHARE of a screen of the run after the frame; a click scrolls to its
 * point. Elsewhere the next point is chosen every AUTO_MS while the section is on screen and neither hovered nor focused. Stacked (a
 * phone), all four are shown and nothing is chosen.
 */
export function usePinnedPoints(refs: PointsRefs, count: number, stacked: boolean): {current: number; choose: (i: number, how: ChooseHow) => void} {
  const [current, setCurrent] = useState(0);
  const cur = useRef(0);
  const stackedRef = useRef(stacked);
  const geo = useRef({pinned: false, top: 0, step: 1, ran: -1, held: false});
  const actions = useRef({go: (_i: number) => {}, tick: () => {}});

  const choose = useCallback((i: number, how: ChooseHow) => {
    if (stackedRef.current) return;
    const g = geo.current;
    if (how === 'key') refs.list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus({preventScroll: g.pinned});
    if (g.pinned && how !== 'scroll' && i !== cur.current) actions.current.go(i);
    if (i !== cur.current) { cur.current = i; setCurrent(i); }
    actions.current.tick();
  }, [refs.list]);

  useEffect(() => {
    const {hold, pin, list, stage, ant} = refs;
    const sec = hold.current;
    const span = hold.current;
    const frame = pin.current;
    const ls = list.current;
    const st = stage.current;
    if (!sec || !span || !frame || !ls || !st) return;
    // reduced motion only: still captures keep the pinned layout
    const g = geo.current;
    const roomy = window.matchMedia(ROOMY);
    const still = prefersReducedMotion();
    let timer = 0;
    let quiet = 0;
    let raf = 0;
    let seen = false;

    const measure = () => {
      fitList(ls); fitScreens(st);
      const room = antRoom(st, ant.current);
      sec.style.setProperty('--ant-room', `${room}px`);
      const foot = Math.min(120, Math.max(40, innerHeight * 0.1));
      g.pinned = !still && roomy.matches && room + st.offsetHeight + foot + 8 <= innerHeight;
      sec.toggleAttribute('data-pinned', g.pinned);
      if (!g.pinned) { sec.style.removeProperty('--pin-top'); sec.style.removeProperty('--run-length'); return; }
      g.step = Math.max(1, Math.round(innerHeight * STEP_SHARE));
      g.top = Math.min(0, innerHeight - frame.offsetHeight);
      sec.style.setProperty('--pin-top', `${g.top}px`);
      sec.style.setProperty('--run-length', `${g.step * count}px`);
    };
    // the point the scroll is at: steps run since the frame stuck (before it, the first; past the run, the last)
    const follow = () => {
      raf = 0;
      if (!g.pinned) return;
      g.ran = (g.top - span.getBoundingClientRect().top) / g.step;
      if (g.held) return;
      const i = Math.max(0, Math.min(count - 1, Math.floor(g.ran)));
      if (i !== cur.current) choose(i, 'scroll');
    };
    const settle = () => { clearTimeout(quiet); quiet = window.setTimeout(() => { g.held = false; follow(); }, SETTLE_MS); };
    const onScroll = () => { if (g.held) settle(); if (!raf) raf = requestAnimationFrame(follow); };
    actions.current.go = (i) => {
      g.held = true; settle();
      window.scrollTo({top: scrollY + span.getBoundingClientRect().top - g.top + (i + 0.5) * g.step, behavior: 'smooth'});
    };
    const hovered = () => st.parentElement?.matches(':hover, :focus-within') ?? false;
    actions.current.tick = () => {
      clearTimeout(timer); timer = 0;
      if (still || g.pinned || stackedRef.current || !seen || document.hidden) return;
      timer = window.setTimeout(() => { if (hovered()) actions.current.tick(); else choose((cur.current + 1) % count, 'auto'); }, AUTO_MS);
    };
    // a resize while the frame holds keeps the page at the same place in the run, so the point shown stays
    const relayout = () => {
      const was = g.pinned;
      const at = g.ran;
      measure();
      if (was !== g.pinned) actions.current.tick();
      if (was && g.pinned && at > 0 && at < count) {
        const y = scrollY + span.getBoundingClientRect().top - g.top + at * g.step;
        if (Math.abs(y - scrollY) > 1) window.scrollTo({top: y, behavior: 'instant'});
      }
      follow();
    };

    // scroll is listened to only while the frame and its run are near the screen
    const near = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { addEventListener('scroll', onScroll, {passive: true}); follow(); } else removeEventListener('scroll', onScroll);
    });
    const onScreen = new IntersectionObserver(([e]) => { seen = e.isIntersecting; sec.toggleAttribute('data-seen', seen); actions.current.tick(); });
    const ro = new ResizeObserver(relayout);
    const onVisibility = () => actions.current.tick();
    near.observe(span); onScreen.observe(sec); ro.observe(frame);
    addEventListener('resize', relayout);
    roomy.addEventListener('change', relayout);
    document.addEventListener('visibilitychange', onVisibility);
    st.parentElement?.addEventListener('pointerleave', onVisibility);
    st.parentElement?.addEventListener('focusout', onVisibility);
    measure();
    return () => {
      near.disconnect(); onScreen.disconnect(); ro.disconnect();
      removeEventListener('scroll', onScroll); removeEventListener('resize', relayout);
      roomy.removeEventListener('change', relayout);
      document.removeEventListener('visibilitychange', onVisibility);
      st.parentElement?.removeEventListener('pointerleave', onVisibility);
      st.parentElement?.removeEventListener('focusout', onVisibility);
      clearTimeout(timer); clearTimeout(quiet); cancelAnimationFrame(raf);
      sec.removeAttribute('data-pinned'); sec.removeAttribute('data-seen');
    };
  }, [refs, count, choose]);

  useEffect(() => {
    stackedRef.current = stacked;
    actions.current.tick();
  }, [stacked]);

  return {current, choose};
}
