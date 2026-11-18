import {RIG, TUNING} from './rig';

export type Picture = HTMLCanvasElement | HTMLImageElement;

const ctx2d = (w: number, h: number, read = false) => {
  const c = Object.assign(document.createElement('canvas'), {width: w, height: h});
  return c.getContext('2d', {willReadFrequently: read})!;
};

export const loadImage = (src: string): Promise<HTMLImageElement | null> =>
  new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });

/** A gamma that darkens the mid-tones and keeps the whites white, applied once per part. */
function grade(img: HTMLImageElement): HTMLCanvasElement {
  const g = ctx2d(img.naturalWidth, img.naturalHeight, true);
  g.drawImage(img, 0, 0);
  const lut = Uint8ClampedArray.from({length: 256}, (_, v) => 255 * (v / 255) ** TUNING.gamma);
  const im = g.getImageData(0, 0, g.canvas.width, g.canvas.height);
  const d = im.data;
  for (let p = 0; p < d.length; p += 4) { d[p] = lut[d[p]]; d[p + 1] = lut[d[p + 1]]; d[p + 2] = lut[d[p + 2]]; }
  g.putImageData(im, 0, 0);
  return g.canvas;
}

export type Mouthless = {img: HTMLCanvasElement; ink: string};

/** The face without its painted closed mouth, for under the open one: the line's pixels filled in from the skin around them, and the
 *  line's own ink so the shutting mouth lies on it in the same colour. */
function paintOutMouth(src: Picture): Mouthless {
  const [x0, y0, x1, y1] = RIG.mouthLine;
  const w = x1 - x0;
  const h = y1 - y0;
  const n = w * h;
  const m = ctx2d(w, h, true);
  m.drawImage(src, x0, y0, w, h, 0, 0, w, h);
  const img = m.getImageData(0, 0, w, h);
  const d = img.data;
  const sum = (i: number) => d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2];
  const sums = Array.from({length: n}, (_, i) => sum(i));
  const colours = sums.map((_, i) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
  const skin = [...sums].sort((a, b) => a - b)[n >> 1];   // the box is mostly skin
  const line = sums.map((s) => s < skin * 0.8);
  const hole = line.map((_, i) => {
    const x = i % w;
    const y = (i / w) | 0;
    if (x < 1 || y < 1 || x > w - 2 || y > h - 2) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (line[i + dy * w + dx]) return true;
    return false;
  });
  for (let pass = 0; pass < 160; pass++) for (let i = 0; i < n; i++) if (hole[i]) {
    for (let c = 0; c < 3; c++) d[i * 4 + c] = (d[(i - 1) * 4 + c] + d[(i + 1) * 4 + c] + d[(i - w) * 4 + c] + d[(i + w) * 4 + c]) / 4;
  }
  const core = colours.filter((_, i) => sums[i] < skin * 0.4);
  const ink = core.length ? `rgb(${[0, 1, 2].map((c) => Math.round(core.reduce((t, q) => t + q[c], 0) / core.length)).join()})` : RIG.mouthInk;
  m.putImageData(img, 0, 0);
  const out = ctx2d(w, h);
  out.drawImage(m.canvas, 0, 0);   // a plain canvas to draw from, not the one read back
  return {img: out.canvas, ink};
}

export type Art = {body: HTMLCanvasElement; arms: HTMLCanvasElement[]; mouthless: Mouthless};

/** The parts, graded; null if any is missing. */
export async function loadArt(): Promise<Art | null> {
  const [body, ...arms] = await Promise.all([RIG.body, ...RIG.arms.map((a) => a.src)].map(loadImage));
  if (!body || arms.some((a) => !a)) return null;
  const graded = grade(body);
  return {body: graded, arms: (arms as HTMLImageElement[]).map(grade), mouthless: paintOutMouth(graded)};
}

/**
 * The antennae in a breeze, from the art itself: each one's box above the head is redrawn row by row, shifted by a slow irregular
 * wave (three sines), nothing at its base and more toward the tip (as the square of the height, so it bends), the ball moving whole.
 * Rows are resampled between pixels, weighted by alpha, so the outline stays clean.
 */
export class AntennaSway {
  private readonly art: CanvasRenderingContext2D;
  private readonly boxes: {src: ImageData; out: ImageData}[];

  constructor(body: HTMLCanvasElement) {
    this.art = ctx2d(RIG.size, RIG.size, true);
    this.art.drawImage(body, 0, 0);
    this.boxes = RIG.antennae.map(({box: [x0, y0, x1, y1]}) => {
      const src = this.art.getImageData(x0, y0, x1 - x0, y1 - y0);
      return {src, out: new ImageData(src.width, src.height)};
    });
  }

  /** Each antenna tip's offset (art px) at `now`. */
  static tips(now: number): number[] {
    return RIG.antennae.map((a) => {
      const t = now / 1000 - a.lag;
      return a.sway * (0.62 * Math.sin(t * 1.53) + 0.28 * Math.sin(t * 2.37 + 1.7) + 0.1 * Math.sin(t * 3.9 + 0.4));
    });
  }

  /** The body with its antennae bent to `tips`. */
  bend(tips: number[]): HTMLCanvasElement {
    RIG.antennae.forEach((a, n) => {
      const [x0, y0, , y1] = a.box;
      const {src, out} = this.boxes[n];
      const w = src.width;
      const s = src.data;
      const o = out.data;
      for (let y = 0; y < src.height; y++) {
        const u = Math.min(1, (y1 - y0 - y) / (y1 - a.ball));
        const off = tips[n] * u * u;
        const fl = Math.floor(off);
        const fr = off - fl;
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          const i0 = x - fl;
          const i1 = i0 - 1;
          const q = row + x * 4;
          const a0 = i0 >= 0 && i0 < w ? s[row + i0 * 4 + 3] * (1 - fr) : 0;
          const a1 = i1 >= 0 && i1 < w ? s[row + i1 * 4 + 3] * fr : 0;
          const al = a0 + a1;
          if (al < 0.5) { o[q] = o[q + 1] = o[q + 2] = o[q + 3] = 0; continue; }
          for (let c = 0; c < 3; c++) o[q + c] = ((a0 && s[row + i0 * 4 + c] * a0) + (a1 && s[row + i1 * 4 + c] * a1)) / al;
          o[q + 3] = al;
        }
      }
      this.art.putImageData(out, x0, y0);
    });
    return this.art.canvas;
  }
}
