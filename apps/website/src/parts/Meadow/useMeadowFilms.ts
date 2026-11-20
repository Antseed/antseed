import {useEffect, type RefObject} from 'react';
import type {Phase} from './eyeKit';

const FILM_BASE = '/site/assets/home/footer/meadow-loop-';
const LOOP_SECONDS = 6;

const other = (p: Phase): Phase => (p === 'day' ? 'night' : 'day');

/**
 * Plays the current theme's film while `active` (near the screen, tab visible, motion allowed) and pauses the other. A film is fetched
 * only when its theme is first shown; it starts at the other film's moment so a theme flip stays in step.
 */
export function useMeadowFilms(films: Record<Phase, RefObject<HTMLVideoElement | null>>, phase: Phase, active: boolean): void {
  useEffect(() => {
    const v = films[phase].current;
    const twin = films[other(phase)].current;
    if (twin && !twin.paused) twin.pause();
    if (!v) return;
    if (!active) { v.pause(); return; }
    if (!v.getAttribute('src')) v.src = `${FILM_BASE}${phase}.${v.canPlayType('video/webm; codecs="vp9"') ? 'webm' : 'mp4'}`;
    if (twin?.currentTime && v.paused) {
      try { v.currentTime = twin.currentTime % (v.duration || LOOP_SECONDS); } catch { /* not seekable yet: starts from 0 */ }
    }
    v.play().catch(() => {});
  }, [films, phase, active]);
}
