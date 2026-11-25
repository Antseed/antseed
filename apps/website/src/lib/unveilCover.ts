import {LED_DOT, LED_PITCH, canvasDpr, cellHash} from './ledGrid';
import {onThemeChange} from './theme';

/** Width of the dotted fringe, in units of the oval (1 reaches the panel's corners). */
const FRINGE = 0.34;
/** Inner share of the fringe where the painting comes back cell by cell instead of as dots. */
const SOLID = 0.22;
const DURATION_MS = 1500;
/** Where the oval ends, a little past the corners so the last fringe cells clear. */
const END = 1 + FRINGE + 0.02;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

type Cell = {x: number; y: number; dist: number; solidAt: number; dotAt: number};

/**
 * A canvas in the panel's own colour laid over its painting, with holes cut where the painting shows: an oval growing from the centre
 * whose edge breaks into dots. Resolves when the painting is whole (the canvas removed) or when `cancelled()` turns true.
 */
export function playCover(el: HTMLElement, cancelled: () => boolean): Promise<void> {
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h) return Promise.resolve();
  const dpr = canvasDpr();
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  const pitch = LED_PITCH * dpr;
  const r = LED_DOT * pitch;
  const canvas = Object.assign(document.createElement('canvas'), {width: W, height: H});
  canvas.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('data-unveil-cover', '');
  const g = canvas.getContext('2d');
  if (!g) return Promise.resolve();

  const cells: Cell[] = [];
  const cols = Math.ceil(W / pitch);
  const rows = Math.ceil(H / pitch);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = (i + 0.5) * pitch;
    const cy = (j + 0.5) * pitch;
    const dist = Math.hypot((cx - W / 2) / (W / 2), (cy - H / 2) / (H / 2)) / Math.SQRT2;
    cells.push({x: i * pitch, y: j * pitch, dist, solidAt: cellHash(i, j, 1), dotAt: cellHash(i, j, 2)});
  }

  let fill = getComputedStyle(el).backgroundColor;
  const draw = (front: number) => {
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = fill;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    g.beginPath();
    const inner = front - FRINGE;
    if (inner > 0) g.ellipse(W / 2, H / 2, inner * W / Math.SQRT2, inner * H / Math.SQRT2, 0, 0, Math.PI * 2);
    for (const c of cells) {
      const e = (front - c.dist) / FRINGE;
      if (e <= 0 || e >= 1.05) continue;
      if (e > 1 - SOLID && c.solidAt < (e - 1 + SOLID) / SOLID) {
        g.rect(c.x, c.y, pitch, pitch);
      } else if (e < 1 && c.dotAt <= Math.pow(e, 1.6)) {
        g.moveTo(c.x + pitch / 2 + r, c.y + pitch / 2);
        g.arc(c.x + pitch / 2, c.y + pitch / 2, r, 0, Math.PI * 2);
      }
    }
    g.fill();
  };

  draw(0);
  el.prepend(canvas);
  // the panel's colour changes with the theme; the cover must follow or it shows as a block
  const stopWatching = onThemeChange(() => { fill = getComputedStyle(el).backgroundColor; });
  const t0 = performance.now();
  return new Promise<void>((done) => {
    const finish = () => { stopWatching(); canvas.remove(); done(); };
    const frame = (now: number) => {
      if (cancelled()) return finish();
      const t = Math.min(1, Math.max(0, now - t0) / DURATION_MS);
      draw(easeOutCubic(t) * END);
      if (t < 1) requestAnimationFrame(frame); else finish();
    };
    requestAnimationFrame(frame);
  });
}
