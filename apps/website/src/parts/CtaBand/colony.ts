/* What moves over the meadow mosaic, from the Meadow hero: ants (a darker dot filling its cell) walking the grid a cell at a time,
   tinting the two or three dots behind them for a moment. A mouse over the card: the nearby ants line up in single file behind it and follow the path
   it took. A click or a tap on the card: a soft wave of brighter dots goes out once from there and every ant comes to it, mills about, then
   wanders again. With no mouse (a touch screen), now and then one ant leads a few others in a short file of their own. The ants fade
   out in the glow behind the words. */
import {DOT, centreX, centreY, smooth, type Grid, type Rgb} from './meadow.ts';

/** The ant fills its dot: at the brand's small size a dot inside a dot would not read. */
const ANT = DOT;
/** One ant per this many cells. */
const ANT_PER = 170;
const MAX_QUEUE = 40;
/** A touch screen's short files: how many follow the leader, how long a file lasts, and the pause between two (ms). */
const FILE_MIN = 3;
const FILE_MAX = 5;
const FILE_TIME = [5000, 7500] as const;
const FILE_PAUSE = [2500, 6000] as const;
/** How long called ants stay round the call (ms). */
const CALLED_TIME = [4000, 5500] as const;
const TRAIL = 0.45;
/** Seconds for a trail to fade by half: about two or three cells behind a walking ant. */
const TRAIL_HALF = 0.22;
/** The wave after a click: cells a second, how long it lives (ms), its half-width (cells) and its strongest opacity. On a small card
 *  (a phone) it runs slower, so it is seen crossing the card. */
const RING_SPEED = 46;
const RING_MIN_SPEED = 22;
const RING_CROSSING = 1.4;
const RING_LIFE = 1800;
const RING_WIDTH = 2.6;
const RING_ALPHA = 0.6;
/** 60 frames a second within this long of the last input, 30 at rest. */
const BUSY_MS = 2000;
const DIRS: readonly [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export type Look = {ant: string; trail: Rgb; ring: Rgb};
export const DAY: Look = {ant: '#5d6e2c', trail: [0x5d, 0x6e, 0x2c], ring: [0x74, 0x88, 0x36]};
export const NIGHT: Look = {ant: '#93b862', trail: [0x84, 0xa8, 0x58], ring: [0xa3, 0xc2, 0x6e]};

type State = 'wander' | 'line' | 'lead' | 'called';
export type Ant = {i: number; j: number; pi: number; pj: number; t: number; dur: number; dir: number; sense: number; state: State;
  goal: [number, number] | null; until: number};
type Ring = {i: number; j: number; start: number};

const between = ([a, b]: readonly [number, number]) => a + Math.random() * (b - a);
const rand = (n: number) => Math.floor(Math.random() * n);

export class Colony {
  ants: Ant[] = [];
  /** Grid cells, path[0] the head (the pointer's cell or the leader's), then where it has been. */
  path: [number, number][] = [];
  queue: Ant[] = [];
  /** A touch screen: short files of their own, as there is no pointer to follow. */
  auto = false;
  private g: Grid = {cols: 0, rows: 0, px: 1, py: 1, x0: 0, y0: 0};
  private veil: Float32Array = new Float32Array(0);
  private on: Uint8Array = new Uint8Array(0);
  private trail: Float32Array = new Float32Array(0);
  private rings: Ring[] = [];
  private pointer: {x: number; y: number; sx: number; sy: number} | null = null;
  private leader: Ant | null = null;
  private fileSize = 0;
  private fileUntil = 0;
  private nextFile = 0;
  private last = 0;
  private lastInput = -Infinity;
  
  /** A new grid starts the ants afresh; the same grid (a new glow or theme) keeps them walking. */
  reset(g: Grid, veil: Float32Array, on: Uint8Array): void {
    const same = g.cols === this.g.cols && g.rows === this.g.rows;
    this.g = g; this.veil = veil; this.on = on;
    if (same && this.ants.length) return;
    this.trail = new Float32Array(g.cols * g.rows);
    this.path = []; this.queue = []; this.rings = []; this.leader = null;
    const cells: number[] = [];
    on.forEach((v, q) => { if (v) cells.push(q); });
    const n = cells.length ? Math.max(1, Math.round((g.cols * g.rows) / ANT_PER)) : 0;
    this.ants = Array.from({length: n}, () => {
      const q = cells[rand(cells.length)];
      const i = q % g.cols;
      const j = Math.floor(q / g.cols);
      return {i, j, pi: i, pj: j, t: 1, dur: 120, dir: rand(4), sense: 10 + Math.random() * 26, state: 'wander', goal: null, until: 0};
    });
  }

  /** The mouse over the card, in card px; null when it leaves. */
  setPointer(p: {x: number; y: number} | null, now: number): void {
    if (!p) { this.pointer = null; this.release(); return; }
    this.lastInput = now;
    if (!this.pointer) { this.endFile(now); this.path = []; this.pointer = {...p, sx: p.x, sy: p.y}; }
    else Object.assign(this.pointer, p);
  }

  /** A click or tap at (x, y): the ring goes out from there, and every ant comes to the nearest cell they show on. */
  call(x: number, y: number, now: number): void {
    this.lastInput = now;
    const [i, j] = this.cellOf(x, y);
    this.rings.push({i, j, start: now});
    const goal = this.visibleNear(i, j);
    this.endFile(now);
    this.queue = [];
    for (const a of this.ants) { a.state = 'called'; a.goal = goal; a.until = now + between(CALLED_TIME); }
  }

  /** Steps the ants on; returns false when called sooner than the frame budget. */
  tick(now: number): boolean {
    if (!this.ants.length) return false;
    const budget = now - this.lastInput < BUSY_MS ? 1000 / 60 : 1000 / 30;
    if (now - this.last < budget - 2) return false;
    const dt = Math.min(64, now - this.last);
    this.last = now;
    const p = this.pointer;
    if (p) {
      p.sx += (p.x - p.sx) * 0.3; p.sy += (p.y - p.sy) * 0.3;
      this.track(this.cellOf(p.sx, p.sy));
    } else if (this.auto) this.files(now);
    for (const a of this.ants) { a.t += dt / a.dur; if (a.t >= 1) this.step(a, now); }
    const decay = 0.5 ** (dt / (TRAIL_HALF * 1000));
    for (let k = 0; k < this.trail.length; k++) this.trail[k] *= decay;
    this.rings = this.rings.filter((r) => now - r.start < RING_LIFE);
    return true;
  }

  /** The moving layer over the mosaic at rest: the trails, the ring, the ants. */
  draw(ctx: CanvasRenderingContext2D, now: number, look: Look): void {
    const {g} = this;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore();
    const paint = (q: number, [r, gr, b]: Rgb, a: number) => {
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = `rgb(${r},${gr},${b})`;
      ctx.beginPath(); ctx.arc(centreX(g, q % g.cols), centreY(g, Math.floor(q / g.cols)), DOT / 2, 0, Math.PI * 2); ctx.fill();
    };
    for (let q = 0; q < this.trail.length; q++) {
      if (!this.on[q]) continue;
      const tr = this.trail[q] * TRAIL * this.veil[q];
      if (tr > 0.03) paint(q, look.trail, tr);
    }
    for (const r of this.rings) {
      const age = now - r.start;
      const speed = Math.max(RING_MIN_SPEED, Math.min(RING_SPEED, Math.hypot(g.cols, g.rows) / RING_CROSSING));
      const radius = (age / 1000) * speed;
      const life = age / RING_LIFE;
      const fade = RING_ALPHA * Math.sin((Math.PI / 2) * Math.min(1, life * 5)) * (1 - life) ** 1.5;   // eases in, then out: no flash
      for (let q = 0; q < this.on.length; q++) {
        if (!this.on[q]) continue;
        const i = q % g.cols;
        const j = Math.floor(q / g.cols);
        const band = (Math.hypot(i - r.i, j - r.j) - radius) / RING_WIDTH;
        if (Math.abs(band) < 2) paint(q, look.ring, fade * Math.exp(-band * band) * this.clear(i, j));   // none behind the words
      }
    }
    ctx.fillStyle = look.ant;
    for (const a of this.ants) {
      const e = a.t < 1 ? a.t * a.t * (3 - 2 * a.t) : 1;
      const from = this.clear(a.pi, a.pj);
      const alpha = from + (this.clear(a.i, a.j) - from) * e;
      if (alpha < 0.02) continue;
      ctx.globalAlpha = alpha;
      const x = centreX(g, a.pi + (a.i - a.pi) * e);
      const y = centreY(g, a.pj + (a.j - a.pj) * e);
      ctx.beginPath(); ctx.arc(x, y, ANT / 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** 0 in the glow behind the words, 1 outside it. */
  private clear(i: number, j: number): number { return smooth(0.2, 0.85, this.veil[j * this.g.cols + i] ?? 1); }

  private cellOf(x: number, y: number): [number, number] {
    const {g} = this;
    return [Math.max(0, Math.min(g.cols - 1, Math.floor((x - g.x0) / g.px))), Math.max(0, Math.min(g.rows - 1, Math.floor((y - g.y0) / g.py)))];
  }

  /** The cell nearest (i, j) where an ant shows (clear of the words), so a call near the words gathers the ants beside them. */
  private visibleNear(i: number, j: number): [number, number] {
    if (this.on[j * this.g.cols + i] && this.clear(i, j) >= 0.6) return [i, j];
    let best: [number, number] = [i, j];
    let bestD = Infinity;
    for (let q = 0; q < this.on.length; q++) {
      const ci = q % this.g.cols;
      const cj = Math.floor(q / this.g.cols);
      if (!this.on[q] || this.clear(ci, cj) < 0.6) continue;
      const d = Math.hypot(ci - i, cj - j);
      if (d < bestD) { bestD = d; best = [ci, cj]; }
    }
    return best;
  }

  /** Walks the path from its head to the new cell in grid steps, so the line can follow it exactly. */
  private track([ci, cj]: [number, number]): void {
    if (!this.path.length) { this.path.push([ci, cj]); return; }
    let [i, j] = this.path[0];
    while (i !== ci || j !== cj) {
      if (Math.abs(ci - i) >= Math.abs(cj - j)) i += Math.sign(ci - i); else j += Math.sign(cj - j);
      this.path.unshift([i, j]);
    }
    this.path.length = Math.min(this.path.length, MAX_QUEUE + 8);
  }

  private slot(k: number): [number, number] { return this.path[Math.min(k + 1, this.path.length - 1)]; }

  private release(): void {
    for (const a of this.queue) a.state = 'wander';
    this.queue = []; this.path = [];
  }

  /** A touch screen: a file starts now and then, led by a wandering ant clear of the words, and breaks up after a few seconds. */
  private files(now: number): void {
    if (this.leader && now > this.fileUntil) this.endFile(now);
    if (this.leader || now < this.nextFile) return;
    const free = this.ants.filter((a) => a.state === 'wander' && this.clear(a.i, a.j) > 0.6);
    if (!free.length) { this.nextFile = now + 1000; return; }
    const lead = free[rand(free.length)];
    lead.state = 'lead';
    this.leader = lead;
    this.path = [[lead.i, lead.j]];
    this.fileSize = FILE_MIN + rand(FILE_MAX - FILE_MIN + 1);
    this.fileUntil = now + between(FILE_TIME);
  }

  private endFile(now: number): void {
    if (!this.leader) return;
    this.leader.state = 'wander';
    this.leader = null;
    this.release();
    this.nextFile = now + between(FILE_PAUSE);
  }

  private toward(a: Ant, [gi, gj]: [number, number]): number {
    const dx = gi - a.i;
    const dy = gj - a.j;
    if (!dx && !dy) return -1;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
  }

  private open(i: number, j: number): boolean { return i >= 0 && j >= 0 && i < this.g.cols && j < this.g.rows && !!this.on[j * this.g.cols + i]; }

  private step(a: Ant, now: number): void {
    const k = a.j * this.g.cols + a.i;
    this.trail[k] = Math.min(1, this.trail[k] + (a.state === 'line' ? 0.25 : 0.5));
    a.pi = a.i; a.pj = a.j; a.t = 0;
    let d = -1;
    if (a.state === 'line') {
      d = this.toward(a, this.slot(this.queue.indexOf(a)));
      a.dur = 55;
    } else if (a.state === 'lead') {
      // mostly straight on, turning away from the words and the edges
      const ahead = Math.random() < 0.75 ? a.dir : (a.dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
      d = [0, 1, 3, 2].map((turn) => (ahead + turn) % 4)
        .find((c) => this.open(a.i + DIRS[c][0], a.j + DIRS[c][1]) && this.clear(a.i + DIRS[c][0], a.j + DIRS[c][1]) > 0.5) ?? ahead;
      a.dur = 170 + Math.random() * 60;
    } else if (a.state === 'called' && a.goal && now < a.until) {
      const far = Math.abs(a.goal[0] - a.i) + Math.abs(a.goal[1] - a.j) > 1;
      d = far && Math.random() < 0.85 ? this.toward(a, a.goal) : rand(4);
      a.dur = far ? 70 + Math.random() * 30 : 160 + Math.random() * 80;
    } else {
      if (a.state === 'called') { a.state = 'wander'; a.goal = null; }
      // wander, or head for the end of the line when it is near
      const room = this.pointer ? MAX_QUEUE : this.leader ? this.fileSize : 0;
      const tail = this.path.length && this.queue.length < room ? this.slot(this.queue.length) : null;
      const dist = tail ? Math.abs(tail[0] - a.i) + Math.abs(tail[1] - a.j) : Infinity;
      if (tail && dist <= a.sense) {
        if (dist <= 1) { a.state = 'line'; this.queue.push(a); a.dur = 55; return; }
        d = Math.random() < 0.8 ? this.toward(a, tail) : rand(4);
        a.dur = 65 + Math.random() * 30;
      } else {
        d = Math.random() < 0.7 ? a.dir : (a.dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
        a.dur = 120 + Math.random() * 80;
      }
    }
    if (d < 0) return;
    let ni = a.i + DIRS[d][0];
    let nj = a.j + DIRS[d][1];
    if (!this.open(ni, nj)) { d = (d + 2) % 4; ni = a.i + DIRS[d][0]; nj = a.j + DIRS[d][1]; }
    if (!this.open(ni, nj)) return;
    a.dir = d; a.i = ni; a.j = nj;
    if (a === this.leader) this.track([ni, nj]);
  }
}
