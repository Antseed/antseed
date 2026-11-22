import {useEffect, useState, type RefObject} from 'react';
import {REDUCED_MOTION_QUERY, isStill} from '../../../lib/motion';
import {useInView} from '../../../lib/useInView';
import {useHeroPainted} from '../../../lib/heroPainted';
import {usePageVisible} from '../../../lib/usePageVisible';

const PHONE = '(max-width: 760px)';
const SPRITE_MARGIN = '1200px';

export type PricesMotion = {
  /** Ants carry the cards (their sprites load once the lanes near the screen); with reduced motion the lanes are plain. */
  carried: boolean;
  /** The lanes move: on screen, tab visible, not a still capture. */
  moving: boolean;
  still: boolean;
  phone: boolean;
  /** The lanes' width once measured (0 during SSR). */
  width: number;
};

export function usePricesMotion(flow: RefObject<HTMLElement | null>): PricesMotion {
  const [env, setEnv] = useState({still: true, reduced: true, phone: false, width: 0});
  const near = useInView(flow, {rootMargin: SPRITE_MARGIN, once: true});
  const onScreen = useInView(flow);
  const visible = usePageVisible();
  const loaded = useHeroPainted();   // the ants' sprite sheets wait for the hero painting, so they never race the first screen

  useEffect(() => {
    const phone = matchMedia(PHONE);
    const reduced = matchMedia(REDUCED_MOTION_QUERY);
    const read = () => setEnv({still: isStill(), reduced: reduced.matches, phone: phone.matches, width: flow.current?.clientWidth ?? 0});
    read();
    phone.addEventListener('change', read);
    reduced.addEventListener('change', read);
    addEventListener('resize', read);   // ordinary window growth, not just a media-query flip, relengths the lanes
    return () => { phone.removeEventListener('change', read); reduced.removeEventListener('change', read); removeEventListener('resize', read); };
  }, [flow]);

  return {carried: near && loaded && !env.reduced, moving: onScreen && visible && !env.still, still: env.still, phone: env.phone, width: env.width};
}
