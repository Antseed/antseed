import {useEffect, useLayoutEffect, type RefObject} from 'react';
import {followSelectedTab} from '../../../lib/followSelectedTab';

/**
 * Places a sliding indicator under the selected tab: writes `--indicator-x` and `--indicator-w` on `bar`, and sets `data-ready` once
 * the fonts have settled so the first placement doesn't animate.
 */
export function useTabIndicator(bar: RefObject<HTMLElement | null>, selected: number): void {
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    return followSelectedTab(el, selected, '--indicator').stop;
  }, [bar, selected]);

  useEffect(() => {
    let live = true;
    document.fonts.ready.then(() => { if (live) requestAnimationFrame(() => bar.current?.setAttribute('data-ready', '')); });
    return () => { live = false; };
  }, [bar]);
}
