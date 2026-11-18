import {LED_DOT, LED_PITCH} from '../ledGrid';
import type {PaintingCells} from './paintingCells';

/** The cursor's reach, CSS px. */
const RADIUS = 88;
/** Levels (heat plus the cell's jitter) at which a cell becomes a flat square, a dot on paper, fully papered, then bare paper. */
const SQUARE = 0.46;
const ROUND = 0.5;
const PAPERED = 0.8;
const GONE = 1.06;
const PAPER_STEPS = 4;
/** Heat below this is dropped, so a trail ends rather than fading forever. */
const FLOOR = 0.02;
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Cell bounds [x0, y0, x1, y1] of everything still warm; only that box is redrawn each frame. */
type Box = [number, number, number, number];

/**
 * The trail's heat per cell and its drawing. Heat is laid along the pointer's path and multiplied down each frame; each cell is drawn
 * by its level as the painting (nothing), a flat square in its colour, a dot on the paper, or the paper alone.
 */
export class TrailField {
  private heat: Float32Array;
  private box: Box | null = null;
  private last: [number, number] | null = null;
  private dots: HTMLCanvasElement;
  private dotsCtx: CanvasRenderingContext2D;

  constructor(private cells: PaintingCells, private ctx: CanvasRenderingContext2D, private dpr: number, private paper: string) {
    this.heat = new Float32Array(cells.cols * cells.rows);
    // dots go on their own layer first, then over the paper in one copy
    this.dots = Object.assign(document.createElement('canvas'), {width: ctx.canvas.width, height: ctx.canvas.height});
    this.dotsCtx = this.dots.getContext('2d')!;
  }

  /** Lays heat from the previous pointer position to this one (CSS px in the panel), a soft disc every half cell. */
  lay(x: number, y: number): void {
    const {cols, rows} = this.cells;
    const R = RADIUS / LED_PITCH;
    const gx = x / LED_PITCH;
    const gy = y / LED_PITCH;
    const [fx, fy] = this.last ?? [gx, gy];
    this.last = [gx, gy];
    const steps = Math.max(1, Math.ceil(Math.hypot(gx - fx, gy - fy) * 2));
    for (let i = 1; i <= steps; i++) {
      const sx = fx + (gx - fx) * i / steps;
      const sy = fy + (gy - fy) * i / steps;
      const x0 = Math.max(0, Math.floor(sx - R));
      const x1 = Math.min(cols - 1, Math.ceil(sx + R));
      const y0 = Math.max(0, Math.floor(sy - R));
      const y1 = Math.min(rows - 1, Math.ceil(sy + R));
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const d = Math.hypot(cx + 0.5 - sx, cy + 0.5 - sy) / R;
        if (d >= 1) continue;
        const n = cy * cols + cx;
        const v = smooth(1 - d);
        if (v > this.heat[n]) this.heat[n] = v;
      }
      const b = this.box;
      this.box = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
    }
  }

  /** The pointer left: the next lay starts a new stroke instead of joining the old one. */
  lift(): void { this.last = null; }

  /** Fades by `fade` and draws; returns whether anything is still warm. */
  step(fade: number): boolean {
    if (!this.box) return false;
    const {ctx, dotsCtx, heat} = this;
    const {cols, ink, jitter} = this.cells;
    const p = LED_PITCH * this.dpr;
    const r = LED_DOT * p;
    const [x0, y0, x1, y1] = this.box;
    const bx = x0 * p;
    const by = y0 * p;
    const bw = (x1 - x0 + 1) * p;
    const bh = (y1 - y0 + 1) * p;
    ctx.clearRect(bx, by, bw, bh);
    dotsCtx.clearRect(bx, by, bw, bh);
    const paper = Array.from({length: PAPER_STEPS}, () => new Path2D());
    const squares: number[] = [];
    const dots: number[] = [];
    let next: Box | null = null;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const n = y * cols + x;
      if (heat[n] <= 0) continue;
      let h = heat[n] * fade;
      if (h < FLOOR) h = 0;
      heat[n] = h;
      if (!h) continue;
      next = next ? [Math.min(next[0], x), Math.min(next[1], y), Math.max(next[2], x), Math.max(next[3], y)] : [x, y, x, y];
      const level = h + jitter[n] * Math.min(1, h * 3);
      if (level < SQUARE) continue;
      if (level < ROUND) { squares.push(n); continue; }
      // the paper comes up in steps round the dots, so the trail's edge scatters
      paper[Math.min(PAPER_STEPS - 1, Math.floor(PAPER_STEPS * (level - ROUND) / (PAPERED - ROUND)))].rect(x * p, y * p, p, p);
      if (level < GONE) dots.push(n);
    }
    this.box = next;
    ctx.fillStyle = this.paper;
    paper.forEach((path, i) => { ctx.globalAlpha = (i + 1) / PAPER_STEPS; ctx.fill(path); });
    ctx.globalAlpha = 1;
    for (const n of squares) { ctx.fillStyle = ink[n]; ctx.fillRect((n % cols) * p, Math.floor(n / cols) * p, p, p); }
    for (const n of dots) {
      dotsCtx.fillStyle = ink[n];
      dotsCtx.beginPath();
      dotsCtx.arc((n % cols + 0.5) * p, (Math.floor(n / cols) + 0.5) * p, r, 0, Math.PI * 2);
      dotsCtx.fill();
    }
    ctx.drawImage(this.dots, bx, by, bw, bh, bx, by, bw, bh);
    return next !== null;
  }

  clear(): void {
    this.heat.fill(0);
    this.box = null;
    this.last = null;
    this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    this.dotsCtx.clearRect(0, 0, this.dots.width, this.dots.height);
  }
}
