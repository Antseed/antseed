/* The carriers' walk: each lane is a loop of carried cards that follow one another like cars. The one under the pointer stops and
   looks at you while those behind queue up; a click and it hops, then sprints to close the gap, its queue after it, each with a
   smaller boost. Out of sight a carrier waits for the one behind, so a long hold never leaves a screen-wide gap. All output is
   written to the DOM (transform, background-position); nothing here touches React state. */
import type {Frames, WalkCycle} from './carryGeometry';

export const PACE = 32;                         // px/s, the base lane speed
export const LANE_SPEED = [1, 0.81];            // the second lane a little slower, the other way
export const CARRY_GAP = 36;                    // px between carried cards
const CARRY_PACE = 58 / 32;                     // carriers walk at 58 px/s
const KEEP = 10;                                // the closest a carrier gets to the one ahead, queued
// a click's hop: its length and height
const HOP_S = 0.56;
const HOP_LIFT = 10;
const SETTLE = 0.75;                            // how fast the card settles after a change of pose
const STAND_BELOW = 8;                          // px/s under which a carrier stands still
const MAX_DT = 0.05;
const VIEW_EVERY_MS = 1000;

export type CarrierEl = {card: HTMLElement; back: HTMLElement; hand: HTMLElement; shade: HTMLElement; frames: Frames; phase: number};

type Walker = CarrierEl & {x: number; v: number; pop: number; wp: number; frame: number; gait: number; lift: number; drift: number;
  stopped: boolean; boost: number; boostAt: number};

type Lane = {el: HTMLElement; size: number; t: number; left: number; right: number; loop: number; dir: 1 | -1; V: number;
  held: Walker | null; offset: number; walkers: Walker[]};

export type LaneSetup = {el: HTMLElement; index: number; size: number; offset: number; carriers: CarrierEl[]};

const frameAt = (c: WalkCycle, d: number) => { let n = c.from.length - 1; while (n && c.from[n] > d) n--; return n; };

export function createCarriers(setups: LaneSetup[]) {
  const lanes: Lane[] = setups.map(({el, index, size, offset, carriers}) => {
    const step = size + CARRY_GAP;
    const V = PACE * CARRY_PACE * LANE_SPEED[index];
    return {el, size, t: 0, left: 0, right: 0, loop: carriers.length * step, dir: index ? -1 : 1, V, held: null, offset,
      walkers: carriers.map((c, i) => ({...c, x: i * step, v: V, pop: 0, wp: c.phase * c.frames.walk.length, frame: -1, gait: -1,
        lift: 0, drift: 0, stopped: false, boost: 0, boostAt: 0}))};
  });

  // the part of each lane on screen, in the lane's own px
  const measure = () => { for (const ln of lanes) { const l = ln.el.getBoundingClientRect().left; ln.left = -l; ln.right = innerWidth - l; } };
  const outOfSight = (ln: Lane, x: number) => { const X = x - ln.size + ln.offset; return X - ln.size > ln.right + 8 || X + ln.size < ln.left - 8; };
  const gap = (ln: Lane, a: Walker, b: Walker) => ((ln.dir < 0 ? a.x - b.x : b.x - a.x) % ln.loop + ln.loop) % ln.loop - ln.size;

  const step = (ln: Lane, dt: number) => {
    ln.t += dt;
    const n = ln.walkers.length;
    const V = ln.V;
    const back = ln.dir < 0 ? 1 : n - 1;
    const fwd = ln.dir < 0 ? n - 1 : 1;
    ln.walkers.forEach((a, i) => {
      const stop = a === ln.held || a.pop > 0;
      if (a.stopped && !stop) {   // let go or landed: it sprints, and its queue after it
        a.boost = 1; a.boostAt = ln.t;
        for (let m = 1, k = i; m < n; m++, k = (k + back) % n) {
          const f = ln.walkers[(k + back) % n];
          if (gap(ln, f, ln.walkers[k]) > KEEP + 14) break;
          f.boost = Math.max(f.boost, Math.max(0.2, 1 - 0.15 * m)); f.boostAt = ln.t;
        }
      }
      a.stopped = stop;
    });
    ln.walkers.forEach((a, i) => {
      const ahead = ln.walkers[(i + fwd) % n];
      const after = ln.walkers[(i + back) % n];
      const stop = a === ln.held || a.pop > 0;
      const g = gap(ln, a, ahead);
      if (a.pop > 0) a.pop -= dt;
      let want = 0;
      if (!stop) {
        const aim = KEEP + (CARRY_GAP - KEEP) * Math.min(1, ahead.v / V);
        want = Math.max(0, Math.min(V * (1 + a.boost), ahead.v + (g - aim) * 2));
        if (outOfSight(ln, a.x)) want = Math.min(want, V * Math.max(0, Math.min(1, 1 - (gap(ln, after, a) - CARRY_GAP) / 60)));
      }
      a.v += (want - a.v) * Math.min(1, dt * (stop ? 12 : want < a.v ? 8 : 5));
      a.v = Math.max(0, Math.min(a.v, (g - 4) / dt));
      if (a.boost && ln.t - a.boostAt > 0.8 && ((g < CARRY_GAP + 4 && a.v > 0.97 * V) || ln.t - a.boostAt > 40)) a.boost = 0;
      a.x = ((a.x + ln.dir * a.v * dt) % ln.loop + ln.loop) % ln.loop;
      a.wp = (a.wp + a.v * dt * (a.v > 1.1 * V ? 1.5 : 1)) % a.frames.walk.length;   // hurrying: short quick steps
    });
  };

  // the sprite frame (hop, look, stand or the walk's), the card's ride on it, and the shadow kept on the ground
  const pose = (ln: Lane, a: Walker) => {
    const F = a.frames;
    let frame: number;
    let bounce = 0;
    if (a.pop > 0) {
      const t = 1 - a.pop / HOP_S;
      if (t < 0.72) { frame = F.hop; bounce = HOP_LIFT * Math.sin(Math.PI * t / 0.72); }
      else { frame = F.stand; bounce = 3 * Math.sin(Math.PI * (t - 0.72) / 0.28); }
    } else if (a === ln.held) frame = F.look;
    else if (a.v < STAND_BELOW) frame = F.stand;
    else frame = frameAt(F.walk, a.wp);
    if (frame !== a.frame) { a.frame = frame; a.back.style.backgroundPosition = F.back[frame]; a.hand.style.backgroundPosition = F.hand[frame]; }
    const gait = frame < F.walkFrames ? 0 : frame < F.stand ? 1 : frame;
    if (gait !== a.gait) { if (a.gait >= 0) a.drift = a.lift - F.lift[frame]; a.gait = gait; }
    a.drift *= SETTLE;
    a.lift = F.lift[frame] + a.drift;
    a.card.style.transform = `translate(${(a.x - ln.size + ln.offset).toFixed(1)}px, ${(-a.lift - bounce).toFixed(1)}px)`;
    const up = bounce / HOP_LIFT;
    a.shade.style.transform = `translateY(${(a.lift + bounce).toFixed(1)}px) scale(${(1 - 0.2 * up).toFixed(3)})`;
    a.shade.style.opacity = (1 - 0.35 * up).toFixed(2);
  };

  let lastView = 0;
  const draw = () => { for (const ln of lanes) for (const a of ln.walkers) pose(ln, a); };
  measure(); draw();

  return {
    /** Advance by the time since the last frame (seconds, capped) and draw. */
    tick(now: number, dt: number) {
      if (now - lastView > VIEW_EVERY_MS) { lastView = now; measure(); }
      for (const ln of lanes) step(ln, Math.min(MAX_DT, dt));
      draw();
    },
    measure,
    /** The card under a moving mouse pointer stops; null lets it go. */
    hold(laneIndex: number, card: Element | null) {
      const ln = lanes[laneIndex];
      if (ln) ln.held = ln.walkers.find((a) => a.card === card) ?? null;
    },
    hop(laneIndex: number, card: Element | null) {
      const ln = lanes[laneIndex];
      const a = ln?.walkers.find((w) => w.card === card);
      if (!ln || !a) return;
      if (ln.held === a) ln.held = null;
      a.pop = HOP_S;
    },
  };
}

export type Carriers = ReturnType<typeof createCarriers>;
