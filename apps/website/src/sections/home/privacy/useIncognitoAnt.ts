import {useEffect, type RefObject} from 'react';
import {isStill} from '../../../lib/motion';

export type Clip = 'idle' | 'laugh' | 'frown';
export const CLIPS: readonly Clip[] = ['idle', 'laugh', 'frown'];

const LOAD_MARGIN = '600px 0px';
const FROWN_ODDS = 0.2;
const BASE = '/site/assets/home/ant-incognito';

// HEVC with alpha in Safari (every iOS browser), VP9 with alpha elsewhere
const playsHevc = (v: HTMLVideoElement) => navigator.vendor === 'Apple Computer, Inc.' && v.canPlayType('video/mp4; codecs="hvc1"') !== '';
const sourceFor = (clip: Clip, hevc: boolean) => `${BASE}-${clip}${hevc ? '-hevc.mov' : '.webm'}`;

/**
 * The incognito ant on the privacy panel: she idles in a loop; a click plays her laugh once (one time in five a short frown), then she
 * is back to the loop. Every clip starts and ends on the same pose, so each hand-over is a plain cut, and a click waits for the loop's
 * end. Fetched as the section nears, playing only on screen with the tab visible; nothing in still mode (her poster stays).
 */
export function useIncognitoAnt(button: RefObject<HTMLButtonElement | null>): void {
  useEffect(() => {
    const btn = button.current;
    if (!btn || isStill()) return;
    const clips = Object.fromEntries([...btn.querySelectorAll<HTMLVideoElement>('video[data-clip]')].map((v) => [v.dataset.clip, v])) as Record<Clip, HTMLVideoElement>;
    const idle = clips.idle;
    const hevc = playsHevc(idle);
    // Safari drops an HEVC clip's alpha under a CSS filter, showing the colour stored behind it: the dark theme's tone skips it there
    btn.toggleAttribute('data-hevc', hevc);
    let seen = false;
    let busy: HTMLVideoElement | null = null;

    const show = (v: HTMLVideoElement) => CLIPS.forEach((c) => clips[c].toggleAttribute('data-shown', clips[c] === v));
    const rewind = (v: HTMLVideoElement) => { if (v.currentTime) v.currentTime = 0; };
    const sync = () => { if (seen && !busy && !document.hidden) idle.play().catch(() => {}); else idle.pause(); };
    const back = (v: HTMLVideoElement) => () => { busy = null; show(idle); sync(); rewind(v); };
    const onIdleEnd = () => {
      const v = busy;
      idle.loop = true;
      if (!v) { sync(); return; }
      show(v);
      v.play().catch(back(v));
      rewind(idle);
    };
    const onClick = () => {
      if (busy || !seen) return;
      busy = clips[Math.random() < FROWN_ODDS ? 'frown' : 'laugh'];
      rewind(busy);
      idle.loop = false;
      if (idle.paused) onIdleEnd();
    };
    const reactions = (['laugh', 'frown'] as const).map((c) => [clips[c], back(clips[c])] as const);
    reactions.forEach(([v, fn]) => v.addEventListener('ended', fn));
    idle.addEventListener('ended', onIdleEnd);
    idle.addEventListener('canplay', sync);
    btn.addEventListener('click', onClick);
    document.addEventListener('visibilitychange', sync);

    const load = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      load.disconnect();
      CLIPS.forEach((c) => { clips[c].preload = 'auto'; clips[c].src = sourceFor(c, hevc); });
    }, {rootMargin: LOAD_MARGIN});
    // Off screen a reaction pauses where it is; back on screen it plays on (the idle clip finishing first if the reaction hadn't
    // started yet), or falls back to idle if it can't play, so the ant never stays stuck and clicks keep working.
    const resume = () => {
      const reaction = busy;
      if (!reaction) { sync(); return; }
      const current = reaction.hasAttribute('data-shown') ? reaction : idle;
      current.play().catch(back(reaction));
    };
    const watch = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      if (seen) { resume(); return; }
      busy?.pause();
      sync();
    });
    load.observe(btn); watch.observe(btn);
    return () => {
      load.disconnect(); watch.disconnect();
      reactions.forEach(([v, fn]) => v.removeEventListener('ended', fn));
      idle.removeEventListener('ended', onIdleEnd);
      idle.removeEventListener('canplay', sync);
      btn.removeEventListener('click', onClick);
      document.removeEventListener('visibilitychange', sync);
      CLIPS.forEach((c) => clips[c].pause());
    };
  }, [button]);
}
