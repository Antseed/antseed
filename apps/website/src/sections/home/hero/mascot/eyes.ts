import {RIG, TUNING} from './rig';

const EASE_SPEED = 14;
const JITTER_MS = 45;           // a new tremble this often while awake
const RIM_MARGIN = 5;           // art px between the pupil and its eye white's edge
const LOST_REACH = 0.75;        // the lost look: this share of the way to the rims
const CENTRE_EASE = 60;         // within this many art px of an eye's centre the pupil eases back to the middle
const FAR_TRAVEL = 200;

type Pupil = {x: number; y: number; jx: number; jy: number; jt: number};

export type Gaze = {
  /** where to look, in the art's px */
  target: [number, number];
  /** the pointer is on the page, or it is eating */
  looking: boolean;
  /** 0–1: how cross-eyed it goes on the seed near its nose */
  cross: number;
  /** 0–1: from the lost look at rest to looking at the target */
  attention: number;
  /** 0–1: how excited (the pupils tremble) */
  awake: number;
};

/** The pupils: at rest a lost look, apart and level; attentive, each turns toward the target as far as its eye white lets it, so
 *  with the seed between its eyes they cross of themselves. Awake, they tremble a little. */
export class Eyes {
  private pupils: Pupil[] = RIG.eyes.map(() => ({x: 0, y: 0, jx: 0, jy: 0, jt: 0}));

  step(now: number, dt: number, {target: [tx, ty], looking, cross, attention, awake}: Gaze): [number, number][] {
    const level = (RIG.eyes[0].y + RIG.eyes[1].y) / 2;
    const follow = 1 - Math.exp(-dt * EASE_SPEED);
    return RIG.eyes.map((e, i) => {
      const p = this.pupils[i];
      const dx = tx - e.x;
      const dy = ty - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const travel = looking ? Math.max(TUNING.pupilTravel * Math.min(1, d / FAR_TRAVEL), cross) : 0;
      const restX = RIG.lost[i] * (e.rx - RIG.pupil - RIM_MARGIN) * LOST_REACH;
      const restY = level - e.y;
      const rim = 1 / Math.hypot(dx / d / e.rx, dy / d / e.ry) - RIG.pupil * 0.45;
      const near = Math.min(1, d / CENTRE_EASE);
      const toX = travel ? dx / d * rim * near : restX;
      const toY = travel ? dy / d * rim * near : restY;
      p.x += (restX + (toX - restX) * attention - p.x) * follow;
      p.y += (restY + (toY - restY) * attention - p.y) * follow;
      if (now - p.jt > JITTER_MS) { p.jt = now; p.jx = Math.random() * 2 - 1; p.jy = Math.random() * 2 - 1; }
      return [e.x + p.x + p.jx * TUNING.jitter * awake, e.y + p.y + p.jy * TUNING.jitter * awake];
    });
  }
}
