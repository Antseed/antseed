import {useEffect, useRef, type RefObject} from 'react';
import {useFrameLoop} from '../../../lib/useFrameLoop';
import {carriedWidth, fitsFor, unitHash} from './carryGeometry';
import {createCarriers, type Carriers, type CarrierEl} from './carriers';

/**
 * Walks the carried cards rendered under `flow` (lanes marked `data-carry-lane`, cards `data-carrier`). `build` changes whenever the
 * lanes are rendered anew (a tab, a card size). The first pose is drawn at once; the walk runs only while `running`.
 */
export function useCarriers(flow: RefObject<HTMLElement | null>, enabled: boolean, running: boolean, side: number, build: string): void {
  const carriers = useRef<Carriers | null>(null);

  useEffect(() => {
    const root = flow.current;
    if (!root || !enabled) return;
    const size = carriedWidth(side);
    const laneEls = [...root.querySelectorAll<HTMLElement>('[data-carry-lane]')];
    const setups = laneEls.map((el, index) => {
      const fits = fitsFor(side, index > 0);
      const offset = Math.max(...fits.map((f) => (index ? f.beyond : f.behind)));
      const cards = [...el.querySelectorAll<HTMLElement>('[data-carrier]')].map((card, i): CarrierEl => {
        const layer = (name: string) => card.querySelector<HTMLElement>(`[data-layer="${name}"]`)!;
        return {card, back: layer('back'), hand: layer('hand'), shade: layer('shade'), frames: fits[Number(card.dataset.carrier)].frames, phase: unitHash(index + 8, i)};
      });
      return {el, index, size, offset, carriers: cards};
    });
    const c = createCarriers(setups);
    carriers.current = c;

    const offs = laneEls.map((el, index) => {
      const cardOf = (e: Event) => (e.target as Element).closest('[data-carrier]');
      // a real move of the mouse, not a card sliding under a still pointer
      const move = (e: PointerEvent) => { if (e.pointerType === 'mouse' && (e.movementX || e.movementY)) c.hold(index, cardOf(e)); };
      const leave = () => c.hold(index, null);
      const click = (e: MouseEvent) => c.hop(index, cardOf(e));
      el.addEventListener('pointermove', move, {passive: true});
      el.addEventListener('pointerleave', leave, {passive: true});
      el.addEventListener('click', click);
      return () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave); el.removeEventListener('click', click); };
    });
    addEventListener('resize', c.measure, {passive: true});
    return () => {
      offs.forEach((off) => off());
      removeEventListener('resize', c.measure);
      carriers.current = null;
    };
  }, [flow, enabled, side, build]);

  const last = useRef(0);
  useFrameLoop(enabled && running, (now) => {
    const dt = last.current ? (now - last.current) / 1000 : 0;
    last.current = now;
    carriers.current?.tick(now, dt);
  });
  useEffect(() => { if (!running) last.current = 0; }, [running]);
}
