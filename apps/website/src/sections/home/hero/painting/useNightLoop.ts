import {useEffect, type RefObject} from 'react';
import {isStill} from '../../../../lib/motion';

type NightOptions = {src: string; onClass: string; playing: boolean};

/** The night's own loop over the night still: fetched only the first time it should play (night, on screen, motion allowed). */
export function useNightLoop(ref: RefObject<HTMLVideoElement | null>, {src, onClass, playing}: NightOptions): void {
  useEffect(() => {
    const v = ref.current;
    if (!v || isStill()) return;
    if (!playing) { if (!v.paused) v.pause(); return; }
    if (!v.src) {
      v.muted = true;
      v.addEventListener('playing', () => v.classList.add(onClass), {once: true});
      v.src = src;
    }
    v.play().catch(() => {});
  }, [ref, src, onClass, playing]);
}
