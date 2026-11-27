import {useEffect, type RefObject} from 'react';
import {replayAnimation} from '../../../../lib/replayAnimation';
import {AntLine} from './antLine';
import {SEED_W, UI_ATTR, type Hand, type HandClasses} from './hand';

const FOLLOW = 0.3;              // share of the way to the pointer the seed covers each frame
const TILT = 0.5;                // degrees of lean per px the seed trails behind
const GRIP_Y = 44;               // where the hand holds the seed, from its top
// the ants step faster while the pointer moves
const BUSY_FPS = 60;
const IDLE_FPS = 30;
const BUSY_MS = 2000;
const SETTLED = 0.1;             // px: the seed has caught up

type Options = {
  hero: RefObject<HTMLElement | null>;
  cursor: RefObject<HTMLElement | null>;
  hand: Hand;
  classes: HandClasses;
  /** on screen and the tab visible */
  active: boolean;
  still: boolean;
};

/**
 * The cursor over the hero is your request, as a seed: it follows the pointer, easing and leaning, and while it is held still unseen
 * ants queue behind it and take pieces (a small pulse). The loop runs only while the seed is over the card or catching up, on screen,
 * in a visible tab; with reduced motion the seed simply sits under the pointer.
 */
export function useSeedCursor({hero, cursor, hand, classes, active, still}: Options): void {
  useEffect(() => {
    const card = hero.current;
    const seed = cursor.current;
    if (!card || !seed) return;
    const ants = new AntLine();
    const ro = new ResizeObserver(() => ants.layout(card.clientWidth, card.clientHeight));
    ro.observe(card);
    let raf = 0;
    let last = performance.now();
    let lastInput = -Infinity;
    let placed = '';

    const place = () => {
      const at = `translate(${hand.sx - SEED_W / 2}px, ${hand.sy - GRIP_Y}px) rotate(${(hand.x - hand.sx) * TILT}deg)`;
      if (at !== placed) seed.style.transform = placed = at;
    };
    const frame = (now: number) => {
      raf = 0;
      hand.sx += (hand.x - hand.sx) * FOLLOW; hand.sy += (hand.y - hand.sy) * FOLLOW;
      place();
      const fps = now - lastInput < BUSY_MS ? BUSY_FPS : IDLE_FPS;
      if (now - last >= 1000 / fps - 2) {
        const dt = Math.min(64, now - last); last = now;
        if (ants.update(now, dt, hand.on && !hand.empty, hand.sx, hand.sy)) replayAnimation(seed, classes.fed);
      }
      const settled = Math.abs(hand.x - hand.sx) < SETTLED && Math.abs(hand.y - hand.sy) < SETTLED;
      if (hand.on || !settled) raf = requestAnimationFrame(frame);
    };
    const wake = () => { if (!raf && active && !still) { last = performance.now(); raf = requestAnimationFrame(frame); } };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;   // a finger has no cursor: on a touch screen the seed lies on the ground (MascotScene)
      const r = card.getBoundingClientRect();
      hand.x = e.clientX - r.left; hand.y = e.clientY - r.top; lastInput = performance.now();
      if (!hand.on || still) { hand.sx = hand.x; hand.sy = hand.y; }
      hand.on = true;
      hand.overUi = !!(e.target as Element).closest?.(`[${UI_ATTR}]`);
      card.classList.add(classes.seeding);
      card.classList.toggle(classes.overUi, hand.overUi);
      if (still) place(); else wake();
    };
    const onLeave = () => {
      hand.on = false;
      card.classList.remove(classes.seeding, classes.overUi);
      ants.release();
    };
    card.addEventListener('pointermove', onMove, {passive: true});
    card.addEventListener('pointerleave', onLeave);
    if (hand.on) wake();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerleave', onLeave);
    };
  }, [hero, cursor, hand, classes, active, still]);
}
