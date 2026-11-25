import {CANCELLED, type Clock} from './clock';
import {blank, complete, currentLifts, drawFlow, hide, liftSlabs, rest, type Beat, type Drawing, type Flow} from './drawing';
import {dropRider, mountRider, placeRider} from './rider';

const BEAT_GAP_MS = 500;      // after each beat
const HOLD_MS = 2500;         // a played step stays before the next one (counting its last beat's gap)
const FADE_MS = 450;          // the next step fades in over the last, then the last fades out
const LIFT_MS = 800;          // the slabs move to their new heights
const LINKS_MS = 300;         // the links step back before a turn, and come back after it
const CLEAR_MS = 350;         // a step played again fades out first, then waits blank
const LEAD_STAGGER_MS = 120;  // the parts a beat shows before its flows
const FLOW_STAGGER_MS = 220;  // flows of one group start this far apart
const RIDE_MS = 2000;         // an amount's trip along its flow: slow enough to follow
const RIDE_HOLD_MS = 500;     // it stays where it lands before it goes
const flowDuration = (length: number) => Math.max(900, Math.min(1200, 700 + length * 0.8));
const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p));

export type CycleEvents = {
  /** The step on show changed. */
  step(k: number): void;
  /** A step is fading out under the one on show (null once it has gone). */
  leaving(k: number | null): void;
  /** The step's window shows its blocks up to `beat` (-1: none); `instant` skips the blocks' fade (the window is hidden). */
  beat(k: number, beat: number, instant: boolean): void;
  /** How much of step k has played, 0..1. */
  progress(k: number, p: number): void;
};

export type StepCycle = {
  /** The board came on screen, or left it. Starts the loop the first time; a held step loops again once it has left and come back. */
  setSeen(seen: boolean): void;
  /** Show step k and play it once, then hold it (a click on its point). */
  select(k: number): void;
};

/** The loop over the steps: each step plays its beats in order, holds, then hands over to the next. */
export function createStepCycle(drawings: Drawing[], clock: Clock, still: boolean, on: CycleEvents): StepCycle {
  const last = (k: number) => drawings[k].beats.length - 1;
  let cur = 0;
  let seen = false;
  let started = false;
  let held = false;
  let away = false;

  // set at once while out of sight: no part may still be fading when the step fades in
  const instantly = (d: Drawing, fn: () => void) => {
    d.svg.setAttribute('data-instant', '');
    fn();
    d.svg.getBoundingClientRect();
    d.svg.removeAttribute('data-instant');
  };
  const show = (k: number) => {
    cur = k;
    on.step(k);
    drawings.forEach((_, i) => on.progress(i, i < k ? 1 : 0));
  };
  const hideBeats = (d: Drawing) => d.beats.forEach((bt) => [...bt.group.children].forEach((el) => hide(el, true)));

  let along = 0;
  const advance = (k: number, b: number, e: number) => { along = Math.max(along, (b + e) / drawings[k].beats.length); on.progress(k, along); };

  const drawOne = async (f: Flow, onFrame: (e: number) => void) => {
    const rider = f.pill ? mountRider(f.pill, f.dot) : null;
    const put = (at: DOMPoint) => {
      if (rider) placeRider(rider, at);
      else { f.dot.setAttribute('cx', String(at.x)); f.dot.setAttribute('cy', String(at.y)); }
    };
    put(f.path.getPointAtLength(0));
    if (rider) rider.g.getBoundingClientRect();   // so it fades in where it starts
    hide(f.path, false); hide(rider?.g ?? f.dot, false);
    try {
      await clock.tween(rider ? RIDE_MS : flowDuration(f.length), (p) => {
        const e = ease(p);
        drawFlow(f, e); onFrame(e);
        put(f.path.getPointAtLength(f.length * e));
        f.hops.forEach((hp) => e >= hp.at && hide(hp.el, false));
      });
      if (rider) await clock.tween(RIDE_HOLD_MS);
    } finally {
      if (rider) dropRider(rider);
    }
    hide(f.dot, true);
    [...f.hops.map((hp) => hp.el), ...f.after].forEach((el) => hide(el, false));
  };
  const playBeat = async (k: number, b: number) => {
    const bt: Beat = drawings[k].beats[b];
    on.beat(k, b, false);
    advance(k, b, 0);
    for (const [i, el] of bt.lead.entries()) { hide(el, false); if (i < bt.lead.length - 1) await clock.tween(LEAD_STAGGER_MS); }
    for (const [j, group] of bt.groups.entries()) {
      await Promise.all(group.map(async (f, i) => {
        if (i) await clock.tween(FLOW_STAGGER_MS * i);
        await drawOne(f, (e) => advance(k, b, (j + e) / bt.groups.length));
      }));
    }
    advance(k, b, 1);
  };
  const play = async (k: number) => {
    const d = drawings[k];
    along = 0; on.progress(k, 0);
    if (d.beats.some((bt) => [...bt.group.children].some((el) => !el.hasAttribute('data-hidden')))) {
      hideBeats(d);
      on.beat(k, -1, false);
      await clock.tween(CLEAR_MS);
    }
    blank(d);
    await clock.tween(CLEAR_MS);
    for (let b = 0; b <= last(k); b++) { await playBeat(k, b); await clock.tween(BEAT_GAP_MS); }
  };
  const glide = (d: Drawing, from: number[]) => clock.tween(LIFT_MS, (p) => liftSlabs(d, from.map((v) => v * (1 - ease(p)))));
  // a to b: a's flows and links step back, b fades in over a with its slabs where a had them, a fades out, the slabs move, the links return
  const turn = async (a: number, b: number) => {
    const A = drawings[a];
    const B = drawings[b];
    hideBeats(A);
    A.links.forEach((el) => hide(el, true));
    await clock.tween(LINKS_MS);
    const now = currentLifts(A);
    const from = B.slabs.map((s, i) => s.lifts[a] - s.lifts[b] + (now[i] ?? 0));
    instantly(B, () => { blank(B); rest(B, from, false); });
    on.beat(b, -1, true);
    show(b); on.leaving(a);
    await clock.tween(FADE_MS);
    on.leaving(null);
    await clock.tween(FADE_MS);
    if (from.some(Boolean)) await glide(B, from);
    rest(B);
    await clock.tween(LINKS_MS);
  };
  const settle = async (k: number) => {
    const d = drawings[k];
    const from = currentLifts(d);
    show(k);
    if (from.some(Boolean)) await glide(d, from);
    rest(d);
  };
  const run = async (start: number, loop: boolean) => {
    clock.cancel();
    let k = start;
    try {
      drawings.forEach((d, i) => { if (i !== cur) instantly(d, () => { rest(d); complete(d); }); });
      drawings.forEach((_, i) => i !== cur && on.beat(i, last(i), true));
      if (k !== cur) await turn(cur, k); else await settle(k);
      for (;;) {
        await play(k);
        if (!loop) return;
        await clock.tween(HOLD_MS - BEAT_GAP_MS);
        const next = (k + 1) % drawings.length;
        await turn(k, next);
        k = next;
      }
    } catch (err) {
      if (err !== CANCELLED) throw err;
    }
  };

  if (!still) {
    instantly(drawings[0], () => blank(drawings[0]));
    on.beat(0, -1, true);
  }
  return {
    setSeen(next) {
      const was = seen;
      seen = next;
      if (still) return;
      if (!seen) { away = started; return; }
      if (was) return;
      if (!started) { started = true; void run(0, true); }
      else if (held && away) { held = false; void run(cur, true); }
    },
    select(k) {
      if (still) {
        drawings.forEach((d) => { rest(d); complete(d); });
        drawings.forEach((_, i) => on.beat(i, last(i), true));
        show(k); on.progress(k, 1);
        return;
      }
      held = true; away = false; started = true;
      void run(k, false);
    },
  };
}
