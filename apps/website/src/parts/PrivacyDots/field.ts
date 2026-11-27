/* What moves over the still mosaic: a few dots twinkling lime or near white, the dots round the cursor warming and slowly cooling, and
   a few ants (small lime dots) walking the grid a cell at a time, the cells they cross tinted behind them. A click calls the nearest
   ants: they head for it, mill about, then wander again. Ants keep clear of the band's title. */
import {DOT_RADIUS, STEP, type Box, type Layout} from './mosaic';

const ANT_RADIUS = 1.9;
const WARM_RADIUS = 110;
const TWINKLE_SHARE = 0.02;
const CALL_REACH = 720;
const CALLED_MAX = 6;
const ANT_INK = '#c8f53c';
const TWINKLE_WHITE = '#f4fbe2';
/** ~30fps is plenty for dots this small. */
const FRAME_MS = 32;
const DIRS: readonly [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export type {Box};
type Ant = {i: number; j: number; pi: number; pj: number; t: number; dur: number; dir: number; born: number; life: number;
  trail: [number, number][]; goal: [number, number] | null; until: number};

/** A seeded generator, so the twinkling dots are the same on every build of the field. */
function seeded(seed: number): () => number {
  let s = (seed * 48271 + 11) % 2147483647;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  next(); next();
  return next;
}

export class DotField {
  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private heat = new Float32Array(0);
  private threshold = new Float32Array(0);
  private twinkles: {i: number; period: number; phase: number; peak: number; white: boolean}[] = [];
  private ants: Ant[] = [];
  private cells = new Set<string>();
  private x0 = 0; private y0 = 0; private yShift = 0; private cols = 0; private rows = 0;
  private w = 0; private h = 0; private last = 0; private pitch = STEP;
  private pointer: {x: number; y: number} | null = null;
  private call: {x: number; y: number} | null = null;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  /** A new layout (size or theme); `quiet` are the boxes the ants avoid, in band coordinates; `step` is the grid the dots sit on. */
  reset(layout: Layout, width: number, height: number, quiet: Box[], step = STEP): void {
    const {xs, ys} = layout;
    this.w = width; this.h = height; this.quiet = quiet; this.pitch = step;
    const n = xs.length;
    const rand = seeded(17);
    this.x = Float32Array.from(xs); this.y = Float32Array.from(ys);
    this.heat = new Float32Array(n);
    this.threshold = Float32Array.from({length: n}, () => rand());
    this.twinkles = [];
    for (let i = 0; i < n; i++) if (rand() < TWINKLE_SHARE) {
      const period = 3 + rand() * 3;
      this.twinkles.push({i, period, phase: rand() * period, peak: 0.6 + rand() * 0.3, white: rand() < 0.2});
    }
    // the ants walk the mosaic's own grid; the bottom half, laid from the bottom, may sit off the top half's rows
    const mod = (v: number) => ((v % step) + step) % step;
    const top = ys.findIndex((v) => v < height / 2);
    const low = ys.findIndex((v) => v > height / 2);
    this.x0 = mod(xs[0] ?? 0);
    this.y0 = top >= 0 ? mod(ys[top]) : 0;
    this.yShift = low >= 0 ? mod(ys[low] - this.y0) : 0;
    if (this.yShift > step / 2) this.yShift -= step;
    this.cols = Math.floor((width - this.x0) / step) + 1;
    this.rows = Math.floor((height - this.y0) / step) + 1;
    this.cells = new Set(xs.map((x, k) => `${this.col(x)},${this.row(ys[k])}`));
    const count = Math.round(Math.min(10, Math.max(4, (width * height) / 160000)));
    const now = performance.now();
    this.ants = n ? Array.from({length: count}, () => this.spawn(now - Math.random() * 20000)) : [];
    this.ctx.clearRect(0, 0, width, height);
  }

  setPointer(p: {x: number; y: number} | null): void { this.pointer = p; }
  callAnts(p: {x: number; y: number}): void { this.call = p; }

  /** Draws one frame; returns without drawing when called sooner than the frame budget. */
  frame(now: number): void {
    if (!this.x.length || now - this.last < FRAME_MS) return;
    const dt = Math.min(2 * FRAME_MS, now - this.last);
    this.last = now;
    const lime = this.layers();
    const white = this.layers();
    const ink = this.layers();
    const dot = (layers: Path2D[], x: number, y: number, a: number, r = DOT_RADIUS) => {
      if (a < 0.05) return;
      const p = layers[Math.min(3, Math.floor(a * 4))];
      p.moveTo(x + r, y); p.arc(x, y, r, 0, Math.PI * 2);
    };
    const t = now / 1000;
    for (const tw of this.twinkles) {
      const ph = ((t + tw.phase) / tw.period) % 1;
      const a = ph < 0.24 ? ph / 0.24 : ph < 0.56 ? (0.56 - ph) / 0.32 : 0;
      dot(tw.white ? white : lime, this.x[tw.i], this.y[tw.i], tw.peak * a);
    }
    this.warm(lime, dot);
    this.answerCall(now);
    this.walk(now, dt, lime, ink, dot);
    const {ctx} = this;
    ctx.clearRect(0, 0, this.w, this.h);
    this.fill(lime, ANT_INK);
    this.fill(white, TWINKLE_WHITE);
    ctx.shadowColor = 'rgba(200, 245, 60, .55)';
    ctx.shadowBlur = 6;
    this.fill(ink, ANT_INK);
    ctx.shadowBlur = 0;
  }

  private quiet: Box[] = [];
  private layers(): Path2D[] { return [new Path2D(), new Path2D(), new Path2D(), new Path2D()]; }
  private fill(layers: Path2D[], color: string): void {
    this.ctx.fillStyle = color;
    layers.forEach((p, b) => { this.ctx.globalAlpha = (b + 1) / 4; this.ctx.fill(p); });
    this.ctx.globalAlpha = 1;
  }
  private col(x: number): number { return Math.round((x - this.x0) / this.pitch); }
  private row(y: number): number { return Math.round((y - (y > this.h / 2 ? this.y0 + this.yShift : this.y0)) / this.pitch); }
  private cx(i: number): number { return this.x0 + i * this.pitch; }
  private cy(j: number): number { const y = this.y0 + j * this.pitch; return y > this.h / 2 ? y + this.yShift : y; }

  private warm(lime: Path2D[], dot: (l: Path2D[], x: number, y: number, a: number) => void): void {
    const p = this.pointer;
    for (let i = 0; i < this.x.length; i++) {
      if (p) {
        const d = Math.hypot(this.x[i] - p.x, this.y[i] - p.y);
        const k = 1 - d / WARM_RADIUS;
        if (d < WARM_RADIUS && k ** 1.5 > this.threshold[i] * 0.9) this.heat[i] = Math.max(this.heat[i], 0.45 * k + 0.1);
      }
      if (this.heat[i] > 0.02) { dot(lime, this.x[i], this.y[i], this.heat[i]); this.heat[i] *= 0.9; } else this.heat[i] = 0;
    }
  }

  private answerCall(now: number): void {
    const c = this.call;
    if (!c) return;
    this.call = null;
    const goal: [number, number] = [this.col(c.x), this.row(c.y)];
    this.ants
      .map((a) => ({a, d: Math.hypot(this.cx(a.i) - c.x, this.cy(a.j) - c.y)}))
      .filter(({d}) => d < CALL_REACH)
      .sort((p, q) => p.d - q.d)
      .slice(0, CALLED_MAX)
      .forEach(({a}) => { a.goal = goal; a.until = now + 5000 + Math.random() * 1500; });
  }

  private walk(now: number, dt: number, lime: Path2D[], ink: Path2D[], dot: (l: Path2D[], x: number, y: number, a: number, r?: number) => void): void {
    this.ants = this.ants.map((a) => (now - a.born > a.life + 1000 ? this.spawn(now) : a));
    for (const a of this.ants) {
      a.t += dt / a.dur;
      if (a.t >= 1) this.step(a, now);
      const age = now - a.born;
      const fade = Math.min(1, age / 1000, (a.life + 1000 - age) / 1000);
      if (fade <= 0) continue;
      const e = a.t * a.t * (3 - 2 * a.t);
      const x = this.cx(a.pi) + (this.cx(a.i) - this.cx(a.pi)) * e;
      const y = this.cy(a.pj) + (this.cy(a.j) - this.cy(a.pj)) * e;
      a.trail.forEach(([i, j], k) => { if (this.cells.has(`${i},${j}`)) dot(lime, this.cx(i), this.cy(j), fade * (0.3 - k * 0.09)); });
      const alpha = fade * this.clearOfTitle(x, y);
      if (alpha >= 0.06) dot(ink, x, y, alpha, ANT_RADIUS);
    }
  }

  private clearOfTitle(x: number, y: number): number {
    let a = 1;
    for (const q of this.quiet) a = Math.min(a, Math.max(0, Math.max(q.l - x, x - q.r, q.t - y, y - q.b) / 28));
    return a;
  }

  private spawn(now: number): Ant {
    const k = Math.floor(Math.random() * this.x.length);
    const i = this.col(this.x[k]);
    const j = this.row(this.y[k]);
    return {i, j, pi: i, pj: j, t: 1, dur: 150, dir: Math.floor(Math.random() * 4), born: now,
      life: 18000 + Math.random() * 22000, trail: [], goal: null, until: 0};
  }

  /** Mostly straight on, sometimes a quarter turn; when called, mostly toward the call, milling about once there. */
  private step(a: Ant, now: number): void {
    a.trail.unshift([a.i, a.j]);
    if (a.trail.length > 3) a.trail.pop();
    a.pi = a.i; a.pj = a.j; a.t = 0;
    let d: number;
    if (a.goal && now < a.until) {
      const dx = a.goal[0] - a.i;
      const dy = a.goal[1] - a.j;
      const close = Math.abs(dx) + Math.abs(dy) <= 1;
      d = !close && Math.random() < 0.85 ? (Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3)) : Math.floor(Math.random() * 4);
      a.dur = close ? 160 + Math.random() * 80 : 70 + Math.random() * 30;
    } else {
      a.goal = null;
      d = Math.random() < 0.7 ? a.dir : (a.dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
      a.dur = 120 + Math.random() * 80;
    }
    let ni = a.i + DIRS[d][0];
    let nj = a.j + DIRS[d][1];
    if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) { d = (d + 2) % 4; ni = a.i + DIRS[d][0]; nj = a.j + DIRS[d][1]; }
    a.dir = d;
    a.i = Math.max(0, Math.min(this.cols - 1, ni));
    a.j = Math.max(0, Math.min(this.rows - 1, nj));
  }
}
