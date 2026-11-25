/* Measurements that keep the privacy frame steady: the list held at its tallest state, each screen scaled to its panel, and the room
   the ant needs above the panel. Written as CSS variables on the elements. */

const SCREEN_MIN_SCALE = 0.78;
const SCREEN_AIR_Y = 80;   // painting left above and below a screen, px
const SCREEN_AIR_X = 64;
const ANT_GAP = 8;
const WIDE = '(min-width: 900px)';

/** The list's height with its tallest line open, so neither the tabs nor the panel jump as the choice changes. */
export function fitList(list: HTMLElement): void {
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
  const line = (t: HTMLElement) => t.querySelector<HTMLElement>('[data-line]');
  const open = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
  list.style.removeProperty('--list-height');
  const closed = list.offsetHeight - (open ? line(open)?.offsetHeight ?? 0 : 0);
  const tallest = Math.max(0, ...tabs.map((t) => (line(t)?.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0));
  list.style.setProperty('--list-height', `${Math.ceil(closed + tallest)}px`);
}

/** Scales every screen (`[data-window]`) to fit its panel with painting round it, on wide screens where the panel's height is fixed. */
export function fitScreens(stage: HTMLElement): void {
  const panel = stage.querySelector<HTMLElement>('[data-panel]');
  const wins = [...stage.querySelectorAll<HTMLElement>('[data-window]')];
  if (!panel || !wins.length) return;
  const k = window.matchMedia(WIDE).matches
    ? Math.max(SCREEN_MIN_SCALE, Math.min(1,
      (panel.clientHeight - SCREEN_AIR_Y) / Math.max(...wins.map((w) => w.offsetHeight || 1)),
      (panel.clientWidth - SCREEN_AIR_X) / Math.max(...wins.map((w) => w.offsetWidth || 1))))
    : 1;
  stage.style.setProperty('--screen-scale', k.toFixed(3));
}

/** The room the ant takes above the panel, px. */
export function antRoom(stage: HTMLElement, ant: HTMLElement | null): number {
  return ant ? Math.max(0, Math.ceil(stage.getBoundingClientRect().top - ant.getBoundingClientRect().top) + ANT_GAP) : 160;
}
