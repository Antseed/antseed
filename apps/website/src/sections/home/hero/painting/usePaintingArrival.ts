import {useEffect, useState, type RefObject} from 'react';
import {isStill} from '../../../../lib/motion';
import {LED_DOT, LED_PITCH, canvasDpr, cellHash} from '../../../../lib/ledGrid';

/* The hero painting's arrival at load: the text is there from the first frame while the painting waits under a cover in the hero's
   colour; then it grows from the centre in an oval whose edge breaks into round LED dots on an 8px grid, cell by cell just inside the
   edge, while the painting fades up and settles from a touch larger (the [data-arriving] styles). */

const BAND = 0.34;        // fringe width, in oval units (1 reaches the corners)
const SOLID = 0.22;       // inner share of the fringe that fills cell by cell
const START_DELAY = 100;
const DURATION = 1500;
const FADE = 0.55;        // share of the arrival over which the inside fades up from the hero's colour
const DECODE_WAIT = 500;  // never hold the arrival longer than this for the painting to decode
/** The CSS cover lifts on its own after 4s (Painting.module.css): later than this, the painting is simply shown. */
const LATE = 3500;

const ease = (t: number) => 1 - (1 - t) ** 3;

type Cell = {x: number; y: number; d: number; a: number; b: number};

function cellsOf(W: number, H: number, p: number): Cell[] {
  const cells: Cell[] = [];
  for (let j = 0, rows = Math.ceil(H / p), cols = Math.ceil(W / p); j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = (i + 0.5) * p;
    const cy = (j + 0.5) * p;
    cells.push({x: i * p, y: j * p, d: Math.hypot((cx - W / 2) / (W / 2), (cy - H / 2) / (H / 2)) / Math.SQRT2, a: cellHash(i, j, 1), b: cellHash(i, j, 2)});
  }
  return cells;
}

/** Draws the cover at oval size `f` and time share `t`: the fill with the oval and its fringe of dots and cells cut out. */
function drawCover(g: CanvasRenderingContext2D, cells: Cell[], fill: string, p: number, f: number, t: number) {
  const {width: W, height: H} = g.canvas;
  const r = LED_DOT * p;
  g.globalCompositeOperation = 'source-over'; g.fillStyle = fill; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.beginPath();
  const inner = f - BAND;
  if (inner > 0) g.ellipse(W / 2, H / 2, inner * W / Math.SQRT2, inner * H / Math.SQRT2, 0, 0, Math.PI * 2);
  for (const c of cells) {
    const e = (f - c.d) / BAND;
    if (e <= 0 || e >= 1.05) continue;
    if (e > 1 - SOLID && c.a < (e - 1 + SOLID) / SOLID) { g.rect(c.x, c.y, p, p); continue; }
    if (e < 1 && c.b <= e ** 1.6) { g.moveTo(c.x + p / 2 + r, c.y + p / 2); g.arc(c.x + p / 2, c.y + p / 2, r, 0, Math.PI * 2); }
  }
  g.fill();
  const veil = 1 - Math.min(1, t / FADE);
  if (veil > 0 && f > 0) {
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 0.85 * veil * veil; g.fillStyle = fill; g.beginPath();
    g.ellipse(W / 2, H / 2, f * W / Math.SQRT2, f * H / Math.SQRT2, 0, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
  }
}

const decoded = (src: string) => { const img = new Image(); img.src = src; return img.decode().catch(() => undefined); };

/** Plays the arrival once on mount. Returns whether the static cover (rendered on the server) is still needed. */
export function usePaintingArrival(paintRef: RefObject<HTMLElement | null>, coverClass: string, picture: () => string): boolean {
  const [covered, setCovered] = useState(true);
  useEffect(() => {
    const paint = paintRef.current;
    const hero = paint?.parentElement;
    if (!paint || !hero || isStill() || performance.now() > LATE) { setCovered(false); return; }
    const dpr = canvasDpr();
    const p = LED_PITCH * dpr;
    const canvas = Object.assign(document.createElement('canvas'), {width: Math.round(paint.offsetWidth * dpr), height: Math.round(paint.offsetHeight * dpr)});
    const g = canvas.getContext('2d');
    if (!g || !canvas.width || !canvas.height) { setCovered(false); return; }
    canvas.className = coverClass;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.arrivalCover = '';
    const fill = getComputedStyle(hero).backgroundColor;
    const cells = cellsOf(canvas.width, canvas.height, p);
    drawCover(g, cells, fill, p, 0, 0);
    paint.append(canvas);
    setCovered(false);

    let raf = 0;
    let timer = 0;
    let dead = false;
    const finish = () => { canvas.remove(); delete paint.dataset.arriving; };
    Promise.race([decoded(picture()), new Promise((ok) => setTimeout(ok, DECODE_WAIT))]).then(() => {
      if (dead) return;
      timer = window.setTimeout(() => {
        const t0 = performance.now();
        paint.style.setProperty('--arrive', `${DURATION}ms`);
        paint.dataset.arriving = '';
        const frame = (now: number) => {
          const t = Math.min(1, (now - t0) / DURATION);
          drawCover(g, cells, fill, p, ease(t) * (1 + BAND + 0.02), t);
          if (t < 1) raf = requestAnimationFrame(frame); else finish();
        };
        raf = requestAnimationFrame(frame);
      }, START_DELAY);
    });
    return () => { dead = true; cancelAnimationFrame(raf); clearTimeout(timer); finish(); };
  }, [paintRef, coverClass, picture]);
  return covered;
}
