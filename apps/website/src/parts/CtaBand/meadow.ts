/* The closing band's mosaic, from the Meadow hero (texture-lab/hero): a watercolour meadow with flat paper in the middle, sampled one
   colour per dot. Each dot's opacity rises with its ink (colour, or darkness against the paper), so the paper drops out and the leaves
   and daisies stay, quieted to a pale tinted field. The words keep a clear margin: no dot within `CLEAR` px of a line of text or the
   button, feathered out over `FEATHER`, inside a soft ellipse round the whole block. At night the dots are unlit grey, and the coloured
   ones light up softly, well below the button. */

/** The brand's small dots (the dotted rules and the paintings' LED grid are 8px), a little more open here: stretched a little per axis
 *  so the outer dots sit evenly, `INSET` in from the card's edge. */
export const PITCH = 11;
export const DOT = 6;
export const INSET = 4;

const SATURATION = 0.72;
const CONTRAST = 1.04;
/** Day: the dots' opacity at most, so the meadow reads as a tint, not a picture. */
const DAY_ALPHA = 0.55;
/** The clear margin round each line of text and the button, and its feather (px). */
const CLEAR = 14;
const FEATHER = 30;
/** Below `LOW` ink a dot is gone; from there its opacity rises to full at `HIGH`. */
const LOW = 0.07;
const HIGH = 0.24;
/** Below this opacity a dot is not drawn at rest. */
const SHOWN = 0.03;
/** Night: the unlit dot, and how much colour a dot needs to light up (from, to). */
const DARK_DOT: Rgb = [0x2b, 0x31, 0x2e];
const LIT_FROM = 0.07;
const LIT_TO = 0.2;
const LIT_SAT = 0.95;
const LIT_LIGHT = 0.52;
const LIT_MAX = 0.6;
/** Night: the lit share's opacity at most, and the unlit grey's. */
const LIT_ALPHA = 0.72;
const UNLIT_ALPHA = 0.8;

export type Rgb = [number, number, number];
/** The dots' grid: `x0`, `y0` the inset of the first cell. */
export type Grid = {cols: number; rows: number; px: number; py: number; x0: number; y0: number};
export type Rect = {l: number; t: number; r: number; b: number};
/** The glow behind the words: centre and radii in px, how much it clears (0 to 1) and how soft its edge is; and the words' own boxes
 *  (each line of text, the button), which clear fully with a margin. */
export type Glow = {x: number; y: number; rx: number; ry: number; strength: number; soft: number; rects?: Rect[]};
/** Per dot: its colour, its opacity at rest, its lit share at night (what glows), and the glow's veil (0 behind the words, 1 outside). */
export type Tiles = {rgb: Float32Array; alpha: Float32Array; lit: Float32Array; veil: Float32Array; on: Uint8Array};

export const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function fitGrid(width: number, height: number): Grid {
  const w = Math.max(1, width - 2 * INSET);
  const h = Math.max(1, height - 2 * INSET);
  const cols = Math.max(1, Math.round(w / PITCH));
  const rows = Math.max(1, Math.round(h / PITCH));
  return {cols, rows, px: w / cols, py: h / rows, x0: INSET, y0: INSET};
}

export const centreX = (g: Grid, i: number): number => g.x0 + (i + 0.5) * g.px;
export const centreY = (g: Grid, j: number): number => g.y0 + (j + 0.5) * g.py;

/** Distance from (x, y) to the nearest box, 0 inside one. */
export function nearest(rects: Rect[], x: number, y: number): number {
  let d = Infinity;
  for (const r of rects) d = Math.min(d, Math.hypot(Math.max(r.l - x, 0, x - r.r), Math.max(r.t - y, 0, y - r.b)));
  return d;
}

/** The whole dot is inside the card's rounded corners (a dot the corner would cut is left out, as on a display). */
export function insideCard(g: Grid, i: number, j: number, radius: number): boolean {
  const w = g.cols * g.px + 2 * g.x0;
  const h = g.rows * g.py + 2 * g.y0;
  const x = centreX(g, i);
  const y = centreY(g, j);
  if ((x >= radius && x <= w - radius) || (y >= radius && y <= h - radius)) return true;   // not in a corner
  const ax = Math.min(Math.max(x, radius), w - radius);
  const ay = Math.min(Math.max(y, radius), h - radius);
  return Math.hypot(x - ax, y - ay) + DOT / 2 <= radius + 0.5;
}

/** Night: a dot's lit colour from its own, its hue kept, the olives and greens pulled toward lime (78°), more saturated. */
function lit([r, g, b]: Rgb): Rgb {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = (mx - mn) / 255;
  const l = (mx + mn) / 510;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / 255 / d + 6) % 6;
    else if (mx === g) h = (b - r) / 255 / d + 2;
    else h = (r - g) / 255 / d + 4;
  }
  h *= 60;
  if (h > 38 && h < 170) h = 84 + (h - 84) * 0.5;
  const s = Math.min(0.75, (d ? d / (1 - Math.abs(2 * l - 1)) : 0) * LIT_SAT + 0.15);
  const L = Math.min(LIT_MAX, Math.max(0.36, LIT_LIGHT + (h < 55 ? -0.06 : 0.04) + (l - 0.55) * 0.4));   // the oranges deeper, the limes paler
  const c = (1 - Math.abs(2 * L - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const o = L - c / 2;
  let sector: Rgb;
  if (h < 60) sector = [c, x, 0];
  else if (h < 120) sector = [x, c, 0];
  else if (h < 180) sector = [0, c, x];
  else if (h < 240) sector = [0, x, c];
  else if (h < 300) sector = [x, 0, c];
  else sector = [c, 0, x];
  const [r1, g1, b1] = sector;
  return [(r1 + o) * 255, (g1 + o) * 255, (b1 + o) * 255];
}

/** Grades the watercolour, sampled one RGBA pixel per dot (`pixels`, cols × rows), into the dots. A dot is a colour laid over the
 *  card at an opacity, so the mosaic sits on the card's own background in both themes. */
export function grade(pixels: Uint8ClampedArray, g: Grid, glow: Glow | null, night: boolean, radius: number): Tiles {
  const n = g.cols * g.rows;
  const t: Tiles = {rgb: new Float32Array(n * 3), alpha: new Float32Array(n), lit: new Float32Array(n), veil: new Float32Array(n), on: new Uint8Array(n)};
  for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) {
    const q = j * g.cols + i;
    const p = q * 4;
    if (!insideCard(g, i, j, radius)) continue;
    t.on[q] = 1;
    const lum0 = (pixels[p] + pixels[p + 1] + pixels[p + 2]) / 3;
    const rgb = [pixels[p], pixels[p + 1], pixels[p + 2]].map((v) => Math.max(0, Math.min(255, 128 + (lum0 + (v - lum0) * SATURATION - 128) * CONTRAST))) as Rgb;
    const lum = (rgb[0] + rgb[1] + rgb[2]) / 3;
    const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255;
    const ink = Math.max(chroma, ((236 - lum) / 255) * 1.4);
    const e = glow ? Math.hypot((centreX(g, i) - glow.x) / glow.rx, (centreY(g, j) - glow.y) / glow.ry) : Infinity;
    const x = centreX(g, i);
    const y = centreY(g, j);
    const ring = glow ? 1 - glow.strength * (1 - smooth(1 - glow.soft, 1 + glow.soft, e)) : 1;
    const near = glow?.rects?.length ? smooth(CLEAR, CLEAR + FEATHER, nearest(glow.rects, x, y) - DOT / 2) : 1;
    const veil = Math.min(ring, near);
    t.veil[q] = veil;
    const a = smooth(LOW, HIGH, ink) * veil;
    if (a * (night ? 1 : DAY_ALPHA) <= SHOWN) continue;
    let colour = rgb;
    let alpha = a * DAY_ALPHA;
    if (night) {
      // the unlit grey and the lit colour, each as far as the dot's colour goes (the pale unlit ones a little stronger)
      const share = smooth(LIT_FROM, LIT_TO, chroma);
      const unlit = (1 - share) * a ** 0.6 * UNLIT_ALPHA;
      const on = share * a * LIT_ALPHA;
      const L = lit(rgb);
      alpha = Math.min(1, unlit + on);
      colour = [0, 1, 2].map((c) => (DARK_DOT[c] * unlit + L[c] * on) / (unlit + on)) as Rgb;
      t.lit[q] = on;
    }
    t.rgb.set(colour, q * 3);
    t.alpha[q] = alpha;
  }
  return t;
}
