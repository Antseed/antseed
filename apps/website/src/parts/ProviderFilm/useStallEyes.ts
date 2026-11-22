import {useEffect, type RefObject} from 'react';
import {PUPILS, pupilTransform} from './scenes';

const REACH = 260;   // px from the ant at which its pupils go all the way
const EASE = 0.12;   // share of the way per 60th of a second
const FRAME = 1000 / 60;

/** The stall ant's pupils ease toward a mouse pointer and back to where they are painted when it leaves. Listens only while `active`
 *  (a mouse, on screen, tab visible, motion allowed); the rAF runs only while the pupils are moving. */
export function useStallEyes(root: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = root.current;
    if (!el || !active) return;
    const eyes = [...el.querySelectorAll<HTMLElement>('[data-eye]')];
    const pupils = eyes.map((eye, k) => ({b: eye.firstElementChild as HTMLElement, ...PUPILS[k % 2], t: ''}));
    if (!eyes.length) return;
    const look = {x: 0, y: 0, w: 0};
    let px = 0;
    let py = 0;
    let here = false;
    let raf = 0;
    let last = 0;

    const centre = () => {
      const shown = eyes.filter((e) => e.checkVisibility?.({visibilityProperty: true}) ?? true);
      const [a, b] = (shown.length >= 2 ? shown : eyes).map((e) => e.getBoundingClientRect());
      return {x: (a.left + a.right + b.left + b.right) / 4, y: (a.top + a.bottom + b.top + b.bottom) / 4};
    };
    const tick = (now: number) => {
      raf = 0;
      const k = 1 - Math.pow(1 - EASE, (last ? Math.min(now - last, 100) : FRAME) / FRAME);
      last = now;
      if (!here) {
        look.w -= look.w * k;
        if (look.w < 1e-3) look.w = 0;
      } else {
        const c = centre();
        const dx = px - c.x;
        const dy = py - c.y;
        const d = Math.hypot(dx, dy) || 1;
        const m = Math.min(1, d / REACH);
        const tx = (dx / d) * m;
        const ty = (dy / d) * m;
        if (look.w < 0.01) { look.x = tx; look.y = ty; } else { look.x += (tx - look.x) * k; look.y += (ty - look.y) * k; }
        look.w += (1 - look.w) * k;
        if (look.w > 0.999) look.w = 1;
      }
      for (const p of pupils) {
        const t = pupilTransform(p.rest[0] + look.w * (p.travel[0] * look.x - p.rest[0]), p.rest[1] + look.w * (p.travel[1] * look.y - p.rest[1]));
        if (t !== p.t) p.b.style.transform = p.t = t;
      }
      if (here || look.w) raf = requestAnimationFrame(tick); else last = 0;
    };
    const wake = () => { if (!raf) raf = requestAnimationFrame(tick); };
    const onMove = (e: PointerEvent) => { if (e.pointerType === 'touch') return; px = e.clientX; py = e.clientY; here = true; wake(); };
    const onOut = (e: PointerEvent) => { if (!e.relatedTarget) { here = false; wake(); } };
    const onBlur = () => { here = false; wake(); };
    window.addEventListener('pointermove', onMove, {passive: true});
    window.addEventListener('pointerout', onOut, {passive: true});
    window.addEventListener('blur', onBlur);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', onOut);
      window.removeEventListener('blur', onBlur);
    };
  }, [root, active]);
}
