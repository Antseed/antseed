import {SEED_H, SEED_W, type Hand} from '../seed/hand';
import {loadImage} from './art';
import {TUNING} from './rig';

/* The seed and the mascot. At its mouth it takes the seed: the seed flies in, three bites (the mouth opens and shuts, crumbs of the
   seed's own colours fall), a swallow. The hand is then empty (the system cursor) and a new seed drops on the ground beside it: hover
   grows it, a click lifts it into the hand. A finger has no seed in hand: a tap on the seed on the ground, or on the mascot, feeds it
   that one. The sequence steps at 24 a second, the films' rate. */

const TICK = 1000 / 24;
const GRAVITY = 520;
const LIFT = {duration: 280, easing: 'cubic-bezier(.3, 0, .2, 1)'};
const LIFT_DONE_MS = 300;
const GRIP = 0.5;               // the hand holds the seed this many px above its middle
const CRUMB_SHADES = [0.1, 0.3, 0.5, 0.7, 0.85];

type Crumb = {x: number; y: number; vx: number; vy: number; r: number; rot: number; ink: string; life: number};
type Meal = {start: number; from: [number, number]; bitten: number; size: number};   // size: the seed's width as it sets off
export type MealFrame = {open: number; fly: number};

type Els = {card: HTMLElement; groundSeed: HTMLElement; cursor: HTMLElement};
type Classes = {seeding: string; overUi: string; empty: string; groundOn: string; groundTaken: string; lifting: string};

/** Five inks from the seed's opaque pixels, dark to light. */
function inksOf(seed: HTMLImageElement | null): string[] {
  if (!seed) return ['#8a5a3a'];
  const c = Object.assign(document.createElement('canvas'), {width: 32, height: 44}).getContext('2d', {willReadFrequently: true})!;
  c.drawImage(seed, 0, 0, 32, 44);
  const d = c.getImageData(0, 0, 32, 44).data;
  const px: number[][] = [];
  for (let p = 0; p < d.length; p += 4) if (d[p + 3] > 240) px.push([d[p], d[p + 1], d[p + 2]]);
  if (!px.length) return ['#8a5a3a'];
  px.sort((a, b) => a[0] + a[1] + a[2] - b[0] - b[1] - b[2]);
  return CRUMB_SHADES.map((q) => `rgb(${px[Math.floor(q * (px.length - 1))].join(',')})`);
}

export class Feeding {
  private meal: Meal | null = null;
  private crumbs: Crumb[] = [];
  private inks = ['#8a5a3a'];
  private mouth = {x: 0, y: 0, open: false};
  private touch = false;          // the last press on the card was a finger

  constructor(private readonly els: Els, private readonly hand: Hand, private readonly cls: Classes, signal: AbortSignal) {
    loadImage('/site/assets/hero/seed-day.webp').then((img) => { this.inks = inksOf(img); });
    els.card.addEventListener('pointerdown', (e) => { this.touch = e.pointerType === 'touch'; }, {passive: true, signal});
    els.groundSeed.addEventListener('click', this.lift, {signal});
  }

  /** The last press on the card was a finger. */
  get byTouch(): boolean { return this.touch; }

  get eating(): boolean { return !!this.meal; }
  get busy(): boolean { return this.crumbs.length > 0; }

  setMouth(x: number, y: number, open: boolean): void { this.mouth = {x, y, open}; }

  /** Takes the seed when it is held at the mouth. */
  tryCatch(now: number, at: {x: number; y: number}, holding: boolean): void {
    if (!this.mouth.open || this.meal || !holding || Math.hypot(at.x - this.mouth.x, at.y - this.mouth.y) >= TUNING.catchReach) return;
    this.meal = {start: now, from: [this.hand.sx, this.hand.sy], bitten: 0, size: SEED_W};
    this.setEmpty(true);
  }

  /** The mouth's opening and the seed's flight (0–1, or -1) at `now`, or null when not eating. */
  step(now: number): MealFrame | null {
    const m = this.meal;
    if (!m) return null;
    const {flyMs, chewMs, swallowMs, bites} = TUNING;
    const t = Math.floor((now - m.start) / TICK) * TICK;
    const c = Math.max(0, Math.min(bites, (t - flyMs) / chewMs * bites));
    while (m.bitten < Math.min(bites, Math.floor(c + 0.5))) { m.bitten++; this.spill(); }   // each bite spills as the mouth starts to shut
    if (t < flyMs) return {open: 1, fly: t / flyMs};
    if (t < flyMs + chewMs) { const f = c % 1; return {open: f < 0.5 ? f * 2 : (1 - f) * 2, fly: -1}; }
    if (t < flyMs + chewMs + swallowMs) return {open: 0, fly: -1};
    this.meal = null;
    this.els.groundSeed.classList.add(this.cls.groundOn);
    return null;
  }

  /** Puts the seed on the ground (when it is there) at `left`, `top` in card px. */
  placeGround(left: number, top: number): void {
    const s = this.els.groundSeed.style;
    const l = `${left}px`;
    const t = `${top}px`;
    if (this.els.groundSeed.classList.contains(this.cls.groundOn) && (s.left !== l || s.top !== t)) { s.left = l; s.top = t; }
  }

  /** The seed on its way in, shrinking into the mouth; the crumbs, falling and fading. */
  drawOver(g: CanvasRenderingContext2D, dt: number, fly: number, mx: number, my: number, seed: HTMLImageElement | null): void {
    if (fly >= 0 && seed && this.meal) {
      const e = fly * fly;
      const q = this.meal.size * (1 - 0.8 * e);
      const [fx, fy] = this.meal.from;
      g.save(); g.translate(fx + (mx - fx) * e, fy + (my - fy) * e); g.rotate(Math.PI);
      g.drawImage(seed, -q / 2, -q * SEED_H / (2 * SEED_W), q, q * SEED_H / SEED_W); g.restore();
    }
    this.crumbs = this.crumbs.filter((c) => {
      c.vy += GRAVITY * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.life -= dt;
      if (c.life <= 0) return false;
      g.globalAlpha = Math.min(1, c.life / 0.4); g.fillStyle = c.ink;
      g.beginPath(); g.ellipse(c.x, c.y, c.r, c.r * 0.7, c.rot, 0, Math.PI * 2); g.fill();
      return true;
    });
    g.globalAlpha = 1;
  }

  private spill() {
    const {x, y} = this.mouth;
    for (let i = 0; i < TUNING.crumbs; i++) {
      this.crumbs.push({x: x + (Math.random() - 0.5) * 16, y: y + 4, vx: (Math.random() - 0.5) * 130, vy: 10 - Math.random() * 90,
        r: 1.5 + Math.random() * 2.5, rot: Math.random() * Math.PI, ink: this.inks[Math.floor(Math.random() * this.inks.length)], life: 0.7 + Math.random() * 0.4});
    }
  }

  /** Feeds it the seed on the ground, for a finger: the seed flies from where it lies, and a new one drops in after the meal. */
  feed(now: number): void {
    const {card, groundSeed} = this.els;
    const on = groundSeed.querySelector('img');
    if (!this.mouth.open || this.meal || !on || !groundSeed.classList.contains(this.cls.groundOn) || groundSeed.classList.contains(this.cls.groundTaken)) return;
    const r = card.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    this.meal = {start: now, from: [b.left + b.width / 2 - r.left, b.top + b.height / 2 - r.top], bitten: 0, size: b.width};
    groundSeed.classList.remove(this.cls.groundOn);
  }

  private setEmpty(on: boolean) { this.hand.empty = on; this.els.card.classList.toggle(this.cls.empty, on); }

  // a click lifts the seed into the hand: the held seed starts where this one stands, at its size and with its shadow, and eases onto
  // the pointer; this one goes at once, its shadow left to fade
  private lift = (e: MouseEvent) => {
    const {card, groundSeed, cursor} = this.els;
    const c = this.cls;
    e.stopPropagation();
    if (groundSeed.classList.contains(c.groundTaken)) return;
    if (this.touch && e.detail) { this.feed(performance.now()); return; }   // a finger: nothing to hold, it feeds the mascot
    const r = card.getBoundingClientRect();
    const on = groundSeed.querySelector('img');
    const held = cursor.querySelector('img');
    if (!on || !held) return;
    const b = on.getBoundingClientRect();
    const mid = [b.left + b.width / 2, b.top + b.height / 2];
    const [px, py] = e.detail ? [e.clientX, e.clientY] : mid;   // from the keyboard: the seed's middle
    Object.assign(this.hand, {x: px - r.left, y: py - r.top, sx: mid[0] - r.left, sy: mid[1] - r.top - GRIP, on: true, overUi: false});
    const from = {scale: `${b.height / SEED_H}`, filter: getComputedStyle(on).filter};
    card.classList.add(c.lifting, c.seeding); card.classList.remove(c.overUi);
    groundSeed.classList.add(c.groundTaken);
    this.setEmpty(false);
    held.animate([from, {scale: '1', filter: getComputedStyle(held).filter}], LIFT);
    requestAnimationFrame(() => card.classList.remove(c.lifting));
    window.setTimeout(() => groundSeed.classList.remove(c.groundOn, c.groundTaken), LIFT_DONE_MS);
  };
}
