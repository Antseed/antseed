import {useEffect, useLayoutEffect, type RefObject} from 'react';

/**
 * Places a sliding indicator under the selected tab: writes `--indicator-x` and `--indicator-w` on `bar`, and sets `data-ready` once
 * the fonts have settled so the first placement doesn't animate.
 */
export function useTabIndicator(bar: RefObject<HTMLElement | null>, selected: number): void {
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const place = () => {
      const tab = el.querySelectorAll<HTMLElement>('[role="tab"]')[selected];
      if (!tab) return;
      el.style.setProperty('--indicator-x', `${tab.offsetLeft}px`);
      el.style.setProperty('--indicator-w', `${tab.offsetWidth}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bar, selected]);

  useEffect(() => {
    let live = true;
    document.fonts.ready.then(() => { if (live) requestAnimationFrame(() => bar.current?.setAttribute('data-ready', '')); });
    return () => { live = false; };
  }, [bar]);
}
