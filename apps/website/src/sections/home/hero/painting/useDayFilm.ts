import {useEffect, type RefObject} from 'react';
import {isStill} from '../../../../lib/motion';
import {afterHeroPainted} from '../../../../lib/heroPainted';

const WAKE_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'touchstart'] as const;

type Options = {base: string; onClass: string; playing: boolean};

/**
 * The day's meadow loop over its poster (the poster is its first frame). Asked for only once the painting is on screen, so its megabyte
 * never races the poster, the fonts or the styles; shown only once it actually plays. Paused while `playing` is false (off screen, tab
 * hidden, night). If autoplay is refused (Low Power Mode, data saver) it starts on the first pointer move, tap or key. None when still.
 */
export function useDayFilm(ref: RefObject<HTMLVideoElement | null>, {base, onClass, playing}: Options): void {
  // the source, once, after the painting
  useEffect(() => {
    const v = ref.current;
    if (!v || isStill()) return;
    v.muted = v.defaultMuted = true;
    const shown = () => v.classList.add(onClass);
    v.addEventListener('playing', shown, {once: true});
    const load = () => { v.src = `${base}.${v.canPlayType('video/webm; codecs="vp9"') ? 'webm' : 'mp4'}`; };
    const cancel = afterHeroPainted(load);
    return () => { cancel(); v.removeEventListener('playing', shown); };
  }, [ref, base, onClass]);

  // play or pause; a refused play waits for the visitor's first gesture
  useEffect(() => {
    const v = ref.current;
    if (!v || isStill()) return;
    if (!playing) { v.pause(); return; }
    const retry = () => { v.play().catch(() => {}); };
    const tryPlay = () => {
      if (!v.src) return;
      v.play().catch(() => WAKE_EVENTS.forEach((e) => window.addEventListener(e, retry, {once: true, passive: true})));
    };
    tryPlay();
    v.addEventListener('loadstart', tryPlay);
    return () => {
      v.removeEventListener('loadstart', tryPlay);
      WAKE_EVENTS.forEach((e) => window.removeEventListener(e, retry));
    };
  }, [ref, playing]);
}
