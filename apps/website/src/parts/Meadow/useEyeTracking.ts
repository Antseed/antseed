import {useEffect, useRef, type RefObject} from 'react';
import {useFrameLoop} from '../../lib/useFrameLoop';
import type {EyeSet, EyeNode} from './AntEyes';
import type {Phase} from './eyeKit';

const REACH = 300;          // px from an ant at which its pupils go all the way
const EASE = 0.15;          // share of the way per 60th of a second
const FRAME_MS = 1000 / 60;
const FILM_WIDTH = 1920;
const FILM_HEIGHT = 1080;

type Look = {x: number; y: number; weight: number};
type Clock = {fps: number; frames: number};
type FilmWithClock = HTMLVideoElement & {shownTime?: number};

/** The film frame on screen: the one last handed to the compositor where the browser reports it, else the media clock. */
function useFilmClock(films: Record<Phase, RefObject<HTMLVideoElement | null>>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let live = true;
    const cleanups = Object.values(films).map((ref) => {
      const v = ref.current as FilmWithClock | null;
      if (!v || !('requestVideoFrameCallback' in v)) return () => {};
      const shown = (_: number, meta: VideoFrameCallbackMetadata) => { if (!live) return; v.shownTime = meta.mediaTime; v.requestVideoFrameCallback(shown); };
      const handle = v.requestVideoFrameCallback(shown);
      const seeking = () => { v.shownTime = undefined; };
      v.addEventListener('seeking', seeking);
      return () => { v.cancelVideoFrameCallback(handle); v.removeEventListener('seeking', seeking); };
    });
    return () => { live = false; cleanups.forEach((c) => c()); };
  }, [films, active]);
}

const frameOf = (v: FilmWithClock | null, {fps, frames}: Clock): number => {
  if (!v) return 0;
  const f = v.shownTime !== undefined ? Math.round(v.shownTime * fps) : Math.floor(v.currentTime * fps + 1e-3);
  return ((f % frames) + frames) % frames;
};

function moveEye(e: EyeNode, look: Look, frame: number): void {
  const t = `translate(${(look.weight * (e.travel[0] * look.x - e.rest[0]) * 100).toFixed(2)}%, ${(look.weight * (e.travel[1] * look.y - e.rest[1]) * 100).toFixed(2)}%)`;
  if (t !== e.transform) e.pupil.style.transform = e.transform = t;
  const blink = e.blinks[frame];
  if (blink === e.blinkState) return;
  e.blinkState = blink;
  if (blink) e.lid.style.backgroundPosition = e.lids[blink - 1];
  e.lid.style.opacity = blink ? '1' : '0';
}

/**
 * The ants' pupils ease toward the pointer, each pair in its ellipse, and back to their painted place when the pointer leaves the
 * window; the lids replay the film's blinks on its clock. Both themes' sets move together so a theme flip finds the other one current.
 */
export function useEyeTracking(sets: RefObject<Partial<Record<Phase, EyeSet>>>, films: Record<Phase, RefObject<HTMLVideoElement | null>>,
  clock: Clock | null, antCount: number, active: boolean): void {
  const pointer = useRef({x: 0, y: 0, inside: false});
  const looks = useRef<Look[]>([]);
  const last = useRef(0);

  useEffect(() => {
    if (!active) return;
    const move = (e: PointerEvent) => { if (e.pointerType !== 'touch') pointer.current = {x: e.clientX, y: e.clientY, inside: true}; };
    const out = (e: PointerEvent) => { if (!e.relatedTarget) pointer.current.inside = false; };
    const blur = () => { pointer.current.inside = false; };
    window.addEventListener('pointermove', move, {passive: true});
    window.addEventListener('pointerout', out, {passive: true});
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerout', out);
      window.removeEventListener('blur', blur);
    };
  }, [active]);

  useFilmClock(films, active);

  useFrameLoop(active && clock !== null, (now) => {
    const live = [sets.current?.day, sets.current?.night].filter((s): s is EyeSet => !!s);
    if (!live.length || !clock) { last.current = 0; return; }
    const k = 1 - Math.pow(1 - EASE, (last.current ? Math.min(now - last.current, 100) : FRAME_MS) / FRAME_MS);
    last.current = now;
    const box = live[0].frame.getBoundingClientRect();   // read once, before any write
    const sx = box.width / FILM_WIDTH;
    const sy = box.height / FILM_HEIGHT;
    const p = pointer.current;
    while (looks.current.length < antCount) looks.current.push({x: 0, y: 0, weight: 0});
    looks.current.forEach((look, a) => {
      if (!p.inside) { look.weight -= look.weight * k; if (look.weight < 1e-3) look.weight = 0; return; }
      const [ax, ay] = live[0].ants[a];
      const dx = p.x - (box.left + ax * sx);
      const dy = p.y - (box.top + ay * sy);
      const d = Math.hypot(dx, dy) || 1;
      const m = Math.min(1, d / REACH);
      const tx = (dx / d) * m;
      const ty = (dy / d) * m;
      if (look.weight < 0.01) { look.x = tx; look.y = ty; } else { look.x += (tx - look.x) * k; look.y += (ty - look.y) * k; }
      look.weight = Math.min(1, look.weight + (1 - look.weight) * k);
    });
    for (const [phase, set] of [['day', sets.current?.day], ['night', sets.current?.night]] as const) {
      if (!set) continue;
      const frame = frameOf(films[phase].current, clock);
      for (const eye of set.eyes) moveEye(eye, looks.current[eye.ant], frame);
    }
  });
}
