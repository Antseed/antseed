import {useEffect, useLayoutEffect, useRef, type RefObject} from 'react';
import {followSelectedTab} from '../../../../lib/followSelectedTab';
import {isStill} from '../../../../lib/motion';

const SLIDE = {duration: 350, easing: 'cubic-bezier(.65, 0, .35, 1)'};
const SLIDE_PX = 12;
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The tab bar's thumb under the chosen tab: its place and width as CSS variables (--thumb-x, --thumb-w), measured again on resize.
 * It may slide (`readyClass`) only once placed and the fonts are in, so it never slides on load. When the choice changes, the panel
 * leaving and the one arriving slide a little the same way, fading.
 */
export function useTabThumb(list: RefObject<HTMLElement | null>, selected: number, panels: RefObject<(HTMLElement | null)[]>, readyClass: string): void {
  useIsoLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const {place, stop} = followSelectedTab(el, selected, '--thumb');
    let live = true;
    document.fonts.ready.then(() => { if (!live) return; place(); void el.offsetWidth; el.classList.add(readyClass); });
    return () => { live = false; stop(); };
  }, [list, selected, readyClass]);

  const previous = useRef(selected);
  useEffect(() => {
    const from = previous.current;
    previous.current = selected;
    if (from === selected || isStill()) return;
    const d = Math.sign(selected - from);
    const out = panels.current?.[from];
    const into = panels.current?.[selected];
    out?.animate([{opacity: 1, transform: 'none', visibility: 'visible'}, {opacity: 0, transform: `translateX(${SLIDE_PX * d}px)`, visibility: 'visible'}], SLIDE);
    into?.animate([{opacity: 0, transform: `translateX(${-SLIDE_PX * d}px)`}, {opacity: 1, transform: 'none'}], SLIDE);
  }, [selected, panels]);
}
