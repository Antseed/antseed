import {isDarkTheme, onThemeChange} from '../../../../lib/theme';
import {SEED_H, SEED_W, type Hand} from '../seed/hand';
import {AntennaSway, loadArt, type Art} from './art';
import {drawAnt, drawRim} from './draw';
import {Eyes} from './eyes';
import {Feeding} from './feeding';
import {Leaves} from './leaves';
import {RIG, TUNING} from './rig';

/* The mascot at the card's bottom right, its legs cut off by the bottom edge. Its eyes follow the pointer within its corner; when the
   seed is held near it, its mouth opens and its arms reach for it; at its mouth it takes the seed and eats it (see Feeding). Drawn at
   24 frames a second and only when something changed. */

const SHOW_SPEED = 10;          // fade in
const WATCH_SPEED = 8;
const MIN_SHARE = 0.6;          // narrower than this share of its width it hides rather than crowd the install block
const CLEAR = 16;               // px kept between it and the install block
const SNAP = 0.004;
const GROUND = {left: 38, bottom: 20};   // the seed on the ground: px left of the mascot, px above the card's bottom

export type SceneEls = {
  card: HTMLElement; puppet: HTMLCanvasElement; fore: HTMLCanvasElement; groundSeed: HTMLElement; cursor: HTMLElement; install: HTMLElement;
  paint: HTMLElement; night: HTMLElement; film: HTMLVideoElement | null; seedImage: () => HTMLImageElement | null;
};
export type SceneClasses = {seeding: string; overUi: string; empty: string; groundOn: string; groundTaken: string; lifting: string};

const ease = (dt: number, speed: number) => 1 - Math.exp(-dt * speed);
const wrap = (d: number) => ((d % 360) + 360) % 360;

/** How far (deg, counter-clockwise from rest) an arm turns to point at (x, y), within its lift; past the far end, the nearer end. */
function aim(i: number, x: number, y: number): number {
  const arm = RIG.arms[i];
  const lift = TUNING.armLift;
  const d = wrap(arm.rest - Math.atan2(y - arm.shoulder[1], x - arm.shoulder[0]) * 180 / Math.PI);
  return d <= lift ? d : d < lift + (360 - lift) / 2 ? lift : 0;
}

export class MascotScene {
  private readonly pc: CanvasRenderingContext2D;
  private readonly layer = document.createElement('canvas').getContext('2d')!;
  private readonly rim = document.createElement('canvas').getContext('2d')!;
  private readonly leaves: Leaves;
  private readonly eyes = new Eyes();
  private readonly feeding: Feeding;
  private art: Art | null = null;
  private sway: AntennaSway | null = null;
  private look = {x: 0, y: 0, on: false, panel: false};
  private lifts = RIG.arms.map(() => 0);
  private shown = 0; private awake = 0; private gape = 0; private watching = 0;
  private last = performance.now(); private raf = 0; private active = false;
  private drawn = ''; private rimKey = '';
  private readonly abort = new AbortController();
  private readonly stopThemeWatch: () => void;

  constructor(private readonly els: SceneEls, private readonly hand: Hand, private readonly cls: SceneClasses, private readonly still: boolean) {
    this.pc = els.puppet.getContext('2d')!;
    this.leaves = new Leaves({fore: els.fore, paint: els.paint, night: els.night, film: els.film, puppet: els.puppet}, still);
    const signal = this.abort.signal;
    this.feeding = new Feeding(els, hand, cls, signal);
    window.addEventListener('pointermove', this.onPointer, {passive: true, signal});
    document.documentElement.addEventListener('pointerleave', () => { this.look.on = false; }, {signal});
    this.stopThemeWatch = onThemeChange(() => this.leaves.queue());
    loadArt().then((art) => {
      if (signal.aborted || !art) return;
      this.art = art;
      if (!still) this.sway = new AntennaSway(art.body);
      this.wake();
    });
  }

  setActive(on: boolean): void { this.active = on; if (on) { this.wake(); this.leaves.queue(); } }

  dispose(): void {
    this.abort.abort(); this.stopThemeWatch(); cancelAnimationFrame(this.raf); this.leaves.dispose();
    this.pc.setTransform(1, 0, 0, 1, 0, 0); this.pc.clearRect(0, 0, this.els.puppet.width, this.els.puppet.height);
  }

  private onPointer = (e: PointerEvent) => {
    const r = this.els.card.getBoundingClientRect();
    this.look = {x: e.clientX - r.left, y: e.clientY - r.top, on: true, panel: this.els.install.contains(e.target as Node)};
    this.feeding.tryCatch(performance.now(), this.look, this.canHold());
  };

  private wake() { if (!this.raf && this.active && this.art) this.raf = requestAnimationFrame(this.frame); }

  private canHold(): boolean {
    const {card} = this.els;
    return !this.still && !!this.els.puppet.offsetParent && this.shown > 0.9 && !this.hand.empty && !this.feeding.eating && this.look.on
      && !this.look.panel && card.classList.contains(this.cls.seeding) && !card.classList.contains(this.cls.overUi);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.active) return;
    this.wake();
    const step = 1000 / TUNING.fps;
    if (now - this.last < step - 2) return;
    const dt = Math.min(Math.max(64, step * 1.5), now - this.last) / 1000; this.last = now;
    this.tick(now, dt);
  };

  private tick(now: number, dt: number) {
    const art = this.art!;
    const {card, puppet, install} = this.els;
    const W = card.clientWidth;
    const H = card.clientHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (puppet.width !== Math.round(W * dpr) || puppet.height !== Math.round(H * dpr)) { puppet.width = Math.round(W * dpr); puppet.height = Math.round(H * dpr); this.drawn = ''; }

    // its width and spot: slid right past the edge (a quarter at most), then made smaller to clear the install block
    const [bx0, by0, bx1, by1] = RIG.bounds;
    const space = W - (install.getBoundingClientRect().right - card.getBoundingClientRect().left) - CLEAR;
    let w = TUNING.width;
    let right = Math.min(TUNING.inset, space - w);
    if (right < -w / 4) { w = space / 0.75; right = -w / 4; }
    const k = w / (bx1 - bx0);
    // the frame's origin, mirrored
    const fx = W - right + bx0 * k;
    const fy = H + TUNING.crop * (by1 - by0) * k - by1 * k;
    this.shown += ((w >= TUNING.width * MIN_SHARE ? 1 : 0) - this.shown) * ease(dt, SHOW_SPEED);
    this.leaves.update({fx, fy, k, shown: this.shown});
    if (this.shown <= 0.01) {
      if (this.drawn !== 'gone') { this.drawn = 'gone'; this.pc.setTransform(1, 0, 0, 1, 0, 0); this.pc.clearRect(0, 0, puppet.width, puppet.height); }
      return;
    }

    const px = -(this.look.x - fx) / k;
    const py = (this.look.y - fy) / k;   // the pointer in the art's px
    const mouthX = fx - RIG.mouth[0] * k;
    const mouthY = fy + RIG.mouth[1] * k;
    const holding = this.canHold();
    this.feeding.setMouth(mouthX, mouthY, !this.still && !!puppet.offsetParent && this.shown > 0.9);
    this.feeding.tryCatch(now, this.look, holding);
    const meal = this.feeding.step(now);

    // its corner, a little more than the first screen's lower right quarter: it watches there; holding the seed, it reaches
    const nav = parseFloat(getComputedStyle(card).getPropertyValue('--site-nav-height')) || 0;
    const zone = this.look.on && !this.still && this.look.x >= W * TUNING.zone[0] && this.look.y + nav >= (H + nav) * TUNING.zone[1];
    const near = holding && zone;
    const speed = near ? TUNING.armSpeed : TUNING.armSpeed * 2;   // the mouth shuts twice as fast as it opens
    this.watching += ((zone ? 1 : 0) - this.watching) * ease(dt, WATCH_SPEED);
    this.awake += ((near ? 1 : 0) - this.awake) * ease(dt, speed);
    if (Math.abs((near ? 1 : 0) - this.awake) < SNAP) this.awake = near ? 1 : 0;
    this.gape += (this.awake - this.gape) * ease(dt, speed);
    if (Math.abs(this.awake - this.gape) < SNAP) this.gape = this.awake;
    this.lifts = this.lifts.map((l, i) => l + ((near ? aim(i, px, py) : 0) - l) * ease(dt, TUNING.armSpeed));

    const bridge = [(RIG.eyes[0].x + RIG.eyes[1].x) / 2, (RIG.eyes[0].y + RIG.eyes[1].y) / 2];
    const cross = meal ? 1 : holding ? Math.max(0, 1 - Math.hypot(px - bridge[0], py - bridge[1]) * k / TUNING.squintReach) : 0;
    const target: [number, number] = meal ? [RIG.mouth[0], RIG.mouth[1]] : [px, py];
    const irises = this.eyes.step(now, dt, {target, looking: this.look.on || !!meal, cross, attention: meal || cross > 0 ? 1 : Math.max(this.awake, this.watching), awake: this.awake});
    const open = meal ? meal.open : this.gape;

    this.feeding.placeGround(Math.round(fx - bx1 * k - GROUND.left - SEED_W / 2), Math.round(H - GROUND.bottom - SEED_H));
    const tips = this.sway ? AntennaSway.tips(now) : [];
    const sig = [W, H, fx, fy, k, this.shown, open, meal?.fly ?? -1, ...irises.flat(), ...this.lifts, ...tips].map((v) => Math.round(v * 20)).join();
    if (sig === this.drawn && !this.feeding.busy) return;
    this.drawn = sig;
    this.draw(art, {fx, fy, k, w, dpr, W, H}, {body: this.sway ? this.sway.bend(tips) : art.body, irises, open, lifts: this.lifts}, tips);
    this.feeding.drawOver(this.pc, dt, meal?.fly ?? -1, mouthX, mouthY, this.els.seedImage());
    if (isDarkTheme()) this.leaves.queue();   // the night's leaves are kept to the mascot as drawn
  }

  // the ant on a layer of its own square (so the rim follows its outline), laid on the page faded by `shown`, then its rim
  private draw(art: Art, at: {fx: number; fy: number; k: number; w: number; dpr: number; W: number; H: number}, pose: Parameters<typeof drawAnt>[2], tips: number[]) {
    const {fx, fy, k, w, dpr, W, H} = at;
    const pc = this.pc;
    const lay = this.layer;
    pc.setTransform(dpr, 0, 0, dpr, 0, 0); pc.clearRect(0, 0, W, H);
    const size = RIG.size * k;
    const x0 = Math.max(0, Math.floor(fx - size));
    const y0 = Math.max(0, Math.floor(fy));
    const bw = Math.max(1, Math.min(W, Math.ceil(fx)) - x0);
    const bh = Math.max(1, Math.min(H, Math.ceil(fy + size)) - y0);
    for (const c of [lay.canvas, this.rim.canvas]) {
      const cw = Math.round(bw * dpr);
      const ch = Math.round(bh * dpr);
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    }
    lay.setTransform(dpr, 0, 0, dpr, -x0 * dpr, -y0 * dpr); lay.clearRect(x0, y0, bw, bh); lay.imageSmoothingQuality = 'high';
    lay.save(); lay.translate(fx, fy); lay.scale(-k, k);
    drawAnt(lay, art, pose, 1);
    lay.restore();
    pc.globalAlpha = this.shown; pc.drawImage(lay.canvas, x0, y0, bw, bh);
    const unit = w / TUNING.shade.at * dpr;
    const key = [lay.canvas.width, lay.canvas.height, unit, fx % 1, fy % 1, ...this.lifts, ...tips].map((v) => v.toFixed(2)).join();
    if (key !== this.rimKey) { this.rimKey = key; drawRim(this.rim, lay.canvas, unit); }
    pc.globalCompositeOperation = 'lighter'; pc.globalAlpha = TUNING.rimAlpha * this.shown; pc.drawImage(this.rim.canvas, x0, y0, bw, bh);
    pc.globalCompositeOperation = 'source-over'; pc.globalAlpha = 1;
  }
}
