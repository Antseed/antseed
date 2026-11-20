import {useEffect, type RefObject} from 'react';
import {isStill} from '../motion';
import {useFinePointer} from '../useFinePointer';
import {LED_PITCH, canvasDpr, paintingUrl} from '../ledGrid';
import {isDarkTheme, onThemeChange} from '../theme';
import {readPaintingCells} from './paintingCells';
import {TrailField} from './trailField';

/** Seconds for the trail's heat to halve. */
const HALF_LIFE_S = 0.3;
/** A long frame (tab switch, jank) fades at most this much time at once. */
const MAX_STEP_S = 0.1;

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) {
    const img = new Image();
    img.src = url;
    p = img.decode().then(() => img);
    images.set(url, p);
  }
  return p;
}

/**
 * Where a mouse passes over the painting, it breaks up into LED dots that fade within half a second. Mouse only, never in still mode,
 * and not while the panel's arrival is still playing. The rAF loop runs only while a trail is warm and the panel is on screen.
 */
export function useWashTrail(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  const fine = useFinePointer();
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || !fine || isStill()) return;

    let canvas: HTMLCanvasElement | null = null;
    let field: TrailField | null = null;
    let fieldKey = '';
    let pending: [number, number] | null = null;
    let raf = 0;
    let lastFrame = 0;

    const arrived = () => !el.dataset.unveil;

    async function prepare(): Promise<void> {
      const url = paintingUrl(el!);
      const W = el!.clientWidth;
      const H = el!.clientHeight;
      if (!url || !W || !H) return;
      const key = `${url} ${W}x${H}`;
      if (key === fieldKey) return;
      fieldKey = key;
      field = null;
      const img = await loadImage(url).catch(() => null);
      if (!img || fieldKey !== key) return;
      const night = isDarkTheme();
      const cells = readPaintingCells(el!, img, night);
      if (!cells) return;
      const dpr = canvasDpr();
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        canvas.setAttribute('data-wash-trail', '');
        el!.prepend(canvas);
      }
      canvas.width = Math.round(cells.cols * LED_PITCH * dpr);
      canvas.height = Math.round(cells.rows * LED_PITCH * dpr);
      canvas.style.width = `${cells.cols * LED_PITCH}px`;
      canvas.style.height = `${cells.rows * LED_PITCH}px`;
      const ctx = canvas.getContext('2d');
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--site-surface').trim();
      if (ctx) field = new TrailField(cells, ctx, dpr, paper);
    }

    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0; lastFrame = 0; pending = null;
      field?.clear();
      offscreen.unobserve(el);
    };
    const frame = (now: number) => {
      raf = 0;
      if (!field || document.hidden) return stop();
      if (pending) { field.lay(pending[0], pending[1]); pending = null; }
      const dt = Math.min(MAX_STEP_S, (now - (lastFrame || now)) / 1000);
      lastFrame = now;
      if (field.step(0.5 ** (dt / HALF_LIFE_S))) raf = requestAnimationFrame(frame);
      else { lastFrame = 0; offscreen.unobserve(el); }
    };
    const wake = () => {
      if (raf) return;
      offscreen.observe(el);
      raf = requestAnimationFrame(frame);
    };
    const offscreen = new IntersectionObserver(([e]) => { if (!e.isIntersecting) stop(); });

    const onEnter = (e: PointerEvent) => { if (e.pointerType === 'mouse' && arrived()) void prepare(); };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || !arrived()) return;
      if (!field) { void prepare(); return; }
      // the panel may be scaled by a parent transform: map client px back to its own px
      const b = el.getBoundingClientRect();
      const k = b.width / el.offsetWidth || 1;
      pending = [(e.clientX - b.left) / k, (e.clientY - b.top) / k];
      wake();
    };
    const onLeave = () => field?.lift();

    el.addEventListener('pointerenter', onEnter, {passive: true});
    el.addEventListener('pointermove', onMove, {passive: true});
    el.addEventListener('pointerleave', onLeave, {passive: true});
    // the other theme shows another painting: read it on the next hover
    const unsubscribeTheme = onThemeChange(() => { stop(); field = null; fieldKey = ''; });

    return () => {
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      unsubscribeTheme();
      stop();
      offscreen.disconnect();
      canvas?.remove();
      fieldKey = '';
    };
  }, [ref, enabled, fine]);
}
