import {useCallback, useEffect, type RefObject} from 'react';
import {isStill} from '../../../lib/motion';
import {CHAPTERS, FALLBACK_DURATION} from './chapters';

const PLAY_THRESHOLD = 0.4;
// a chapter lights a hair before its start, so a jump to it lands lit
const LEAD = 0.05;

/**
 * Plays the film muted while 40% of it is on screen and the tab is visible, and keeps the chapter buttons in step: the current one
 * pressed, a `--progress` (0–1) filling under it. With reduced motion or a still capture it stays on its poster with controls.
 * Returns `jump(i)` for the buttons. Progress is written to the buttons' style, not React state (it changes on every timeupdate).
 */
export function useFilmChapters(
  videoRef: RefObject<HTMLVideoElement | null>,
  buttonsRef: RefObject<Array<HTMLButtonElement | null>>,
  active: boolean,
): (index: number) => void {
  const light = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    let current = 0;
    CHAPTERS.forEach((c, i) => { if (v.currentTime >= c.start - LEAD) current = i; });
    buttonsRef.current.forEach((b, i) => {
      if (!b) return;
      const start = CHAPTERS[i].start;
      const end = CHAPTERS[i + 1]?.start ?? (v.duration || FALLBACK_DURATION);
      b.setAttribute('aria-pressed', String(i === current));
      b.style.setProperty('--progress', String(i === current ? Math.min(1, (v.currentTime - start) / (end - start)) : 0));
    });
  }, [videoRef, buttonsRef]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !active) return;
    v.addEventListener('timeupdate', light);
    light();
    if (isStill()) {
      v.controls = true;
      return () => v.removeEventListener('timeupdate', light);
    }
    let inView = false;
    // plays only while enough of it is on screen and the tab is visible; resumes when either comes back
    const sync = () => {
      if (inView && !document.hidden) v.play().catch(() => {});
      else v.pause();
    };
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      sync();
    }, {threshold: PLAY_THRESHOLD});
    io.observe(v);
    const onVisibility = sync;
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      v.removeEventListener('timeupdate', light);
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      v.pause();
    };
  }, [videoRef, active, light]);

  return useCallback((index: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = CHAPTERS[index].start;
    v.play().catch(() => {});
    light();
  }, [videoRef, light]);
}
