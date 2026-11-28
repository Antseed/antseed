import {RIG, TUNING} from './rig.ts';

const CLEAR = 16;               // px kept between it and the install block

/** A box in the card's px. `install` is null where the block is hidden (a phone). */
type Box = {left: number; top: number; right: number; bottom: number};
export type Room = {W: number; H: number; title: Box; install: Box | null};

/**
 * The mascot's width and its right edge from the card's right (CSS px), and whether it has room enough to show. Beside the install
 * block it slides right past the edge (a quarter at most, a third where that is the only way to show it), then gets smaller to clear it; where it is under the title, its antennae
 * stay below the title's box; and under all the text it sits wherever that leaves it more room (a tablet's or a phone's tall card).
 */
export function fit({W, H, title, install}: Room): {w: number; right: number; shows: boolean} {
  const [bx0, by0, bx1, by1] = RIG.bounds;
  const tall = (1 - TUNING.crop) * (by1 - by0) / (bx1 - bx0);   // its height above the card's bottom, per px of its width
  const natural = Math.min(TUNING.width, W * TUNING.narrowShare);
  const space = install ? W - install.right - CLEAR : W;
  let w = natural;
  let right = Math.min(TUNING.inset, space - w);
  if (right < -w / 4) { w = space / 0.75; right = -w / 4; }
  if (w < natural * TUNING.minShare) { w = space / (2 / 3); right = -w / 3; }   // too small that way (a landscape tablet): a third past the edge
  if (W - right - w < title.right && H - w * tall < title.bottom) { w = (H - title.bottom) / tall; right = Math.min(TUNING.inset, space - w); }
  const under = Math.min(natural, (H - Math.max(title.bottom, install ? install.bottom + CLEAR : 0)) / tall);
  if (under > w) { w = under; right = TUNING.inset; }
  w = Math.max(1, w);
  return {w, right, shows: w >= natural * TUNING.minShare};
}
