import {LED_PITCH, cellHash} from '../ledGrid';

/** The painting read at one colour per grid cell, plus each cell's offset that makes the trail's edge ragged. */
export type PaintingCells = {cols: number; rows: number; ink: string[]; jitter: Float32Array};

const CONTRAST = 1.1;
const SATURATION = 1.2;
/** At night the dots are lifted toward white a little, so they read as lit on the dark paper. */
const NIGHT_LIFT = 0.12;
/** Downsampling in two steps (to 4 px a cell, then 1) keeps the average even. */
const SUPERSAMPLE = 4;
const NOISE_SCALE = 5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const u = smooth(x - ix);
  const v = smooth(y - iy);
  const h = (a: number, b: number) => cellHash(a, b, 9);
  return (h(ix, iy) * (1 - u) + h(ix + 1, iy) * u) * (1 - v) + (h(ix, iy + 1) * (1 - u) + h(ix + 1, iy + 1) * u) * v;
}

function grade(r: number, g: number, b: number, night: boolean): string {
  const c = [r, g, b].map((v) => clamp01((v / 255 - 0.5) * CONTRAST + 0.5));
  const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const out = c.map((v) => {
    const s = Math.round(clamp01(luma + (v - luma) * SATURATION) * 255);
    return night ? Math.round(s + (255 - s) * NIGHT_LIFT) : s;
  });
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

/** Where the panel's CSS lays its background: `cover` centred, or a `<n>% auto` width at a percentage position. */
function placement(el: HTMLElement, img: HTMLImageElement, W: number, H: number) {
  const cs = getComputedStyle(el);
  const wide = cs.backgroundSize.match(/^([\d.]+)% auto$/);
  const at = cs.backgroundPosition.match(/^([\d.]+)% ([\d.]+)%$/);
  const fx = at ? +at[1] / 100 : 0.5;
  const fy = at ? +at[2] / 100 : 0.5;
  if (wide) {
    const w = W * +wide[1] / 100;
    const h = w * img.naturalHeight / img.naturalWidth;
    return {x: (W - w) * fx, y: (H - h) * fy, w, h};
  }
  const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  return {x: (W - w) / 2, y: (H - h) / 2, w, h};
}

export function readPaintingCells(el: HTMLElement, img: HTMLImageElement, night: boolean): PaintingCells | null {
  const W = el.clientWidth;
  const H = el.clientHeight;
  const cols = Math.ceil(W / LED_PITCH);
  const rows = Math.ceil(H / LED_PITCH);
  const k = SUPERSAMPLE / LED_PITCH;
  const at = placement(el, img, W, H);
  const mid = Object.assign(document.createElement('canvas'), {width: cols * SUPERSAMPLE, height: rows * SUPERSAMPLE});
  const m = mid.getContext('2d');
  const one = Object.assign(document.createElement('canvas'), {width: cols, height: rows});
  const o = one.getContext('2d', {willReadFrequently: true});
  if (!m || !o) return null;
  m.imageSmoothingQuality = 'high';
  m.drawImage(img, at.x * k, at.y * k, at.w * k, at.h * k);
  o.imageSmoothingQuality = 'high';
  o.drawImage(mid, 0, 0, cols, rows);
  let data: Uint8ClampedArray;
  try { data = o.getImageData(0, 0, cols, rows).data; } catch { return null; }

  const ink: string[] = new Array(cols * rows);
  const jitter = new Float32Array(cols * rows);
  for (let y = 0, n = 0; y < rows; y++) for (let x = 0; x < cols; x++, n++) {
    ink[n] = grade(data[n * 4], data[n * 4 + 1], data[n * 4 + 2], night);
    jitter[n] = (cellHash(x, y, 3) - 0.5) * 0.22 + (valueNoise(x / NOISE_SCALE, y / NOISE_SCALE) - 0.5) * 0.3;
  }
  return {cols, rows, ink, jitter};
}
