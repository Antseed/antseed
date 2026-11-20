/* Unseen ants on a grid over the card. When the seed is held over the card the ants within sensing distance of the end of the line
   walk to it and queue behind the seed along the path it has taken; every SERVE_MS the ant at the head takes a piece (the seed in
   hand gives a small pulse) and walks off. Only the pulse shows. */

const CELL = 15.5;          // grid pitch, CSS px
const DOT = 13;             // a cell's drawn size, for centring the grid
const TOP = 4;              // the grid starts where the painting does
const ANT_PER_CELLS = 70;
const MAX_QUEUE = 28;
const QUEUE_OFFSET = 1;     // cells between the seed and the first ant
const SERVE_MS = 650;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;

type Cell = [number, number];
type Ant = {i: number; j: number; t: number; dur: number; dir: number; sense: number; inLine: boolean};

const rand = (n: number) => Math.floor(Math.random() * n);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class AntLine {
  private cols = 1; private rows = 1; private ox = 0; private oy = 0;
  private ants: Ant[] = [];
  private path: Cell[] = [];       // path[0] is the seed's cell, then where it has been
  private queue: Ant[] = [];
  private lastServe = 0;

  layout(w: number, h: number): void {
    const cols = Math.max(1, Math.floor((w - DOT) / CELL) + 1);
    const rows = Math.max(1, Math.floor((h - TOP - DOT) / CELL) + 1);
    this.ox = (w - (cols - 1) * CELL - DOT) / 2; this.oy = TOP + (h - TOP - (rows - 1) * CELL - DOT) / 2;
    if (cols === this.cols && rows === this.rows && this.ants.length) return;
    this.cols = cols; this.rows = rows; this.release();
    this.ants = Array.from({length: Math.round(cols * rows / ANT_PER_CELLS)}, () => ({i: rand(cols), j: rand(rows), t: 1, dur: 120, dir: rand(4), sense: 10 + Math.random() * 26, inLine: false}));
  }

  /** The seed was let go (pointer left, or eaten): the line breaks up. */
  release(): void { for (const a of this.queue) a.inLine = false; this.queue.length = 0; this.path.length = 0; }

  private cellOf(x: number, y: number): Cell {
    return [clamp(Math.floor((x - this.ox) / CELL), 0, this.cols - 1), clamp(Math.floor((y - this.oy) / CELL), 0, this.rows - 1)];
  }
  private slot(k: number): Cell { return this.path[Math.min(k + QUEUE_OFFSET, this.path.length - 1)]; }

  // the seed's path in grid steps, so the line can follow it exactly
  private track(x: number, y: number) {
    const [ci, cj] = this.cellOf(x, y);
    if (!this.path.length) { this.path.push([ci, cj]); return; }
    let [i, j] = this.path[0];
    while (i !== ci || j !== cj) {
      if (Math.abs(ci - i) >= Math.abs(cj - j)) i += Math.sign(ci - i); else j += Math.sign(cj - j);
      this.path.unshift([i, j]);
    }
    this.path.length = Math.min(this.path.length, MAX_QUEUE + QUEUE_OFFSET + 7);
  }

  private step(a: Ant, holding: boolean) {
    let d = -1;
    if (a.inLine) { d = toward(a, this.slot(this.queue.indexOf(a))); a.dur = 55; }
    else {
      const tail = this.path.length ? this.slot(this.queue.length) : null;
      const far = tail ? Math.abs(tail[0] - a.i) + Math.abs(tail[1] - a.j) : Infinity;
      if (tail && holding && this.queue.length < MAX_QUEUE && far <= a.sense) {
        if (far <= 1) { a.inLine = true; this.queue.push(a); a.dur = 55; a.t = 0; return; }
        d = Math.random() < 0.8 ? toward(a, tail) : rand(4); a.dur = 65 + Math.random() * 30;
      } else {
        d = Math.random() < 0.7 ? a.dir : (a.dir + (Math.random() < 0.5 ? 1 : 3)) % 4; a.dur = 120 + Math.random() * 80;
      }
    }
    a.t = 0;
    if (d < 0) return;
    let ni = a.i + DIRS[d][0];
    let nj = a.j + DIRS[d][1];
    if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) { d = (d + 2) % 4; ni = a.i + DIRS[d][0]; nj = a.j + DIRS[d][1]; }
    a.dir = d; a.i = clamp(ni, 0, this.cols - 1); a.j = clamp(nj, 0, this.rows - 1);
  }

  /** Advances the ants by `dt` ms with the seed at (x, y) when `holding`. Returns true when the head of the line was just served. */
  update(now: number, dt: number, holding: boolean, x: number, y: number): boolean {
    if (holding) this.track(x, y);
    for (const a of this.ants) { a.t += dt / a.dur; if (a.t >= 1) this.step(a, holding); }
    const head = this.queue[0];
    if (!holding || !head || now - this.lastServe < SERVE_MS) return false;
    const [si, sj] = this.slot(0);
    if (head.i !== si || head.j !== sj) return false;
    this.lastServe = now;
    this.queue.shift(); head.inLine = false;
    return true;
  }
}

function toward(a: Ant, g: Cell): number {
  const dx = g[0] - a.i;
  const dy = g[1] - a.j;
  if (!dx && !dy) return -1;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
}
